use chrono::{DateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};

use berth_project_core::entities::project_agent_session_index;
use berth_project_core::error::DbError;

// 每行包含 18 个绑定字段；50 行保持在常见 SQLite 999 参数上限以内。
const PROJECT_AGENT_SESSION_INDEX_BATCH_SIZE: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProjectAgentSessionIndexCursor {
    pub activity_at: DateTime<Utc>,
    pub external_id: String,
}

#[derive(Debug, Clone)]
pub struct ProjectAgentSessionIndexWrite {
    pub agent_type: String,
    pub external_id: String,
    pub source_locator: String,
    pub source_kind: String,
    pub normalized_project_path: String,
    pub fingerprint: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub message_count: i32,
    pub started_at: DateTime<Utc>,
    pub activity_at: DateTime<Utc>,
    pub source_available: bool,
    pub index_schema_version: i32,
    pub adapter_version: i32,
    pub last_seen_generation: i64,
}

/// Persist one provider page in a shared transaction. Chunks keep each
/// statement below SQLite's bind-parameter cap while the page commits atomically.
pub async fn upsert_batch(
    conn: &DatabaseConnection,
    writes: Vec<ProjectAgentSessionIndexWrite>,
) -> Result<(), DbError> {
    if writes.is_empty() {
        return Ok(());
    }

    let txn = conn.begin().await?;
    let now = Utc::now();
    for chunk in writes.chunks(PROJECT_AGENT_SESSION_INDEX_BATCH_SIZE) {
        let models = chunk
            .iter()
            .cloned()
            .map(|write| active_model(write, now, now))
            .collect::<Vec<_>>();
        project_agent_session_index::Entity::insert_many(models)
            .on_conflict(index_upsert_conflict())
            .exec(&txn)
            .await?;
    }
    txn.commit().await?;
    Ok(())
}

pub async fn forget_project_path<C: ConnectionTrait>(
    conn: &C,
    normalized_project_path: &str,
) -> Result<(), DbError> {
    project_agent_session_index::Entity::delete_many()
        .filter(
            project_agent_session_index::Column::NormalizedProjectPath.eq(normalized_project_path),
        )
        .exec(conn)
        .await?;
    Ok(())
}

fn active_model(
    write: ProjectAgentSessionIndexWrite,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
) -> project_agent_session_index::ActiveModel {
    project_agent_session_index::ActiveModel {
        agent_type: Set(write.agent_type),
        external_id: Set(write.external_id),
        source_locator: Set(write.source_locator),
        source_kind: Set(write.source_kind),
        normalized_project_path: Set(write.normalized_project_path),
        fingerprint: Set(write.fingerprint),
        title: Set(write.title),
        model: Set(write.model),
        git_branch: Set(write.git_branch),
        message_count: Set(write.message_count),
        started_at: Set(write.started_at),
        activity_at: Set(write.activity_at),
        source_available: Set(write.source_available),
        index_schema_version: Set(write.index_schema_version),
        adapter_version: Set(write.adapter_version),
        last_seen_generation: Set(write.last_seen_generation),
        created_at: Set(created_at),
        updated_at: Set(updated_at),
    }
}

fn index_upsert_conflict() -> OnConflict {
    OnConflict::columns([
        project_agent_session_index::Column::AgentType,
        project_agent_session_index::Column::ExternalId,
    ])
    .update_columns([
        project_agent_session_index::Column::SourceLocator,
        project_agent_session_index::Column::SourceKind,
        project_agent_session_index::Column::NormalizedProjectPath,
        project_agent_session_index::Column::Fingerprint,
        project_agent_session_index::Column::Title,
        project_agent_session_index::Column::Model,
        project_agent_session_index::Column::GitBranch,
        project_agent_session_index::Column::MessageCount,
        project_agent_session_index::Column::StartedAt,
        project_agent_session_index::Column::ActivityAt,
        project_agent_session_index::Column::SourceAvailable,
        project_agent_session_index::Column::IndexSchemaVersion,
        project_agent_session_index::Column::AdapterVersion,
        project_agent_session_index::Column::LastSeenGeneration,
        project_agent_session_index::Column::UpdatedAt,
    ])
    .to_owned()
}

pub async fn list_page(
    conn: &DatabaseConnection,
    normalized_project_path: &str,
    agent_type: &str,
    search: Option<&str>,
    cursor: Option<&ProjectAgentSessionIndexCursor>,
    index_schema_version: i32,
    adapter_version: i32,
    limit: u32,
) -> Result<
    (
        Vec<project_agent_session_index::Model>,
        Option<ProjectAgentSessionIndexCursor>,
    ),
    DbError,
> {
    let mut query = project_agent_session_index::Entity::find()
        .filter(
            project_agent_session_index::Column::NormalizedProjectPath.eq(normalized_project_path),
        )
        .filter(project_agent_session_index::Column::AgentType.eq(agent_type))
        .filter(project_agent_session_index::Column::SourceKind.eq("declarative"))
        .filter(project_agent_session_index::Column::SourceAvailable.eq(true))
        .filter(project_agent_session_index::Column::IndexSchemaVersion.eq(index_schema_version))
        .filter(project_agent_session_index::Column::AdapterVersion.eq(adapter_version));
    if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
        query = query.filter(
            Condition::any()
                .add(project_agent_session_index::Column::Title.contains(search))
                .add(project_agent_session_index::Column::Model.contains(search))
                .add(project_agent_session_index::Column::GitBranch.contains(search)),
        );
    }
    if let Some(cursor) = cursor {
        query = query.filter(
            Condition::any()
                .add(project_agent_session_index::Column::ActivityAt.lt(cursor.activity_at))
                .add(
                    Condition::all()
                        .add(project_agent_session_index::Column::ActivityAt.eq(cursor.activity_at))
                        .add(
                            project_agent_session_index::Column::ExternalId
                                .lt(cursor.external_id.clone()),
                        ),
                ),
        );
    }
    let limit = limit.max(1);
    let mut rows = query
        .order_by_desc(project_agent_session_index::Column::ActivityAt)
        .order_by_desc(project_agent_session_index::Column::ExternalId)
        .limit(u64::from(limit) + 1)
        .all(conn)
        .await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = has_more.then(|| {
        let last = rows.last().expect("LIMIT+1 implies a returned index row");
        ProjectAgentSessionIndexCursor {
            activity_at: last.activity_at,
            external_id: last.external_id.clone(),
        }
    });
    Ok((rows, next_cursor))
}

/// Return a persisted locator for a declarative source.  Legacy rows keep
/// their `identity:<id>` marker and are intentionally ignored here.
pub async fn declarative_source_locator(
    conn: &DatabaseConnection,
    agent_type: &str,
    external_id: &str,
) -> Result<Option<String>, DbError> {
    Ok(project_agent_session_index::Entity::find_by_id((
        agent_type.to_owned(),
        external_id.to_owned(),
    ))
    .filter(project_agent_session_index::Column::SourceKind.eq("declarative"))
    .filter(project_agent_session_index::Column::SourceAvailable.eq(true))
    .one(conn)
    .await?
    .map(|row| row.source_locator))
}

/// Flag specific rows whose source file no longer exists, so index-first reads
/// stop listing them.
pub async fn mark_unavailable(
    conn: &DatabaseConnection,
    agent_type: &str,
    external_ids: &[String],
) -> Result<u64, DbError> {
    if external_ids.is_empty() {
        return Ok(0);
    }
    let result = project_agent_session_index::Entity::update_many()
        .col_expr(
            project_agent_session_index::Column::SourceAvailable,
            sea_orm::sea_query::Expr::value(false),
        )
        .col_expr(
            project_agent_session_index::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(project_agent_session_index::Column::AgentType.eq(agent_type))
        .filter(project_agent_session_index::Column::ExternalId.is_in(external_ids.to_vec()))
        .exec(conn)
        .await?;
    Ok(result.rows_affected)
}

pub async fn mark_scope_unavailable_before(
    conn: &DatabaseConnection,
    agent_type: &str,
    normalized_project_path: &str,
    before: DateTime<Utc>,
) -> Result<u64, DbError> {
    let result = project_agent_session_index::Entity::update_many()
        .col_expr(
            project_agent_session_index::Column::SourceAvailable,
            sea_orm::sea_query::Expr::value(false),
        )
        .col_expr(
            project_agent_session_index::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(project_agent_session_index::Column::AgentType.eq(agent_type))
        .filter(project_agent_session_index::Column::SourceKind.eq("declarative"))
        .filter(
            project_agent_session_index::Column::NormalizedProjectPath.eq(normalized_project_path),
        )
        .filter(project_agent_session_index::Column::UpdatedAt.lt(before))
        .exec(conn)
        .await?;
    Ok(result.rows_affected)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn write(external_id: &str, activity: i64) -> ProjectAgentSessionIndexWrite {
        ProjectAgentSessionIndexWrite {
            agent_type: "codex".into(),
            external_id: external_id.into(),
            source_locator: format!("/sessions/{external_id}.jsonl"),
            source_kind: "declarative".into(),
            normalized_project_path: "/repo".into(),
            fingerprint: Some(format!("fp-{activity}")),
            title: Some(format!("session-{external_id}")),
            model: Some("model".into()),
            git_branch: Some("main".into()),
            message_count: 2,
            started_at: Utc.timestamp_opt(activity - 1, 0).single().unwrap(),
            activity_at: Utc.timestamp_opt(activity, 0).single().unwrap(),
            source_available: true,
            index_schema_version: 1,
            adapter_version: 1,
            last_seen_generation: 1,
        }
    }

    #[tokio::test]
    async fn mark_unavailable_hides_only_the_named_rows() {
        let db = fresh_in_memory_db().await;
        upsert_batch(&db.conn, vec![write("a", 1), write("b", 2)])
            .await
            .unwrap();
        mark_unavailable(&db.conn, "codex", &["a".to_owned()])
            .await
            .unwrap();
        let (rows, _) = list_page(&db.conn, "/repo", "codex", None, None, 1, 1, 10)
            .await
            .unwrap();
        let ids: Vec<_> = rows.iter().map(|row| row.external_id.as_str()).collect();
        assert_eq!(ids, ["b"]);
    }

    #[tokio::test]
    async fn batch_upsert_inserts_across_chunks_and_updates_conflicts() {
        let db = fresh_in_memory_db().await;
        let writes = (0..55)
            .map(|index| write(&format!("s{index}"), index + 1))
            .collect();
        upsert_batch(&db.conn, writes).await.unwrap();

        let (rows, next) = list_page(&db.conn, "/repo", "codex", None, None, 1, 1, 100)
            .await
            .unwrap();
        assert_eq!(rows.len(), 55);
        assert!(next.is_none());

        let original =
            project_agent_session_index::Entity::find_by_id(("codex".to_owned(), "s0".to_owned()))
                .one(&db.conn)
                .await
                .unwrap()
                .unwrap();
        let mut changed = write("s0", 99);
        changed.title = Some("batch-updated".into());
        upsert_batch(&db.conn, vec![changed]).await.unwrap();

        let updated =
            project_agent_session_index::Entity::find_by_id(("codex".to_owned(), "s0".to_owned()))
                .one(&db.conn)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(updated.title.as_deref(), Some("batch-updated"));
        assert_eq!(
            updated.activity_at,
            Utc.timestamp_opt(99, 0).single().unwrap()
        );
        assert_eq!(updated.created_at, original.created_at);
    }

    #[tokio::test]
    async fn batch_upsert_accepts_an_empty_page() {
        let db = fresh_in_memory_db().await;
        upsert_batch(&db.conn, Vec::new()).await.unwrap();

        let (rows, next) = list_page(&db.conn, "/repo", "codex", None, None, 1, 1, 10)
            .await
            .unwrap();
        assert!(rows.is_empty());
        assert!(next.is_none());
    }

    #[tokio::test]
    async fn forget_project_path_does_not_match_nested_projects() {
        let db = fresh_in_memory_db().await;
        let mut parent = write("parent", 1);
        let mut child = write("child", 2);
        parent.normalized_project_path = "/repo".into();
        child.normalized_project_path = "/repo/sub".into();
        upsert_batch(&db.conn, vec![parent, child]).await.unwrap();

        forget_project_path(&db.conn, "/repo").await.unwrap();

        let (parent_rows, _) = list_page(&db.conn, "/repo", "codex", None, None, 1, 1, 10)
            .await
            .unwrap();
        let (child_rows, _) = list_page(&db.conn, "/repo/sub", "codex", None, None, 1, 1, 10)
            .await
            .unwrap();
        assert!(parent_rows.is_empty());
        assert_eq!(child_rows.len(), 1);
        assert_eq!(child_rows[0].external_id, "child");
    }

    #[tokio::test]
    async fn declarative_locator_ignores_legacy_and_unavailable_rows() {
        let db = fresh_in_memory_db().await;
        let mut legacy = write("legacy", 1);
        legacy.source_kind = "legacy".into();
        upsert_batch(&db.conn, vec![legacy]).await.unwrap();
        assert_eq!(
            declarative_source_locator(&db.conn, "codex", "legacy")
                .await
                .unwrap(),
            None
        );

        let mut declarative = write("declared", 2);
        declarative.source_kind = "declarative".into();
        declarative.source_locator = "/sessions/declared.jsonl".into();
        upsert_batch(&db.conn, vec![declarative]).await.unwrap();
        assert_eq!(
            declarative_source_locator(&db.conn, "codex", "declared")
                .await
                .unwrap()
                .as_deref(),
            Some("/sessions/declared.jsonl")
        );

        let mut unavailable = write("unavailable", 3);
        unavailable.source_kind = "declarative".into();
        unavailable.source_available = false;
        upsert_batch(&db.conn, vec![unavailable]).await.unwrap();
        assert_eq!(
            declarative_source_locator(&db.conn, "codex", "unavailable")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn list_page_is_scope_bound_and_keyset_paged() {
        let db = fresh_in_memory_db().await;
        upsert_batch(&db.conn, vec![write("older", 10), write("newer", 20)])
            .await
            .unwrap();

        let (first, cursor) = list_page(&db.conn, "/repo", "codex", None, None, 1, 1, 1)
            .await
            .unwrap();
        assert_eq!(first[0].external_id, "newer");
        let (second, next) = list_page(&db.conn, "/repo", "codex", None, cursor.as_ref(), 1, 1, 1)
            .await
            .unwrap();
        assert_eq!(second[0].external_id, "older");
        assert!(next.is_none());
    }
}
