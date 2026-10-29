//! 启动注入的档案侧读取：选中档案 + 该 Agent 栏的 overlay 模型，以及
//! keyring 条目命名与 discovery_json 内 Key 的拆分 / 回填。
//!
//! GUI（含旧明文迁移的读写路径）与 CLI（只读）共用；Key 本身只由调用方从
//! keyring 取出并在内存中使用，本模块不访问 keyring。

use std::collections::BTreeMap;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use serde_json::Value;

use crate::entities::{model_provider, model_provider_overlay};
use crate::error::DbError;

/// 一次启动要注入的档案（不含 Key）。
#[derive(Debug, Clone)]
pub struct LaunchProvider {
    /// 档案行。
    pub provider: model_provider::Model,
    /// 该 Agent 栏 overlay 的模型 JSON（带 slot）。
    pub overlay_models: Option<String>,
}

/// 读取 `provider_id` 在 `agent_type` 栏的启动档案；档案不存在或为官方登录
/// （不注入）时返回 `None`。
pub async fn load(
    conn: &DatabaseConnection,
    provider_id: i32,
    agent_type: &str,
) -> Result<Option<LaunchProvider>, DbError> {
    let Some(provider) = model_provider::Entity::find_by_id(provider_id)
        .one(conn)
        .await?
    else {
        return Ok(None);
    };
    if provider.kind == model_provider::KIND_OFFICIAL {
        return Ok(None);
    }
    let overlay_models = model_provider_overlay::Entity::find()
        .filter(model_provider_overlay::Column::ProviderId.eq(provider_id))
        .filter(model_provider_overlay::Column::AgentType.eq(agent_type))
        .one(conn)
        .await?
        .map(|row| row.models_json);
    Ok(Some(LaunchProvider {
        provider,
        overlay_models,
    }))
}

/// 可注入 / 经代理使用的全部档案（排除官方档案），按 id 升序。
pub async fn list_custom(conn: &DatabaseConnection) -> Result<Vec<model_provider::Model>, DbError> {
    Ok(model_provider::Entity::find()
        .filter(model_provider::Column::Kind.ne(model_provider::KIND_OFFICIAL))
        .order_by_asc(model_provider::Column::Id)
        .all(conn)
        .await?)
}

/// 档案主 Key 的 keyring 账户名。
pub fn api_key_account(provider_id: i32) -> String {
    format!("model-provider/{provider_id}")
}

/// 本地凭据代理的调用方令牌（可公开的占位凭据，不是服务商 Key）。整个实例一个。
pub const PROXY_TOKEN_ACCOUNT: &str = "provider-proxy/token";

/// 档案 `discovery_json` 内的分组 / 端点 Key，整份 `{槽位: key}` JSON 存一个条目。
pub fn secrets_account(provider_id: i32) -> String {
    format!("model-provider/{provider_id}/discovery")
}

// ── discovery_json 内的分组 / 端点 Key ──
//
// 库里只存清洗后的 JSON（Key 字段为空串）；Key 整份存在 keyring 的一个条目里，
// 形如 `{"group:<id>": "...", "endpoint:<protocol>": "..."}`。DTO 形态不变：
// 读出时回填，所以设置页与启动注入都看不到差别。

/// keyring 内 `{槽位: key}`。
pub type SecretMap = BTreeMap<String, String>;

/// 遍历 JSON 里所有密钥字段：`keyGroups` / `groupKeys` 同 id 视为同一槽位
/// `group:<id>`，`endpoints.<p>.apiKey|api_key` 为 `endpoint:<p>`。
fn visit_secret_fields(value: &mut Value, mut visit: impl FnMut(String, &mut Value)) {
    for list in ["keyGroups", "groupKeys"] {
        let Some(groups) = value.get_mut(list).and_then(Value::as_array_mut) else {
            continue;
        };
        for group in groups {
            let id = match group.get("id") {
                Some(Value::String(id)) => id.clone(),
                Some(Value::Number(id)) => id.to_string(),
                _ => continue,
            };
            if let Some(key) = group.get_mut("key") {
                visit(format!("group:{id}"), key);
            }
        }
    }
    if let Some(endpoints) = value.get_mut("endpoints").and_then(Value::as_object_mut) {
        for (protocol, endpoint) in endpoints {
            for field in ["apiKey", "api_key"] {
                if let Some(key) = endpoint.get_mut(field) {
                    visit(format!("endpoint:{protocol}"), key);
                }
            }
        }
    }
}

/// 取出非空 Key 并在 JSON 中置空。返回（清洗后 JSON，取出的 Key，出现过的全部槽位）；
/// 非法 JSON 返回 `None`（原样保留，不猜）。
pub fn split_secrets(raw: &str) -> Option<(String, SecretMap, Vec<String>)> {
    let mut value: Value = serde_json::from_str(raw).ok()?;
    let mut secrets = SecretMap::new();
    let mut slots = Vec::new();
    visit_secret_fields(&mut value, |slot, key| {
        if let Some(text) = key.as_str().map(str::trim).filter(|text| !text.is_empty()) {
            secrets
                .entry(slot.clone())
                .or_insert_with(|| text.to_string());
        }
        *key = Value::String(String::new());
        slots.push(slot);
    });
    Some((value.to_string(), secrets, slots))
}

/// 用 keyring 里的 Key 回填清洗后的 JSON（只在内存）。
pub fn merge_secrets(sanitized: &str, secrets: &SecretMap) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(sanitized) else {
        return sanitized.to_string();
    };
    visit_secret_fields(&mut value, |slot, key| {
        if key.as_str().is_some_and(str::is_empty) {
            if let Some(secret) = secrets.get(&slot) {
                *key = Value::String(secret.clone());
            }
        }
    });
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = r#"{
        "endpoints": {"chat": {"apiUrl": "https://x", "apiKey": "sk-ep"}, "claude": {"api_key": ""}},
        "keyGroups": [{"id": "1", "key": "sk-a", "models": []}, {"id": 2, "key": "sk-b"}],
        "groupKeys": [{"id": "1", "key": "sk-a"}, {"id": 2, "key": "sk-b"}]
    }"#;

    #[test]
    fn split_removes_every_key_and_merge_restores_them() {
        let (sanitized, secrets, slots) = split_secrets(RAW).expect("valid json");
        for key in ["sk-a", "sk-b", "sk-ep"] {
            assert!(
                !sanitized.contains(key),
                "{key} must not stay in the stored JSON"
            );
        }
        assert_eq!(
            secrets,
            SecretMap::from([
                ("endpoint:chat".into(), "sk-ep".into()),
                ("group:1".into(), "sk-a".into()),
                ("group:2".into(), "sk-b".into()),
            ])
        );
        assert!(slots.contains(&"endpoint:claude".to_string()));

        let merged: Value = serde_json::from_str(&merge_secrets(&sanitized, &secrets)).unwrap();
        let original: Value = serde_json::from_str(RAW).unwrap();
        assert_eq!(
            merged, original,
            "both alias arrays and endpoints are refilled"
        );

        // 缺失的 keyring 条目保持空串。
        let partial = merge_secrets(
            &sanitized,
            &SecretMap::from([("group:1".into(), "sk-a".into())]),
        );
        assert!(partial.contains("sk-a") && !partial.contains("sk-b"));
    }

    #[test]
    fn invalid_or_keyless_json_is_left_alone() {
        assert!(split_secrets("not json").is_none());
        let (sanitized, secrets, _) = split_secrets(r#"{"endpoints":{}}"#).unwrap();
        assert!(secrets.is_empty());
        assert_eq!(sanitized, r#"{"endpoints":{}}"#);
    }

    #[tokio::test]
    async fn load_skips_missing_and_official_and_reads_the_agent_overlay() {
        use sea_orm::{ConnectionTrait, Database};
        use sea_orm_migration::MigratorTrait;

        let conn = Database::connect("sqlite::memory:").await.unwrap();
        crate::migration::Migrator::up(&conn, None).await.unwrap();
        conn.execute_unprepared(
            "INSERT INTO model_provider (id, name, api_url, api_key, agent_types_json, agent_type, \
             model, kind, flavor, agent_allowlist, created_at, updated_at) VALUES \
             (1, 'relay', 'https://r', '', '[]', 'claude_code', NULL, 'custom', 'openai', '[]', \
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), \
             (2, 'official', '', '', '[]', 'claude_code', NULL, 'official', 'openai', '[]', \
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'); \
             INSERT INTO model_provider_overlay (provider_id, agent_type, models_json) VALUES \
             (1, 'claude_code', '[{\"id\":\"m\",\"slot\":\"opus\"}]')",
        )
        .await
        .unwrap();

        let relay = load(&conn, 1, "claude_code").await.unwrap().unwrap();
        assert_eq!(relay.provider.name, "relay");
        assert!(relay.overlay_models.unwrap().contains("opus"));
        // 其他 Agent 栏没有 overlay。
        assert!(load(&conn, 1, "codex")
            .await
            .unwrap()
            .unwrap()
            .overlay_models
            .is_none());
        assert!(load(&conn, 2, "claude_code").await.unwrap().is_none());
        assert!(load(&conn, 99, "claude_code").await.unwrap().is_none());
    }
}
