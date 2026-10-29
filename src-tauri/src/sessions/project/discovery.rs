use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sea_orm::EntityTrait;
use sha2::{Digest, Sha256};

use crate::db::service::project_agent_session_index_service::{
    self, ProjectAgentSessionIndexCursor, ProjectAgentSessionIndexWrite,
};
use berth_project_core::service::app_metadata_service;
use crate::models::{AgentType, ConversationSummary};
use crate::sessions::{normalize_path_for_matching, NativeConversationPage};

pub(crate) const PROJECT_AGENT_SESSION_INDEX_SCHEMA_VERSION: i32 = 1;
pub(crate) const PROJECT_AGENT_SESSION_ADAPTER_VERSION: i32 = 1;
const INDEX_SOURCE_MARKER: &str = "source=declarative";
const INDEX_CURSOR_PREFIX: &str = "index:";
const INDEX_WRITE_RETRY_DELAYS_MS: [u64; 3] = [50, 150, 450];
static INDEX_WRITER: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Persist summaries already paid for by a bounded provider page. SQLite has
/// one writer, so all page/index updates share one process-wide writer lane and
/// retry transient lock contention without blocking the foreground response.
pub(crate) async fn index_discovered_page(
    conn: &sea_orm::DatabaseConnection,
    agent_type: AgentType,
    project_path: &str,
    summaries: Vec<ConversationSummary>,
    discovery_complete: bool,
) -> Result<(), berth_project_core::error::DbError> {
    let _writer = INDEX_WRITER.lock().await;
    let mut attempt = 0;
    loop {
        match index_discovered_page_once(
            conn,
            agent_type,
            project_path,
            summaries.clone(),
            discovery_complete,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error)
                if is_database_locked(&error) && attempt < INDEX_WRITE_RETRY_DELAYS_MS.len() =>
            {
                let delay = INDEX_WRITE_RETRY_DELAYS_MS[attempt];
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn is_database_locked(error: &berth_project_core::error::DbError) -> bool {
    error
        .to_string()
        .to_lowercase()
        .contains("database is locked")
}

/// Persist summaries already paid for by a bounded provider page. A completed
/// unfiltered generation becomes the index-first read source; incomplete or
/// filtered generations remain on the bounded provider path.
async fn index_discovered_page_once(
    conn: &sea_orm::DatabaseConnection,
    agent_type: AgentType,
    project_path: &str,
    summaries: Vec<ConversationSummary>,
    discovery_complete: bool,
) -> Result<(), berth_project_core::error::DbError> {
    let agent_type_value = agent_type;
    let agent_type = agent_type_string(agent_type);
    let generation = chrono::Utc::now().timestamp_millis();
    let writes = summaries
        .into_iter()
        .filter_map(|summary| {
            let project_path = summary.folder_path.as_deref()?;
            let fingerprint = summary_fingerprint(&summary);
            let declarative_locator =
                crate::sessions::declarative::cached_source_locator(agent_type_value, &summary.id)?;
            let source_locator = declarative_locator.to_string_lossy().into_owned();
            let source_kind = "declarative".to_owned();
            Some(ProjectAgentSessionIndexWrite {
                agent_type: agent_type.clone(),
                external_id: summary.id.clone(),
                source_locator,
                source_kind,
                normalized_project_path: normalize_path_for_matching(project_path),
                fingerprint: Some(fingerprint),
                title: summary.title,
                model: summary.model,
                git_branch: summary.git_branch,
                message_count: i32::try_from(summary.message_count).unwrap_or(i32::MAX),
                started_at: summary.started_at,
                activity_at: summary.ended_at.unwrap_or(summary.started_at),
                source_available: true,
                index_schema_version: PROJECT_AGENT_SESSION_INDEX_SCHEMA_VERSION,
                adapter_version: PROJECT_AGENT_SESSION_ADAPTER_VERSION,
                last_seen_generation: generation,
            })
        })
        .collect();
    project_agent_session_index_service::upsert_batch(conn, writes).await?;
    if discovery_complete {
        let state_key = discovery_state_key(agent_type.as_str(), project_path);
        if let Some(started_at) = discovery_started_at(
            app_metadata_service::get_value(conn, &state_key)
                .await?
                .as_deref(),
        ) {
            project_agent_session_index_service::mark_scope_unavailable_before(
                conn,
                &agent_type,
                &normalize_path_for_matching(project_path),
                started_at,
            )
            .await?;
        }
        app_metadata_service::upsert_value(
            conn,
            &state_key,
            &format!(
                "schema={PROJECT_AGENT_SESSION_INDEX_SCHEMA_VERSION};adapter={PROJECT_AGENT_SESSION_ADAPTER_VERSION};{INDEX_SOURCE_MARKER};generation={generation}"
            ),
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn mark_scope_dirty(
    conn: &sea_orm::DatabaseConnection,
    agent_type: AgentType,
    project_path: &str,
) -> Result<(), berth_project_core::error::DbError> {
    let key = discovery_state_key(&agent_type_string(agent_type), project_path);
    if app_metadata_service::get_value(conn, &key)
        .await?
        .as_deref()
        .is_some_and(|value| value.starts_with("dirty:"))
    {
        return Ok(());
    }
    app_metadata_service::upsert_value(
        conn,
        &key,
        &format!("dirty:{}", chrono::Utc::now().to_rfc3339()),
    )
    .await
}

pub(crate) async fn ensure_scope_discovery_started(
    conn: &sea_orm::DatabaseConnection,
    agent_type: AgentType,
    project_path: &str,
) -> Result<(), berth_project_core::error::DbError> {
    let key = discovery_state_key(&agent_type_string(agent_type), project_path);
    if app_metadata_service::get_value(conn, &key).await?.is_none() {
        app_metadata_service::upsert_value(
            conn,
            &key,
            &format!("dirty:{}", chrono::Utc::now().to_rfc3339()),
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn scope_has_complete_index(
    conn: &sea_orm::DatabaseConnection,
    agent_type: AgentType,
    project_path: &str,
) -> Result<bool, berth_project_core::error::DbError> {
    let agent_type = agent_type_string(agent_type);
    let value =
        app_metadata_service::get_value(conn, &discovery_state_key(&agent_type, project_path))
            .await?;
    let expected = format!(
        "schema={PROJECT_AGENT_SESSION_INDEX_SCHEMA_VERSION};adapter={PROJECT_AGENT_SESSION_ADAPTER_VERSION};{INDEX_SOURCE_MARKER};"
    );
    Ok(value.is_some_and(|value| value.starts_with(&expected)))
}

pub(crate) fn is_index_cursor(cursor: Option<&str>) -> bool {
    cursor.is_some_and(|cursor| cursor.starts_with(INDEX_CURSOR_PREFIX))
}

pub(crate) async fn list_index_page(
    conn: &sea_orm::DatabaseConnection,
    agent_type: AgentType,
    project_path: &str,
    search: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> Result<NativeConversationPage, berth_project_core::error::DbError> {
    let cursor = cursor.map(decode_index_cursor).transpose()?;
    let (rows, next_cursor) = project_agent_session_index_service::list_page(
        conn,
        &normalize_path_for_matching(project_path),
        &agent_type_string(agent_type),
        search,
        cursor.as_ref(),
        PROJECT_AGENT_SESSION_INDEX_SCHEMA_VERSION,
        PROJECT_AGENT_SESSION_ADAPTER_VERSION,
        limit,
    )
    .await?;
    // The index is only refreshed by a full rescan, so files moved or deleted
    // since then would keep listing. Stat this (bounded) page and retire the
    // rows whose source is gone; `identity:` markers are not paths and stay.
    let mut missing = Vec::new();
    let mut live = Vec::with_capacity(rows.len());
    for row in rows {
        let locator = std::path::Path::new(&row.source_locator);
        if locator.is_absolute() && !tokio::fs::try_exists(locator).await.unwrap_or(true) {
            missing.push(row.external_id);
        } else {
            live.push(row);
        }
    }
    project_agent_session_index_service::mark_unavailable(
        conn,
        &agent_type_string(agent_type),
        &missing,
    )
    .await?;
    let rows = live;
    let items = rows
        .into_iter()
        .map(|row| ConversationSummary {
            id: row.external_id,
            agent_type,
            folder_path: Some(project_path.to_owned()),
            folder_name: std::path::Path::new(project_path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            title: row.title,
            started_at: row.started_at,
            ended_at: Some(row.activity_at),
            message_count: u32::try_from(row.message_count).unwrap_or_default(),
            model: row.model,
            git_branch: row.git_branch,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        })
        .collect();
    let scan_complete = next_cursor.is_none();
    Ok(NativeConversationPage {
        items,
        next_cursor: next_cursor.map(encode_index_cursor).transpose()?,
        scan_complete,
    })
}

fn encode_index_cursor(
    cursor: ProjectAgentSessionIndexCursor,
) -> Result<String, berth_project_core::error::DbError> {
    let bytes = serde_json::to_vec(&cursor)
        .map_err(|error| berth_project_core::error::DbError::Validation(error.to_string()))?;
    Ok(format!(
        "{INDEX_CURSOR_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(bytes)
    ))
}

fn decode_index_cursor(
    cursor: &str,
) -> Result<ProjectAgentSessionIndexCursor, berth_project_core::error::DbError> {
    let encoded = cursor.strip_prefix(INDEX_CURSOR_PREFIX).ok_or_else(|| {
        berth_project_core::error::DbError::Validation("invalid project session index cursor".into())
    })?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| {
        berth_project_core::error::DbError::Validation("invalid project session index cursor".into())
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        berth_project_core::error::DbError::Validation("invalid project session index cursor".into())
    })
}

fn discovery_started_at(value: Option<&str>) -> Option<chrono::DateTime<chrono::Utc>> {
    value?
        .strip_prefix("dirty:")?
        .parse::<chrono::DateTime<chrono::Utc>>()
        .ok()
}

fn discovery_state_key(agent_type: &str, project_path: &str) -> String {
    let normalized = normalize_path_for_matching(project_path);
    let digest = Sha256::digest(normalized.as_bytes());
    format!("project_agent_session_index:{agent_type}:{digest:x}")
}

pub(crate) async fn forget_project_index<C: sea_orm::ConnectionTrait>(
    conn: &C,
    project_path: &str,
) -> Result<(), berth_project_core::error::DbError> {
    let normalized_path = normalize_path_for_matching(project_path);
    project_agent_session_index_service::forget_project_path(conn, &normalized_path).await?;

    let digest = format!("{:x}", Sha256::digest(normalized_path.as_bytes()));
    let suffix = format!(":{digest}");
    // ponytail: scan the small metadata table; use a suffix query if its size becomes material.
    let keys = berth_project_core::entities::app_metadata::Entity::find()
        .all(conn)
        .await?
        .into_iter()
        .filter(|row| {
            row.key.starts_with("project_agent_session_index:") && row.key.ends_with(&suffix)
        })
        .map(|row| row.key)
        .collect::<Vec<_>>();
    for key in keys {
        app_metadata_service::remove_value(conn, &key).await?;
    }

    Ok(())
}

fn agent_type_string(agent_type: AgentType) -> String {
    serde_json::to_value(agent_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn summary_fingerprint(summary: &ConversationSummary) -> String {
    let bytes = serde_json::to_vec(summary).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[tokio::test]
    async fn forget_project_index_clears_exact_discovery_marker() {
        let db = fresh_in_memory_db().await;
        let agent_type = agent_type_string(AgentType::new("codex"));
        let project_key = discovery_state_key(&agent_type, "/repo");
        let nested_key = discovery_state_key(&agent_type, "/repo/sub");
        app_metadata_service::upsert_value(&db.conn, &project_key, "complete")
            .await
            .unwrap();
        app_metadata_service::upsert_value(&db.conn, &nested_key, "complete")
            .await
            .unwrap();

        forget_project_index(&db.conn, "/repo").await.unwrap();

        assert_eq!(
            app_metadata_service::get_value(&db.conn, &project_key)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            app_metadata_service::get_value(&db.conn, &nested_key)
                .await
                .unwrap()
                .as_deref(),
            Some("complete")
        );
    }
}
