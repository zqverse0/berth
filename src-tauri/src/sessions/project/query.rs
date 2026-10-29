use crate::app_error::AppCommandError;
use crate::db::service::{agent_setting_service, conversation_service};
use berth_project_core::service::folder_service;
use crate::models::{ProjectAgentSessionPage, ProjectAgentSessionPageRequest};
use crate::sessions::scan_diagnostics;
use crate::sessions::NativeConversationPageRequest;

use super::{
    build_agent_parser, clamp_project_agent_session_page_limit, discovery,
    reconcile_project_agent_session_page, ProjectAgentSessionCursor,
};

const PROJECT_AGENT_NATIVE_SCAN_BUDGET: usize = 200;

pub(crate) async fn list_project_agent_sessions_core(
    conn: &sea_orm::DatabaseConnection,
    request: ProjectAgentSessionPageRequest,
) -> Result<ProjectAgentSessionPage, AppCommandError> {
    // agent 标识来自请求与 Tool Asset；未知值或未声明历史能力的 Agent
    // 安静降级为空页（不报错、不阻塞浏览）。
    let Some(agent_type) = crate::models::agent::parse_known_agent_type(&request.agent_type) else {
        return Ok(ProjectAgentSessionPage {
            items: Vec::new(),
            next_cursor: None,
            scan_complete: true,
            source_warning: None,
        });
    };
    if !crate::sessions::declarative::DeclarativeSessionParser::declared(agent_type) {
        return Ok(ProjectAgentSessionPage {
            items: Vec::new(),
            next_cursor: None,
            scan_complete: true,
            source_warning: None,
        });
    }
    let mut diag_stages = scan_diagnostics::CommandStages::default();
    let diag_invocation_id = if scan_diagnostics::is_enabled() {
        Some(uuid::Uuid::new_v4())
    } else {
        None
    };
    diag_stages.mark_folder_lookup();
    let folder = folder_service::get_folder_by_id(conn, request.folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))?;
    diag_stages.mark_enabled_check();
    let enabled = agent_setting_service::enabled_conversation_agent_types(conn).await?;
    if !enabled.contains(&agent_type) {
        return Err(AppCommandError::invalid_input(
            "Selected Agent is disabled for conversation browsing",
        ));
    }
    let limit = clamp_project_agent_session_page_limit(request.limit);
    diag_stages.mark_cursor_decode();
    let decoded_cursor = request
        .cursor
        .as_deref()
        .map(|cursor| {
            ProjectAgentSessionCursor::decode_for_scope(
                cursor,
                agent_type,
                &folder.path,
                request.search.as_deref(),
            )
        })
        .transpose()
        .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
    let db_cursor = decoded_cursor.as_ref().and_then(|cursor| cursor.db.clone());
    let db_already_complete = decoded_cursor
        .as_ref()
        .is_some_and(|cursor| cursor.db_complete);
    let native_cursor = decoded_cursor
        .as_ref()
        .and_then(|cursor| cursor.native.clone());
    let native_already_complete = decoded_cursor
        .as_ref()
        .is_some_and(|cursor| cursor.native_complete);
    diag_stages.mark_native_setup();

    if request.refresh {
        discovery::mark_scope_dirty(conn, agent_type, &folder.path)
            .await
            .map_err(AppCommandError::from)?;
    }
    let use_index = !request.refresh
        && (discovery::is_index_cursor(native_cursor.as_deref())
            || (request.cursor.is_none()
                && discovery::scope_has_complete_index(conn, agent_type, &folder.path)
                    .await
                    .unwrap_or(false)));
    if !use_index && request.cursor.is_none() {
        discovery::ensure_scope_discovery_started(conn, agent_type, &folder.path)
            .await
            .map_err(AppCommandError::from)?;
    }
    let native_request = NativeConversationPageRequest {
        project_path: folder.path.clone(),
        cursor: native_cursor.clone(),
        limit: limit as usize,
        scan_budget: PROJECT_AGENT_NATIVE_SCAN_BUDGET,
        search: request.search.clone(),
    };
    let index_conn = conn.clone();
    let index_project_path = folder.path.clone();
    let index_search = request.search.clone();
    let native_cursor_for_load = native_cursor.clone();
    let diag_spawn_submit = std::time::Instant::now();
    let native_future = async move {
        if native_already_complete {
            return None;
        }
        if use_index {
            let result = discovery::list_index_page(
                &index_conn,
                agent_type,
                &index_project_path,
                index_search.as_deref(),
                native_cursor_for_load.as_deref(),
                limit,
            )
            .await
            .map_err(|error| error.to_string());
            return Some((result, None, None, None));
        }
        let joined = tokio::task::spawn_blocking(move || {
            let blocking_queue = diag_spawn_submit.elapsed();
            let diag = scan_diagnostics::ScanDiagnosticsGuard::new();
            let scan_start = std::time::Instant::now();
            let result = build_agent_parser(agent_type)
                .list_conversation_page(&native_request)
                .map_err(|error| error.to_string());
            let scan_elapsed = scan_start.elapsed();
            let metrics = diag.into_metrics();
            (
                result,
                metrics,
                Some(scan_elapsed.as_millis() as u64),
                Some(blocking_queue.as_millis() as u64),
            )
        })
        .await;
        Some(match joined {
            Ok(result) => result,
            Err(error) => (
                Err(format!("Agent history task failed: {error}")),
                None,
                None,
                None,
            ),
        })
    };
    diag_stages.mark_db_start();
    let db_future = async {
        let db_op_start = std::time::Instant::now();
        let result = if db_already_complete {
            Ok::<_, berth_project_core::error::DbError>((Vec::new(), None))
        } else {
            conversation_service::list_project_agent_session_db_page(
                conn,
                request.folder_id,
                agent_type,
                request.search.as_deref(),
                db_cursor.as_ref(),
                limit,
            )
            .await
        };
        let db_only_elapsed = db_op_start.elapsed();
        (result, db_only_elapsed)
    };
    let (db_join_result, native_joined) = tokio::join!(db_future, native_future);
    diag_stages.mark_db_end();
    diag_stages.mark_join_end();
    let (db_result, db_only_elapsed) = db_join_result;
    diag_stages.db_only_elapsed = Some(db_only_elapsed);
    let (db_items, next_db_cursor) = db_result.map_err(AppCommandError::from)?;
    let db_complete = db_already_complete || next_db_cursor.is_none();

    let native_scan_ran = native_joined.is_some() && !use_index;
    let (
        native_items,
        next_native_cursor,
        native_complete,
        source_warning,
        native_metrics,
        native_scan_ms,
        native_blocking_queue_ms,
    ) = match native_joined {
        None => (Vec::new(), None, true, None, None, None, None),
        Some((Ok(page), metrics, scan_ms, queue_ms)) => (
            page.items,
            page.next_cursor,
            page.scan_complete,
            None,
            metrics,
            scan_ms,
            queue_ms,
        ),
        Some((Err(error), metrics, scan_ms, queue_ms)) => (
            Vec::new(),
            native_cursor,
            false,
            Some(error),
            metrics,
            scan_ms,
            queue_ms,
        ),
    };
    // A filtered provider walk cannot prove that the scope index is complete:
    // it intentionally omits non-matching summaries. Only an unfiltered final
    // page may close a discovery generation and invalidate unseen rows.
    let can_complete_discovery = request
        .search
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty);
    let pending_index_update = (native_scan_ran && (!native_items.is_empty() || native_complete))
        .then(|| {
            (
                native_items.clone(),
                native_complete && can_complete_discovery,
            )
        });
    let external_ids: Vec<String> = native_items
        .iter()
        .map(|summary| summary.id.clone())
        .collect();
    diag_stages.mark_identity_lookup();
    let identity_rows =
        conversation_service::project_agent_session_identity_rows(conn, agent_type, &external_ids)
            .await
            .map_err(AppCommandError::from)?;
    diag_stages.mark_reconcile();
    let items = reconcile_project_agent_session_page(native_items, db_items, identity_rows);
    let scan_complete = db_complete && native_complete;
    let next_cursor = if scan_complete {
        None
    } else {
        Some(
            ProjectAgentSessionCursor::new(
                agent_type,
                &folder.path,
                request.search.as_deref(),
                next_db_cursor,
                db_complete,
                next_native_cursor,
                native_complete,
            )
            .encode()
            .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?,
        )
    };
    diag_stages.mark_total_end();

    scan_diagnostics::emit_diagnostics(
        agent_type,
        diag_invocation_id,
        &diag_stages,
        native_metrics,
        native_scan_ms,
        native_blocking_queue_ms,
    );

    // Start shadow writes only after every foreground DB read for this request
    // has finished. The discovery layer serializes and retries writers, so a
    // burst of pages/windows cannot fail immediately on SQLite's writer lock.
    if let Some((index_items, discovery_complete)) = pending_index_update {
        let index_conn = conn.clone();
        let index_project_path = folder.path.clone();
        tokio::spawn(async move {
            if let Err(error) = discovery::index_discovered_page(
                &index_conn,
                agent_type,
                &index_project_path,
                index_items,
                discovery_complete,
            )
            .await
            {
                tracing::warn!(
                    target = "project_agent_sessions",
                    %agent_type,
                    %error,
                    "failed to update the project Agent session shadow index"
                );
            }
        });
    }

    Ok(ProjectAgentSessionPage {
        items,
        next_cursor,
        scan_complete,
        source_warning,
    })
}
