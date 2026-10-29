use std::collections::HashSet;
use std::sync::OnceLock;

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
};
use tokio::sync::Mutex;

use berth_project_core::entities::{folder, primary_tab};
use berth_project_core::error::DbError;
use berth_project_core::service::app_metadata_service;
use crate::models::{AgentType, ConversationTab, OpenedTab, PrimaryTab, TerminalTab};

const PRIMARY_TABS_VERSION_KEY: &str = "primary_tabs_version";

fn version_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub struct CasOutcome {
    pub accepted: bool,
    pub version: i64,
    pub tabs: Vec<PrimaryTab>,
}

pub struct PrimaryTabInvalidation {
    pub version: i64,
    pub emit: Option<Vec<PrimaryTab>>,
}

fn agent_type_to_string(agent_type: AgentType) -> String {
    serde_json::to_value(agent_type)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn parse_agent_type(value: &str) -> Result<AgentType, DbError> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|_| DbError::Validation("invalid_primary_tab".to_string()))
}

fn validate_tab(tab: &PrimaryTab) -> Result<(), DbError> {
    match tab {
        PrimaryTab::Conversation(tab) => {
            if tab.id.trim().is_empty() || tab.title.len() > 1024 {
                return Err(DbError::Validation("invalid_primary_tab".to_string()));
            }
        }
        PrimaryTab::Terminal(tab) => {
            if tab.id.trim().is_empty()
                || tab.terminal_id.trim().is_empty()
                || tab.backend_instance_id.trim().is_empty()
                || tab.initial_cwd.trim().is_empty()
                || tab.shell.trim().is_empty()
                || tab.title.len() > 1024
                || tab.agent_type.as_ref().map_or(false, |t| t.len() > 256)
            {
                return Err(DbError::Validation("invalid_primary_tab".to_string()));
            }
        }
    }
    Ok(())
}

fn row_to_tab(row: primary_tab::Model) -> Result<PrimaryTab, DbError> {
    match row.kind.as_str() {
        "conversation" => Ok(PrimaryTab::Conversation(ConversationTab {
            id: row.tab_key,
            folder_id: row
                .folder_id
                .ok_or_else(|| DbError::Validation("invalid_primary_tab".to_string()))?,
            conversation_id: row
                .conversation_id
                .ok_or_else(|| DbError::Validation("invalid_primary_tab".to_string()))?,
            agent_type: parse_agent_type(
                row.agent_type
                    .as_deref()
                    .ok_or_else(|| DbError::Validation("invalid_primary_tab".to_string()))?,
            )?,
            title: row.title,
            is_pinned: row.is_pinned,
        })),
        "terminal" => Ok(PrimaryTab::Terminal(TerminalTab {
            id: row.tab_key,
            terminal_id: row
                .terminal_id
                .ok_or_else(|| DbError::Validation("invalid_primary_tab".to_string()))?,
            backend_instance_id: row
                .backend_instance_id
                .ok_or_else(|| DbError::Validation("invalid_primary_tab".to_string()))?,
            folder_id: row.folder_id,
            launch_source: row
                .launch_source
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| DbError::Validation("invalid_primary_tab".to_string()))?,
            agent_type: row.agent_type,
            title: row.title,
            initial_cwd: row
                .initial_cwd
                .ok_or_else(|| DbError::Validation("invalid_primary_tab".to_string()))?,
            last_known_cwd: row.last_known_cwd,
            shell: row
                .shell
                .ok_or_else(|| DbError::Validation("invalid_primary_tab".to_string()))?,
            detached_folder_label: row.detached_folder_label,
            detached_folder_path: row.detached_folder_path,
            is_pinned: row.is_pinned,
        })),
        _ => Err(DbError::Validation("invalid_primary_tab".to_string())),
    }
}

pub async fn get_tabs_version<C: ConnectionTrait>(conn: &C) -> Result<i64, DbError> {
    let raw = app_metadata_service::get_value_conn(conn, PRIMARY_TABS_VERSION_KEY).await?;
    Ok(raw.and_then(|value| value.parse::<i64>().ok()).unwrap_or(0))
}

pub async fn list_all_tabs<C: ConnectionTrait>(conn: &C) -> Result<Vec<PrimaryTab>, DbError> {
    primary_tab::Entity::find()
        .order_by_asc(primary_tab::Column::Position)
        .all(conn)
        .await?
        .into_iter()
        .map(row_to_tab)
        .collect()
}

pub async fn snapshot_tabs(conn: &DatabaseConnection) -> Result<(Vec<PrimaryTab>, i64), DbError> {
    let txn = conn.begin().await?;
    let tabs = list_all_tabs(&txn).await?;
    let version = get_tabs_version(&txn).await?;
    txn.commit().await?;
    Ok((tabs, version))
}

/// Batch-validate incoming folder IDs against the folder table.
/// Returns the set of folder IDs that actually exist.
async fn existing_folder_ids<C: ConnectionTrait>(
    conn: &C,
    candidate_ids: &HashSet<i32>,
) -> Result<HashSet<i32>, DbError> {
    if candidate_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows = folder::Entity::find()
        .filter(folder::Column::Id.is_in(candidate_ids.iter().copied()))
        .select_only()
        .column(folder::Column::Id)
        .into_tuple::<i32>()
        .all(conn)
        .await?;
    Ok(rows.into_iter().collect())
}

/// Normalize incoming items against the folder table:
/// - TerminalTab with a stale optional `folder_id` → `None` (detached terminal).
/// - ConversationTab with a stale required `folder_id` → validation error.
///
/// This is defense-in-depth: even if a caller passes a folder_id from another
/// client or stale runtime, the transaction cannot violate the FK constraint.
async fn normalize_folder_ids<C: ConnectionTrait>(
    conn: &C,
    items: Vec<PrimaryTab>,
) -> Result<Vec<PrimaryTab>, DbError> {
    let mut candidate_ids = HashSet::new();
    for item in &items {
        match item {
            PrimaryTab::Conversation(tab) => {
                candidate_ids.insert(tab.folder_id);
            }
            PrimaryTab::Terminal(tab) => {
                if let Some(fid) = tab.folder_id {
                    candidate_ids.insert(fid);
                }
            }
        }
    }
    if candidate_ids.is_empty() {
        return Ok(items);
    }
    let valid = existing_folder_ids(conn, &candidate_ids).await?;
    let stale: Vec<i32> = candidate_ids.difference(&valid).copied().collect();
    if stale.is_empty() {
        return Ok(items);
    }
    let stale_set: HashSet<i32> = stale.into_iter().collect();
    let mut normalized = Vec::with_capacity(items.len());
    for item in items {
        match item {
            PrimaryTab::Conversation(tab) => {
                if stale_set.contains(&tab.folder_id) {
                    return Err(DbError::Validation(
                        "conversation_tab_stale_folder".to_string(),
                    ));
                }
                normalized.push(PrimaryTab::Conversation(tab));
            }
            PrimaryTab::Terminal(mut tab) => {
                if let Some(fid) = tab.folder_id {
                    if stale_set.contains(&fid) {
                        tab.folder_id = None;
                    }
                }
                normalized.push(PrimaryTab::Terminal(tab));
            }
        }
    }
    Ok(normalized)
}

async fn replace_all_tabs<C: ConnectionTrait>(
    conn: &C,
    items: Vec<PrimaryTab>,
) -> Result<(), DbError> {
    let mut keys = HashSet::with_capacity(items.len());
    for item in &items {
        validate_tab(item)?;
        if !keys.insert(item.id().to_string()) {
            return Err(DbError::Validation("duplicate_primary_tab".to_string()));
        }
    }

    primary_tab::Entity::delete_many().exec(conn).await?;
    let now = Utc::now();
    for (position, item) in items.into_iter().enumerate() {
        let active = match item {
            PrimaryTab::Conversation(tab) => primary_tab::ActiveModel {
                id: NotSet,
                tab_key: Set(tab.id),
                kind: Set("conversation".to_string()),
                folder_id: Set(Some(tab.folder_id)),
                launch_source: Set(None),
                conversation_id: Set(Some(tab.conversation_id)),
                agent_type: Set(Some(agent_type_to_string(tab.agent_type))),
                terminal_id: Set(None),
                backend_instance_id: Set(None),
                title: Set(tab.title),
                initial_cwd: Set(None),
                last_known_cwd: Set(None),
                shell: Set(None),
                detached_folder_label: Set(None),
                detached_folder_path: Set(None),
                position: Set(position as i32),
                is_pinned: Set(tab.is_pinned),
                created_at: Set(now),
                updated_at: Set(now),
            },
            PrimaryTab::Terminal(tab) => primary_tab::ActiveModel {
                id: NotSet,
                tab_key: Set(tab.id),
                kind: Set("terminal".to_string()),
                folder_id: Set(tab.folder_id),
                launch_source: Set(tab
                    .launch_source
                    .map(|value| serde_json::to_string(&value))
                    .transpose()
                    .map_err(|_| DbError::Validation("invalid_primary_tab".to_string()))?),
                conversation_id: Set(None),
                agent_type: Set(tab.agent_type),
                terminal_id: Set(Some(tab.terminal_id)),
                backend_instance_id: Set(Some(tab.backend_instance_id)),
                title: Set(tab.title),
                initial_cwd: Set(Some(tab.initial_cwd)),
                last_known_cwd: Set(tab.last_known_cwd),
                shell: Set(Some(tab.shell)),
                detached_folder_label: Set(tab.detached_folder_label),
                detached_folder_path: Set(tab.detached_folder_path),
                position: Set(position as i32),
                is_pinned: Set(tab.is_pinned),
                created_at: Set(now),
                updated_at: Set(now),
            },
        };
        active.insert(conn).await?;
    }
    Ok(())
}

pub async fn save_all_tabs_cas(
    conn: &DatabaseConnection,
    items: Vec<PrimaryTab>,
    expected_version: i64,
) -> Result<CasOutcome, DbError> {
    let _guard = version_lock().lock().await;
    let txn = conn.begin().await?;
    let current = get_tabs_version(&txn).await?;
    if current != expected_version {
        let tabs = list_all_tabs(&txn).await?;
        txn.commit().await?;
        return Ok(CasOutcome {
            accepted: false,
            version: current,
            tabs,
        });
    }

    // Normalize stale folder IDs before the replace transaction:
    // - TerminalTab optional folder → None (detached)
    // - ConversationTab required folder → validation error
    let normalized = normalize_folder_ids(&txn, items).await?;
    replace_all_tabs(&txn, normalized).await?;
    let next = current + 1;
    app_metadata_service::upsert_value(&txn, PRIMARY_TABS_VERSION_KEY, &next.to_string()).await?;
    let tabs = list_all_tabs(&txn).await?;
    txn.commit().await?;
    Ok(CasOutcome {
        accepted: true,
        version: next,
        tabs,
    })
}

pub async fn contains_terminal<C: ConnectionTrait>(conn: &C) -> Result<bool, DbError> {
    Ok(primary_tab::Entity::find()
        .filter(primary_tab::Column::Kind.eq("terminal"))
        .one(conn)
        .await?
        .is_some())
}

pub fn legacy_to_primary(items: Vec<OpenedTab>) -> Vec<PrimaryTab> {
    items
        .into_iter()
        .filter_map(|item| {
            let conversation_id = item.conversation_id?;
            Some(PrimaryTab::Conversation(ConversationTab {
                id: format!(
                    "conv-{}-{}-{}",
                    item.folder_id,
                    agent_type_to_string(item.agent_type),
                    conversation_id
                ),
                folder_id: item.folder_id,
                conversation_id,
                agent_type: item.agent_type,
                title: String::new(),
                is_pinned: item.is_pinned,
            }))
        })
        .collect()
}

pub fn primary_to_legacy(items: &[PrimaryTab]) -> Vec<OpenedTab> {
    items
        .iter()
        .filter_map(|item| match item {
            PrimaryTab::Conversation(tab) => Some(OpenedTab {
                id: 0,
                folder_id: tab.folder_id,
                conversation_id: Some(tab.conversation_id),
                agent_type: tab.agent_type,
                position: 0,
                is_active: false,
                is_pinned: tab.is_pinned,
            }),
            PrimaryTab::Terminal(_) => None,
        })
        .enumerate()
        .map(|(position, mut tab)| {
            tab.position = position as i32;
            tab
        })
        .collect()
}

pub async fn delete_conversation_tabs_and_bump(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<PrimaryTabInvalidation, DbError> {
    delete_matching_tabs_and_bump(
        conn,
        Condition::all().add(primary_tab::Column::ConversationId.eq(conversation_id)),
    )
    .await
}

pub async fn detach_folder_tabs_and_bump(
    conn: &DatabaseConnection,
    folder_id: i32,
    source_label: String,
    source_path: String,
) -> Result<PrimaryTabInvalidation, DbError> {
    let _guard = version_lock().lock().await;
    let txn = conn.begin().await?;

    // Close conversation tabs for this folder.
    let removed_conversations = primary_tab::Entity::delete_many()
        .filter(
            Condition::all()
                .add(primary_tab::Column::Kind.eq("conversation"))
                .add(primary_tab::Column::FolderId.eq(folder_id)),
        )
        .exec(&txn)
        .await?;

    // Detach terminal tabs: null folder_id and retain source label/path.
    let terminal_rows = primary_tab::Entity::find()
        .filter(
            Condition::all()
                .add(primary_tab::Column::Kind.eq("terminal"))
                .add(primary_tab::Column::FolderId.eq(folder_id)),
        )
        .all(&txn)
        .await?;
    let mut terminal_updates = 0u64;
    let now = Utc::now();
    for row in terminal_rows {
        let mut active: primary_tab::ActiveModel = row.into();
        active.folder_id = Set(None);
        active.detached_folder_label = Set(Some(source_label.clone()));
        active.detached_folder_path = Set(Some(source_path.clone()));
        active.updated_at = Set(now);
        active.update(&txn).await?;
        terminal_updates += 1;
    }

    let next = get_tabs_version(&txn).await? + 1;
    app_metadata_service::upsert_value(&txn, PRIMARY_TABS_VERSION_KEY, &next.to_string()).await?;
    let changed = removed_conversations.rows_affected > 0 || terminal_updates > 0;
    let emit = if changed {
        Some(list_all_tabs(&txn).await?)
    } else {
        None
    };
    txn.commit().await?;
    Ok(PrimaryTabInvalidation {
        version: next,
        emit,
    })
}

pub async fn delete_folder_tabs_and_bump(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<PrimaryTabInvalidation, DbError> {
    delete_matching_tabs_and_bump(
        conn,
        Condition::all().add(primary_tab::Column::FolderId.eq(folder_id)),
    )
    .await
}

pub async fn delete_terminal_tabs_and_bump(
    conn: &DatabaseConnection,
    terminal_id: &str,
    backend_instance_id: &str,
) -> Result<PrimaryTabInvalidation, DbError> {
    delete_matching_tabs_and_bump(
        conn,
        Condition::all()
            .add(primary_tab::Column::Kind.eq("terminal"))
            .add(primary_tab::Column::TerminalId.eq(terminal_id))
            .add(primary_tab::Column::BackendInstanceId.eq(backend_instance_id)),
    )
    .await
}

async fn delete_matching_tabs_and_bump(
    conn: &DatabaseConnection,
    condition: Condition,
) -> Result<PrimaryTabInvalidation, DbError> {
    let _guard = version_lock().lock().await;
    let txn = conn.begin().await?;
    let removed = primary_tab::Entity::delete_many()
        .filter(condition)
        .exec(&txn)
        .await?;
    let next = get_tabs_version(&txn).await? + 1;
    app_metadata_service::upsert_value(&txn, PRIMARY_TABS_VERSION_KEY, &next.to_string()).await?;
    let emit = if removed.rows_affected > 0 {
        Some(list_all_tabs(&txn).await?)
    } else {
        None
    };
    txn.commit().await?;
    Ok(PrimaryTabInvalidation {
        version: next,
        emit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use crate::models::AgentType;

    fn make_terminal_tab(id: &str, folder_id: Option<i32>) -> PrimaryTab {
        PrimaryTab::Terminal(TerminalTab {
            id: id.to_string(),
            terminal_id: format!("tid-{}", id),
            backend_instance_id: "backend-1".to_string(),
            folder_id,
            launch_source: None,
            agent_type: None,
            title: "term".to_string(),
            initial_cwd: "/tmp".to_string(),
            last_known_cwd: None,
            shell: "/bin/bash".to_string(),
            detached_folder_label: None,
            detached_folder_path: None,
            is_pinned: false,
        })
    }

    fn make_conversation_tab(id: &str, folder_id: i32) -> PrimaryTab {
        PrimaryTab::Conversation(ConversationTab {
            id: id.to_string(),
            folder_id,
            conversation_id: 1,
            agent_type: AgentType::new("claude_code"),
            title: "conv".to_string(),
            is_pinned: false,
        })
    }

    #[tokio::test]
    async fn stale_terminal_folder_normalized_to_none() {
        let db = fresh_in_memory_db().await;
        let valid_fid = seed_folder(&db, "/repo/valid").await;
        // TerminalTab with a stale folder_id (9999 doesn't exist).
        let items = vec![
            make_terminal_tab("t1", Some(9999)),
            make_terminal_tab("t2", Some(valid_fid)),
            make_terminal_tab("t3", None),
        ];
        let outcome = save_all_tabs_cas(&db.conn, items, 0)
            .await
            .expect("save succeeds after normalization");
        assert!(outcome.accepted);
        // Read back: stale folder → None, valid folder preserved, null preserved.
        let tabs = list_all_tabs(&db.conn).await.expect("list");
        assert_eq!(tabs.len(), 3);
        for tab in &tabs {
            match tab {
                PrimaryTab::Terminal(t) if t.id == "t1" => {
                    assert_eq!(t.folder_id, None, "stale folder → None");
                }
                PrimaryTab::Terminal(t) if t.id == "t2" => {
                    assert_eq!(t.folder_id, Some(valid_fid), "valid folder preserved");
                }
                PrimaryTab::Terminal(t) if t.id == "t3" => {
                    assert_eq!(t.folder_id, None, "null folder preserved");
                }
                _ => panic!("unexpected tab"),
            }
        }
    }

    #[tokio::test]
    async fn stale_conversation_folder_returns_validation_error() {
        let db = fresh_in_memory_db().await;
        let _valid_fid = seed_folder(&db, "/repo/valid").await;
        // ConversationTab with a stale folder_id.
        let items = vec![make_conversation_tab("c1", 9999)];
        let result = save_all_tabs_cas(&db.conn, items, 0).await;
        let err = match result {
            Err(err) => err,
            Ok(_) => panic!("stale conversation folder must fail validation"),
        };
        match err {
            DbError::Validation(msg) => {
                assert_eq!(msg, "conversation_tab_stale_folder");
            }
            other => panic!("expected Validation, got {:?}", other),
        }
        // CAS version unchanged.
        let v = get_tabs_version(&db.conn).await.expect("version");
        assert_eq!(v, 0, "version not bumped on validation error");
        // Table remains empty.
        let tabs = list_all_tabs(&db.conn).await.expect("list");
        assert!(tabs.is_empty());
    }

    #[tokio::test]
    async fn valid_and_null_folders_preserved() {
        let db = fresh_in_memory_db().await;
        let fid = seed_folder(&db, "/repo/valid").await;
        let items = vec![
            make_terminal_tab("t1", Some(fid)),
            make_terminal_tab("t2", None),
        ];
        let outcome = save_all_tabs_cas(&db.conn, items, 0)
            .await
            .expect("save succeeds");
        assert!(outcome.accepted);
        assert_eq!(outcome.version, 1);
        let tabs = list_all_tabs(&db.conn).await.expect("list");
        for tab in &tabs {
            match tab {
                PrimaryTab::Terminal(t) if t.id == "t1" => {
                    assert_eq!(t.folder_id, Some(fid));
                }
                PrimaryTab::Terminal(t) if t.id == "t2" => {
                    assert_eq!(t.folder_id, None);
                }
                _ => panic!("unexpected tab"),
            }
        }
    }

    #[tokio::test]
    async fn batch_query_no_n_plus_one() {
        // Verify that multiple stale folder IDs are resolved in a single batch
        // query (existing_folder_ids uses is_in), not per-tab.
        let db = fresh_in_memory_db().await;
        let fid = seed_folder(&db, "/repo/valid").await;
        let mut items = Vec::new();
        for i in 0..20 {
            items.push(make_terminal_tab(&format!("t{}", i), Some(9000 + i)));
        }
        items.push(make_terminal_tab("valid", Some(fid)));
        let outcome = save_all_tabs_cas(&db.conn, items, 0)
            .await
            .expect("batch normalization succeeds");
        assert!(outcome.accepted);
        let tabs = list_all_tabs(&db.conn).await.expect("list");
        assert_eq!(tabs.len(), 21);
        for tab in &tabs {
            if let PrimaryTab::Terminal(t) = tab {
                if t.id == "valid" {
                    assert_eq!(t.folder_id, Some(fid));
                } else {
                    assert_eq!(t.folder_id, None);
                }
            }
        }
    }

    #[tokio::test]
    async fn agent_type_preserved_for_terminal_tab() {
        let db = fresh_in_memory_db().await;
        let mut tab1 = make_terminal_tab("t1", None);
        if let PrimaryTab::Terminal(t) = &mut tab1 {
            t.agent_type = Some("antigravity".to_string());
            t.title = "Antigravity · project".to_string();
        }
        let mut tab2 = make_terminal_tab("t2", None);
        if let PrimaryTab::Terminal(t) = &mut tab2 {
            t.agent_type = Some("claude_code".to_string());
            t.title = "Claude Code".to_string();
        }
        let outcome = save_all_tabs_cas(&db.conn, vec![tab1, tab2], 0)
            .await
            .expect("save succeeds");
        assert!(outcome.accepted);

        let tabs = list_all_tabs(&db.conn).await.expect("list");
        assert_eq!(tabs.len(), 2);
        if let PrimaryTab::Terminal(t) = &tabs[0] {
            assert_eq!(t.agent_type.as_deref(), Some("antigravity"));
            assert_eq!(t.title, "Antigravity · project");
        } else {
            panic!("expected TerminalTab");
        }
        if let PrimaryTab::Terminal(t) = &tabs[1] {
            assert_eq!(t.agent_type.as_deref(), Some("claude_code"));
            assert_eq!(t.title, "Claude Code");
        } else {
            panic!("expected TerminalTab");
        }
    }
}
