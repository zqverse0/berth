use std::collections::{HashMap, HashSet};

use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use berth_project_core::entities::agent_setting;
use berth_project_core::error::DbError;
use crate::models::agent::AgentType;
use crate::sessions::{agent_session_exists, declared_session_agent_types};

#[derive(Debug, Clone)]
pub struct AgentDefaultInput {
    pub agent_type: AgentType,
    pub registry_id: String,
    pub default_sort_order: i32,
}

#[derive(Debug, Clone)]
pub struct AgentSettingsUpdate {
    pub enabled: bool,
    pub env_json: Option<String>,
    pub model_provider_id: Option<i32>,
}
/// Initial value for a setting row, based on whether the agent already has a
/// local session store. This probe runs only for a missing row: `ensure_defaults`
/// never overwrites an existing user's enabled choice.
///
/// `agent_session_exists` is conservative: an indeterminate/failed probe is
/// treated as present, so permission or mount errors cannot silently hide an
/// installed agent.
fn default_enabled(agent_type: AgentType) -> bool {
    agent_session_exists(agent_type)
}

/// Resolve the set of Agents whose conversations can be browsed: every Agent
/// whose Tool Asset declares a readable `sessions.json` and whose declared
/// session store exists right now (conservative probe).
///
/// The persisted `agent_setting.enabled` column is not consulted: no UI writes
/// it, so its value is only the probe result frozen at first startup. Reading
/// it hid Agents whose declaration or session store appeared later (e.g. a
/// tool that gained `sessions.json`), with no way for the user to undo that.
pub async fn enabled_conversation_agent_types(
    _conn: &DatabaseConnection,
) -> Result<HashSet<AgentType>, DbError> {
    Ok(declared_session_agent_types()
        .into_iter()
        .filter(|agent_type| agent_session_exists(*agent_type))
        .collect())
}

pub async fn ensure_defaults(
    conn: &DatabaseConnection,
    defaults: &[AgentDefaultInput],
) -> Result<(), DbError> {
    for default in defaults {
        let agent_type = serde_json::to_string(&default.agent_type)
            .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
        let existing = agent_setting::Entity::find()
            .filter(agent_setting::Column::AgentType.eq(agent_type.clone()))
            .one(conn)
            .await?;

        if let Some(model) = existing {
            if model.registry_id != default.registry_id {
                let mut active = model.into_active_model();
                active.registry_id = Set(default.registry_id.clone());
                active.updated_at = Set(Utc::now());
                active.update(conn).await?;
            }
            continue;
        }

        let now = Utc::now();
        let active = agent_setting::ActiveModel {
            id: NotSet,
            agent_type: Set(agent_type),
            registry_id: Set(default.registry_id.clone()),
            enabled: Set(default_enabled(default.agent_type)),
            sort_order: Set(default.default_sort_order),
            installed_version: Set(None),
            env_json: Set(None),
            model_provider_id: Set(None),
            model_key: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        };
        match active.insert(conn).await {
            Ok(_) => {}
            Err(e) if e.to_string().contains("UNIQUE constraint failed") => {
                // Another concurrent call already inserted this row — safe to ignore.
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }

    Ok(())
}

pub async fn list(conn: &DatabaseConnection) -> Result<Vec<agent_setting::Model>, DbError> {
    let rows = agent_setting::Entity::find()
        .order_by_asc(agent_setting::Column::SortOrder)
        .all(conn)
        .await?;
    Ok(rows)
}

pub async fn list_map_by_agent_type(
    conn: &DatabaseConnection,
) -> Result<HashMap<AgentType, agent_setting::Model>, DbError> {
    let rows = list(conn).await?;
    let mut map = HashMap::new();
    for row in rows {
        if let Ok(agent_type) = serde_json::from_str::<AgentType>(&row.agent_type) {
            map.insert(agent_type, row);
        }
    }
    Ok(map)
}

pub async fn get_by_agent_type(
    conn: &DatabaseConnection,
    agent_type: AgentType,
) -> Result<Option<agent_setting::Model>, DbError> {
    let agent_type_str = serde_json::to_string(&agent_type)
        .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
    let model = agent_setting::Entity::find()
        .filter(agent_setting::Column::AgentType.eq(agent_type_str))
        .one(conn)
        .await?;
    Ok(model)
}

pub async fn update(
    conn: &DatabaseConnection,
    agent_type: AgentType,
    patch: AgentSettingsUpdate,
) -> Result<(), DbError> {
    let agent_type_str = serde_json::to_string(&agent_type)
        .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
    let model = agent_setting::Entity::find()
        .filter(agent_setting::Column::AgentType.eq(agent_type_str.clone()))
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("agent setting not found: {agent_type_str}")))?;

    let mut active = model.into_active_model();
    active.enabled = Set(patch.enabled);
    active.env_json = Set(patch.env_json);
    active.model_provider_id = Set(patch.model_provider_id);
    active.updated_at = Set(Utc::now());
    active.update(conn).await?;
    Ok(())
}

pub async fn set_installed_version(
    conn: &DatabaseConnection,
    agent_type: AgentType,
    installed_version: Option<String>,
) -> Result<(), DbError> {
    let agent_type_str = serde_json::to_string(&agent_type)
        .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
    if let Some(model) = agent_setting::Entity::find()
        .filter(agent_setting::Column::AgentType.eq(agent_type_str))
        .one(conn)
        .await?
    {
        let mut active = model.into_active_model();
        active.installed_version = Set(installed_version);
        active.updated_at = Set(Utc::now());
        active.update(conn).await?;
    }
    Ok(())
}

/// 设置 / 清除一个 agent 的模型服务商绑定(窄接口,不触碰 enabled /
/// env_json 等其他列)。`model_key` 是档案内选中的具体模型键(claude
/// 档案 model 为角色 JSON);清绑定时两者都传 `None`。行不存在时按默认
/// 值插入(upsert),保证启动栏对从未开过会话的 agent 也能直接绑定。
pub async fn set_model_binding(
    conn: &DatabaseConnection,
    agent_type: AgentType,
    model_provider_id: Option<i32>,
    model_key: Option<String>,
) -> Result<(), DbError> {
    let agent_type_str = serde_json::to_string(&agent_type)
        .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;
    // loop 而非递归重试:并发插入撞唯一约束时,下一轮会查到对手插入的行
    // 并走更新路径(async fn 递归需 Box::pin,这里不值得)。
    loop {
        if let Some(model) = agent_setting::Entity::find()
            .filter(agent_setting::Column::AgentType.eq(agent_type_str.clone()))
            .one(conn)
            .await?
        {
            let mut active = model.into_active_model();
            active.model_provider_id = Set(model_provider_id);
            active.model_key = Set(model_key.clone());
            active.updated_at = Set(Utc::now());
            active.update(conn).await?;
            return Ok(());
        }
        let now = Utc::now();
        let active = agent_setting::ActiveModel {
            id: NotSet,
            agent_type: Set(agent_type_str.clone()),
            registry_id: Set(String::new()),
            enabled: Set(default_enabled(agent_type)),
            sort_order: Set(i32::MAX),
            installed_version: Set(None),
            env_json: Set(None),
            model_provider_id: Set(model_provider_id),
            model_key: Set(model_key.clone()),
            created_at: Set(now),
            updated_at: Set(now),
        };
        match active.insert(conn).await {
            Ok(_) => return Ok(()),
            Err(e) if e.to_string().contains("UNIQUE constraint failed") => {
                // 并发插入已建行;下一轮走更新路径。
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

pub async fn reorder(conn: &DatabaseConnection, agent_types: &[AgentType]) -> Result<(), DbError> {
    if agent_types.is_empty() {
        return Ok(());
    }

    match reorder_once(conn, agent_types).await {
        Ok(()) => Ok(()),
        Err(err) if is_sqlite_full_error(&err) => {
            // Try truncating WAL once to reclaim space and retry.
            conn.execute(Statement::from_string(
                DbBackend::Sqlite,
                "PRAGMA wal_checkpoint(TRUNCATE);".to_owned(),
            ))
            .await?;
            reorder_once(conn, agent_types).await
        }
        Err(err) => Err(err),
    }
}

async fn reorder_once(conn: &DatabaseConnection, agent_types: &[AgentType]) -> Result<(), DbError> {
    let now = Utc::now();
    for (index, agent_type) in agent_types.iter().enumerate() {
        let agent_type_str = serde_json::to_string(agent_type)
            .map_err(|e| DbError::Migration(format!("agent_type serialize failed: {e}")))?;

        if let Some(model) = agent_setting::Entity::find()
            .filter(agent_setting::Column::AgentType.eq(agent_type_str))
            .one(conn)
            .await?
        {
            // Skip unchanged rows to reduce write pressure when repeatedly dragging.
            if model.sort_order == index as i32 {
                continue;
            }
            let mut active = model.into_active_model();
            active.sort_order = Set(index as i32);
            active.updated_at = Set(now);
            active.update(conn).await?;
        }
    }
    Ok(())
}

pub async fn find_by_model_provider_id(
    conn: &DatabaseConnection,
    model_provider_id: i32,
) -> Result<Vec<agent_setting::Model>, DbError> {
    let rows = agent_setting::Entity::find()
        .filter(agent_setting::Column::ModelProviderId.eq(Some(model_provider_id)))
        .all(conn)
        .await?;
    Ok(rows)
}

/// 删除服务商前清掉历史全局绑定残留。
///
/// 启动注入已改为只信当次 `provider_id`/`model_id`，`agent_setting.model_provider_id`
/// 不再是「必须解除关联才能删」的硬依赖；这里只做脏数据清理，避免 FK 语义残留。
pub async fn clear_model_provider_bindings(
    conn: &DatabaseConnection,
    model_provider_id: i32,
) -> Result<usize, DbError> {
    let rows = find_by_model_provider_id(conn, model_provider_id).await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let now = Utc::now();
    let cleared = rows.len();
    for model in rows {
        let mut active = model.into_active_model();
        active.model_provider_id = Set(None);
        active.model_key = Set(None);
        active.updated_at = Set(now);
        active.update(conn).await?;
    }
    Ok(cleared)
}

fn is_sqlite_full_error(err: &DbError) -> bool {
    let message = err.to_string();
    message.contains("database or disk is full") || message.contains("(code: 13)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn default_input(agent_type: AgentType, registry_id: &str) -> AgentDefaultInput {
        AgentDefaultInput {
            agent_type,
            registry_id: registry_id.to_string(),
            default_sort_order: 0,
        }
    }

    #[tokio::test]
    async fn inserted_default_matches_the_conservative_session_probe() {
        let db = fresh_in_memory_db().await;
        ensure_defaults(&db.conn, &[default_input(AgentType::new("hermes"), "hermes")])
            .await
            .expect("insert default");

        let setting = get_by_agent_type(&db.conn, AgentType::new("hermes"))
            .await
            .expect("read setting")
            .expect("setting exists");
        assert_eq!(setting.enabled, agent_session_exists(AgentType::new("hermes")));
    }

    #[tokio::test]
    async fn missing_rows_use_the_same_session_probe_as_inserted_defaults() {
        let db = fresh_in_memory_db().await;
        let enabled = enabled_conversation_agent_types(&db.conn)
            .await
            .expect("enabled set");
        for agent_type in declared_session_agent_types() {
            assert_eq!(
                enabled.contains(&agent_type),
                agent_session_exists(agent_type),
                "missing row for {agent_type:?} must follow the shared probe"
            );
        }
    }

    #[tokio::test]
    async fn existing_enabled_choice_survives_default_reconciliation() {
        let db = fresh_in_memory_db().await;
        ensure_defaults(
            &db.conn,
            &[default_input(AgentType::new("hermes"), "hermes-before")],
        )
        .await
        .expect("insert default");
        update(
            &db.conn,
            AgentType::new("hermes"),
            AgentSettingsUpdate {
                enabled: true,
                env_json: None,
                model_provider_id: None,
            },
        )
        .await
        .expect("enable hermes manually");

        ensure_defaults(
            &db.conn,
            &[default_input(AgentType::new("hermes"), "hermes-after")],
        )
        .await
        .expect("reconcile default");

        let setting = get_by_agent_type(&db.conn, AgentType::new("hermes"))
            .await
            .expect("read setting")
            .expect("setting exists");
        assert!(
            setting.enabled,
            "filesystem probing must not overwrite user choice"
        );
        assert_eq!(setting.registry_id, "hermes-after");
    }

    #[tokio::test]
    async fn a_stale_disabled_row_does_not_hide_a_declared_agent() {
        let db = fresh_in_memory_db().await;
        ensure_defaults(&db.conn, &[default_input(AgentType::new("codex"), "codex")])
            .await
            .expect("insert default");
        update(
            &db.conn,
            AgentType::new("codex"),
            AgentSettingsUpdate {
                enabled: false,
                env_json: None,
                model_provider_id: None,
            },
        )
        .await
        .expect("disable codex row");

        let enabled = enabled_conversation_agent_types(&db.conn)
            .await
            .expect("enabled set");
        assert_eq!(
            enabled.contains(&AgentType::new("codex")),
            declared_session_agent_types().contains(&AgentType::new("codex"))
                && agent_session_exists(AgentType::new("codex"))
        );
    }
}
