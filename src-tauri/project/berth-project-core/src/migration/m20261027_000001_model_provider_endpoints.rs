use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{json, Map, Value};

/// 旧中转站档案只有 `api_url` + `agent_allowlist`（Agent 名单），协议靠前端按品牌换算。
/// 一次性改写成按协议记地址（`discovery_json.endpoints`），并清空名单；之后宿主与前端
/// 只读 `endpoints`，不再按 Agent 品牌推协议。
///
/// 换算与原前端回退一致（冻结在此，不随插件变化）：`claude_code`/`claude` → `claude`，
/// `codex`/`grok`/`pi` → `chat`，`gemini` → `gemini`；都不命中 → `chat`。
/// 已有非空端点、官方档案、空地址、`discovery_json` 不是 JSON 对象的行不动。
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, api_url, discovery_json, agent_allowlist FROM model_provider \
                 WHERE kind = 'custom' AND trim(api_url) <> ''"
                    .to_owned(),
            ))
            .await?;
        for row in rows {
            let id: i32 = row.try_get("", "id")?;
            let api_url: String = row.try_get("", "api_url")?;
            let discovery: Option<String> = row.try_get("", "discovery_json")?;
            let allowlist: Option<String> = row.try_get("", "agent_allowlist")?;
            let Some(discovery) =
                with_endpoints(discovery.as_deref(), &api_url, allowlist.as_deref())
            else {
                continue;
            };
            conn.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "UPDATE model_provider SET discovery_json = ?, agent_allowlist = '[]' WHERE id = ?",
                [discovery.into(), id.into()],
            ))
            .await?;
        }
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // 数据改写不可逆：名单已清空，端点保留即可照常使用。
        Ok(())
    }
}

/// 需要改写时返回新的 `discovery_json`。
fn with_endpoints(
    discovery: Option<&str>,
    api_url: &str,
    allowlist: Option<&str>,
) -> Option<String> {
    let mut root = match discovery.map(str::trim).filter(|raw| !raw.is_empty()) {
        None => Map::new(),
        Some(raw) => match serde_json::from_str::<Value>(raw).ok()? {
            Value::Object(map) => map,
            _ => return None,
        },
    };
    let has_endpoint = root
        .get("endpoints")
        .and_then(Value::as_object)
        .is_some_and(|endpoints| {
            endpoints.values().any(|endpoint| {
                ["apiUrl", "api_url"].iter().any(|key| {
                    endpoint
                        .get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|url| !url.trim().is_empty())
                })
            })
        });
    if has_endpoint {
        return None;
    }
    let agents: Vec<String> = allowlist
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let wants = |names: &[&str]| {
        agents
            .iter()
            .any(|agent| names.contains(&agent.trim().to_ascii_lowercase().as_str()))
    };
    let mut protocols: Vec<&str> = [
        ("claude", wants(&["claude_code", "claude"])),
        ("chat", wants(&["codex", "grok", "pi"])),
        ("gemini", wants(&["gemini"])),
    ]
    .into_iter()
    .filter_map(|(protocol, wanted)| wanted.then_some(protocol))
    .collect();
    if protocols.is_empty() {
        protocols.push("chat");
    }
    let url = api_url.trim();
    let endpoints: Map<String, Value> = protocols
        .into_iter()
        .map(|protocol| (protocol.to_owned(), json!({ "apiUrl": url })))
        .collect();
    root.insert("endpoints".into(), Value::Object(endpoints));
    Some(Value::Object(root).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::Database;

    #[test]
    fn allowlist_becomes_protocol_endpoints() {
        let out = |discovery, allow| {
            with_endpoints(discovery, " https://x.example ", allow)
                .map(|raw| serde_json::from_str::<Value>(&raw).unwrap())
        };
        let both = out(None, Some(r#"["codex","claude_code","pi"]"#)).unwrap();
        assert_eq!(both["endpoints"]["claude"]["apiUrl"], "https://x.example");
        assert_eq!(both["endpoints"]["chat"]["apiUrl"], "https://x.example");
        assert!(both["endpoints"].get("gemini").is_none());

        let none = out(Some(r#"{"groupKeys":[]}"#), Some("[]")).unwrap();
        assert_eq!(none["endpoints"]["chat"]["apiUrl"], "https://x.example");
        assert_eq!(none["groupKeys"], json!([]), "other keys are kept");

        let declared = r#"{"endpoints":{"claude":{"apiUrl":"https://y"}}}"#;
        assert!(out(Some(declared), Some(r#"["codex"]"#)).is_none());
        assert!(out(Some("not json"), None).is_none());
        // 端点键在但地址空：仍按名单补。
        let empty = out(
            Some(r#"{"endpoints":{"chat":{"apiUrl":""}}}"#),
            Some(r#"["gemini"]"#),
        )
        .unwrap();
        assert_eq!(empty["endpoints"]["gemini"]["apiUrl"], "https://x.example");
    }

    #[tokio::test]
    async fn up_rewrites_only_legacy_custom_rows() {
        let conn = Database::connect("sqlite::memory:").await.unwrap();
        conn.execute_unprepared(
            "CREATE TABLE model_provider (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, api_url TEXT NOT NULL,
               discovery_json TEXT NULL, agent_allowlist TEXT NOT NULL DEFAULT '[]');
             INSERT INTO model_provider VALUES (1, 'custom', 'https://a', NULL, '[\"claude_code\"]');
             INSERT INTO model_provider VALUES (2, 'official', '', NULL, '[\"codex\"]');
             INSERT INTO model_provider VALUES (3, 'custom', 'https://c', '{\"endpoints\":{\"chat\":{\"apiUrl\":\"https://c\"}}}', '[\"codex\"]');",
        )
        .await
        .unwrap();
        Migration.up(&SchemaManager::new(&conn)).await.unwrap();
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, discovery_json, agent_allowlist FROM model_provider ORDER BY id"
                    .to_owned(),
            ))
            .await
            .unwrap();
        let get = |index: usize, column: &str| -> Option<String> {
            rows[index].try_get("", column).unwrap()
        };
        assert_eq!(
            get(0, "discovery_json").as_deref(),
            Some(r#"{"endpoints":{"claude":{"apiUrl":"https://a"}}}"#)
        );
        assert_eq!(get(0, "agent_allowlist").as_deref(), Some("[]"));
        assert_eq!(get(1, "discovery_json"), None);
        assert_eq!(get(1, "agent_allowlist").as_deref(), Some(r#"["codex"]"#));
        assert_eq!(get(2, "agent_allowlist").as_deref(), Some(r#"["codex"]"#));
    }
}
