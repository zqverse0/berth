//! 服务商档案的导出 / 导入格式（`berth.providers/1`），供备份与换机。
//!
//! 导出只读库：库里本就不存 Key（主 Key 与 discovery 内的分组 / 端点 Key 都在
//! keyring），这里再按 `split_secrets` 清洗一遍兜底，所以文件里永远没有 Key。
//! 官方档案不导出（由 tool.json 声明虚拟出来）。导入在 GUI 走新建档案的同一
//! 条路径；文件里若手填了分组 Key，会照常拆进 keyring。

use sea_orm::{DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model_provider_launch::{list_custom, split_secrets};
use crate::entities::model_provider_overlay;
use crate::error::DbError;

pub const FORMAT: &str = "berth.providers/1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderExport {
    pub format: String,
    pub providers: Vec<ExportedProvider>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedProvider {
    pub name: String,
    #[serde(default)]
    pub api_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    /// 库内 `model` 列（模型映射 JSON），展开成对象便于手改。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_allowlist: Vec<String>,
    /// 清洗后的 `discovery_json`（端点、分组、viaProxy 等）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overlays: Vec<ExportedOverlay>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedOverlay {
    pub agent_type: String,
    pub models: Value,
}

/// 库内 JSON 字符串列展开成值；不是合法 JSON 就原样作字符串。
fn expand(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// `expand` 的逆：字符串原样，其余序列化回 JSON 文本。
pub fn flatten(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// 旧版本双写的 `groupKeys` 与 `keyGroups` 同义；两者都在时只留 `keyGroups`。
fn drop_alias(mut discovery: Value) -> Value {
    if let Some(object) = discovery.as_object_mut() {
        if object.contains_key("keyGroups") {
            object.remove("groupKeys");
        }
    }
    discovery
}

pub async fn export(conn: &DatabaseConnection) -> Result<ProviderExport, DbError> {
    let overlays = model_provider_overlay::Entity::find().all(conn).await?;
    let providers = list_custom(conn)
        .await?
        .into_iter()
        .map(|row| ExportedProvider {
            models: row
                .model
                .as_deref()
                .filter(|raw| !raw.trim().is_empty())
                .map(expand),
            agent_allowlist: serde_json::from_str(&row.agent_allowlist).unwrap_or_default(),
            // 非法 JSON 不导出：拆不出 Key 就不能保证文件里没有 Key。
            discovery: row
                .discovery_json
                .as_deref()
                .and_then(split_secrets)
                .and_then(|(sanitized, _, _)| serde_json::from_str(&sanitized).ok())
                .map(drop_alias),
            overlays: overlays
                .iter()
                .filter(|overlay| overlay.provider_id == row.id)
                .map(|overlay| ExportedOverlay {
                    agent_type: overlay.agent_type.clone(),
                    models: expand(&overlay.models_json),
                })
                .collect(),
            name: row.name,
            api_url: row.api_url,
            agent_type: row.agent_type,
            website: row.website,
        })
        .collect();
    Ok(ProviderExport {
        format: FORMAT.into(),
        providers,
    })
}

pub fn parse(text: &str) -> Result<ProviderExport, String> {
    let parsed: ProviderExport =
        serde_json::from_str(text).map_err(|error| format!("not a provider export: {error}"))?;
    if parsed.format != FORMAT {
        return Err(format!(
            "unsupported format '{}', expected '{FORMAT}'",
            parsed.format
        ));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn export_has_no_keys_and_parses_back() {
        use sea_orm::{ConnectionTrait, Database};
        use sea_orm_migration::MigratorTrait;

        let conn = Database::connect("sqlite::memory:").await.unwrap();
        crate::migration::Migrator::up(&conn, None).await.unwrap();
        // 兜底场景：旧数据把 Key 留在了 discovery 里，导出仍不能带出。
        conn.execute_unprepared(
            "INSERT INTO model_provider (id, name, api_url, api_key, agent_types_json, agent_type, \
             model, kind, flavor, agent_allowlist, discovery_json, created_at, updated_at) VALUES \
             (1, 'relay', 'https://r', 'sk-col', '[]', '', '[{\"id\":\"m\"}]', 'custom', 'openai', \
              '[\"codex\"]', '{\"keyGroups\":[{\"id\":\"1\",\"key\":\"sk-grp\"}],\"groupKeys\":[{\"id\":\"1\",\"key\":\"sk-grp\"}],\"viaProxy\":true}', \
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), \
             (2, 'official', '', '', '[]', 'codex', NULL, 'official', 'openai', '[]', NULL, \
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'); \
             INSERT INTO model_provider_overlay (provider_id, agent_type, models_json) VALUES \
             (1, 'claude_code', '[{\"id\":\"m\",\"slot\":\"opus\"}]')",
        )
        .await
        .unwrap();

        let exported = export(&conn).await.unwrap();
        let text = serde_json::to_string_pretty(&exported).unwrap();
        assert!(!text.contains("sk-col") && !text.contains("sk-grp"));
        assert_eq!(exported.providers.len(), 1, "official rows are skipped");
        let relay = &exported.providers[0];
        assert_eq!(relay.agent_allowlist, vec!["codex"]);
        let discovery = relay.discovery.as_ref().unwrap();
        assert_eq!(discovery["viaProxy"], true);
        assert!(discovery.get("groupKeys").is_none());
        assert_eq!(flatten(relay.models.as_ref().unwrap()), r#"[{"id":"m"}]"#);
        assert_eq!(relay.overlays[0].agent_type, "claude_code");

        assert_eq!(parse(&text).unwrap(), exported);
        assert!(parse(r#"{"format":"other","providers":[]}"#).is_err());
    }
}
