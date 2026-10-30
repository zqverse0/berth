//! 从 cc-switch(`~/.cc-switch/cc-switch.db`)批量导入供应商档案。
//!
//! cc-switch 是最常用的 CLI 供应商切换器,其 `providers` 表按 app 存
//! "要写进 CLI 配置文件的内容";这里只做**读取与字段提取**,把每条
//! 记录还原成 berth 档案:url / key / 已知模型列表(JSON 数组,作为
//! 启动栏下拉的回退数据;运行时优先用 `models::fetch` 实时拉取):
//!
//! - `claude`:settings_config 即 `~/.claude/settings.json` 片段,
//!   `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN` 是 url/key,
//!   `env.ANTHROPIC_MODEL` 与 `env.ANTHROPIC_DEFAULT_*_MODEL` 还原成
//!   模型映射条目 `{"name":"Opus","id":"glm-5.3"}`(角色名做显示名);
//! - `codex`:`auth.OPENAI_API_KEY` 是 key,`config`(TOML)里选中
//!   provider 的 `base_url` 与顶层 `model` 是 url / 模型;
//! - `gemini`:`env.GEMINI_API_KEY`/`GOOGLE_API_KEY` 与
//!   `GOOGLE_GEMINI_BASE_URL` 是 key/url(官方 OAuth 记录提不出,
//!   跳过);
//! - 其余 app(hermes/openclaw/opencode/pi 等)不在档案栏,跳过计数。
//!
//! 导入幂等:同名 + 同栏的档案已存在即跳过,重复执行不产生重复行。
//!
//! 同文件还承载 Berth 自己的 `berth.providers/1` 文件导出 / 导入(备份与换机)。

use std::path::PathBuf;

use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;

/// 导入结果摘要(前端 toast 展示)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// 成功创建的档案数。
    pub imported: usize,
    /// 跳过:同名档案已存在。
    pub skipped_duplicate: usize,
    /// 跳过:记录存在但提不出 url/key(未填、官方 OAuth 等)。
    pub skipped_incomplete: usize,
    /// 跳过:app 不在协议三栏(hermes/openclaw/opencode/pi 等)。
    pub unsupported: usize,
}

/// cc-switch app 标识 → berth 档案栏(agent_type)。
fn app_type_to_agent_type(app_type: &str) -> Option<&'static str> {
    match app_type {
        "claude" => Some("claude_code"),
        "codex" => Some("codex"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

/// 执行导入。cc-switch 数据库不存在时返回明确错误(前端提示)。
pub async fn import_from_cc_switch(db: &AppDatabase) -> Result<ImportSummary, AppCommandError> {
    let path = cc_switch_db_path()?;
    if !path.is_file() {
        return Err(AppCommandError::not_found(
            "cc-switch database not found at ~/.cc-switch/cc-switch.db; is cc-switch installed?",
        ));
    }
    let rows = read_providers_with_website(&path)?;
    let mut summary = ImportSummary {
        imported: 0,
        skipped_duplicate: 0,
        skipped_incomplete: 0,
        unsupported: 0,
    };
    // 查重快照拉一次,循环内只做内存匹配;新导入行直接补进快照。
    let mut existing = crate::db::service::model_provider_service::list_all(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    for (app_type, name, settings_config, website) in rows {
        let Some(agent_type) = app_type_to_agent_type(&app_type) else {
            summary.unsupported += 1;
            continue;
        };
        let Some((api_url, api_key, model)) = extract(&app_type, &settings_config) else {
            summary.skipped_incomplete += 1;
            continue;
        };
        if existing
            .iter()
            .any(|row| row.name == name && row.agent_type == agent_type)
        {
            summary.skipped_duplicate += 1;
            continue;
        }
        let website = website
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let kind = if api_url.is_empty() {
            berth_project_core::entities::model_provider::KIND_OFFICIAL
        } else {
            berth_project_core::entities::model_provider::KIND_CUSTOM
        };
        let created = crate::db::service::model_provider_service::create_with_kind(
            &db.conn,
            name.clone(),
            api_url,
            api_key,
            agent_type.to_string(),
            model,
            website,
            kind.to_string(),
        )
        .await
        .map_err(AppCommandError::from)?;
        existing.push(created);
        summary.imported += 1;
    }
    Ok(summary)
}

/// `berth.providers/1` 文件的导出 / 导入结果(设置页 toast 展示)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    /// 导出写入 / 导入新建的档案数。
    pub providers: usize,
    /// 导入跳过:同名同地址的档案已存在。
    pub skipped_duplicate: usize,
}

/// 把全部自定义档案写成不含 Key 的 JSON 文件(格式见 `model_provider_export`)。
pub async fn export_to_file(
    db: &AppDatabase,
    path: &str,
) -> Result<TransferSummary, AppCommandError> {
    let exported = berth_project_core::service::model_provider_export::export(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    let text = serde_json::to_string_pretty(&exported)
        .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
    std::fs::write(path, text + "\n")
        .map_err(|error| AppCommandError::invalid_input(format!("cannot write {path}: {error}")))?;
    Ok(TransferSummary {
        providers: exported.providers.len(),
        skipped_duplicate: 0,
    })
}

/// 从导出文件新建档案,走与设置页新建相同的路径;同名同地址的已存在即跳过,
/// 重复导入幂等。文件不含 Key,导入后在设置页或 `berth provider set-key` 补。
pub async fn import_from_file(
    db: &AppDatabase,
    path: &str,
) -> Result<TransferSummary, AppCommandError> {
    use berth_project_core::service::model_provider_export::{flatten, parse};

    let text = std::fs::read_to_string(path)
        .map_err(|error| AppCommandError::invalid_input(format!("cannot read {path}: {error}")))?;
    let document = parse(&text).map_err(AppCommandError::invalid_input)?;
    let mut seen: Vec<(String, String)> =
        crate::db::service::model_provider_service::list_all(&db.conn)
            .await
            .map_err(AppCommandError::from)?
            .into_iter()
            .map(|row| (row.name, row.api_url))
            .collect();
    let mut summary = TransferSummary {
        providers: 0,
        skipped_duplicate: 0,
    };
    for provider in document.providers {
        if seen
            .iter()
            .any(|(name, url)| *name == provider.name && *url == provider.api_url)
        {
            summary.skipped_duplicate += 1;
            continue;
        }
        let created = crate::commands::model_provider::create_model_provider_core(
            db,
            provider.name,
            provider.api_url,
            String::new(),
            provider.agent_type,
            provider.models.as_ref().map(flatten),
            provider.website,
            (!provider.agent_allowlist.is_empty()).then_some(provider.agent_allowlist),
            None,
            Some(
                provider
                    .overlays
                    .iter()
                    .map(
                        |overlay| crate::models::model_provider::ProviderOverlayInfo {
                            agent_type: overlay.agent_type.clone(),
                            models: flatten(&overlay.models),
                        },
                    )
                    .collect(),
            ),
            provider.discovery.as_ref().map(flatten),
        )
        .await?;
        seen.push((created.name, created.api_url));
        summary.providers += 1;
    }
    Ok(summary)
}

fn cc_switch_db_path() -> Result<PathBuf, AppCommandError> {
    dirs::home_dir()
        .map(|home| home.join(".cc-switch").join("cc-switch.db"))
        .ok_or_else(|| AppCommandError::task_execution_failed("home directory is unknown"))
}

/// 读出 (app_type, name, settings_config);数据库不可读时报错。
#[allow(clippy::type_complexity)]
fn read_providers_with_website(
    path: &std::path::Path,
) -> Result<Vec<(String, String, String, Option<String>)>, AppCommandError> {
    use rusqlite::OpenFlags;
    let conn = rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| {
            AppCommandError::task_execution_failed(format!(
                "failed to open cc-switch database: {error}"
            ))
        })?;
    let mut statement = conn
        .prepare("SELECT app_type, name, settings_config, website_url FROM providers")
        .map_err(|error| {
            AppCommandError::task_execution_failed(format!(
                "failed to read cc-switch providers: {error}"
            ))
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| {
            AppCommandError::task_execution_failed(format!(
                "failed to read cc-switch providers: {error}"
            ))
        })?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))
}

/// 从 settings_config 提取档案三元组 (url, key, model);提不出关键
/// 字段(url 或 key)返回 `None`。
fn extract(app_type: &str, settings_config: &str) -> Option<(String, String, Option<String>)> {
    let parsed: Value = serde_json::from_str(settings_config).ok()?;
    match app_type {
        "claude" => extract_claude(&parsed),
        "codex" => extract_codex(&parsed),
        "gemini" => extract_gemini(&parsed),
        _ => None,
    }
}

/// claude 形态:settings.json 片段,url/key/模型都在 env 段。
fn extract_claude(config: &Value) -> Option<(String, String, Option<String>)> {
    let env = config.get("env")?.as_object()?;
    let api_url = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .map(str::to_string);
    let api_key = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .or_else(|| env.get("ANTHROPIC_API_KEY"))
        .and_then(Value::as_str)
        .map(str::to_string);
    // 模型映射:ANTHROPIC_MODEL 与各档位映射 → {"name": 角色名, "id": 模型}。
    let mut models: Vec<(String, String)> = Vec::new();
    let model_keys = [
        ("ANTHROPIC_MODEL", "Main"),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet"),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus"),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL", "Fable"),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku"),
    ];
    for (env_key, role) in model_keys {
        if let Some(value) = env
            .get(env_key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            models.push((role.to_string(), value.to_string()));
        }
    }
    models.sort_by(|left, right| left.1.cmp(&right.1));
    models.dedup_by(|left, right| left.1 == right.1);
    let model_list = (!models.is_empty())
        .then(|| {
            serde_json::to_string(
                &models
                    .into_iter()
                    .map(|(name, id)| serde_json::json!({ "name": name, "id": id }))
                    .collect::<Vec<_>>(),
            )
            .ok()
        })
        .flatten();
    Some((api_url?, api_key?, model_list))
}

/// codex 形态:auth.OPENAI_API_KEY + config(TOML 字符串)里选中
/// provider 的 base_url 与顶层 model。
fn extract_codex(config: &Value) -> Option<(String, String, Option<String>)> {
    if let Some(api_key) = config
        .get("auth")
        .and_then(|auth| auth.get("OPENAI_API_KEY"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        let toml_text = config.get("config")?.as_str()?;
        let parsed: toml::Value = toml_text.parse().ok()?;
        let base_url = parsed
            .get("model_providers")
            .and_then(|providers| providers.as_table())
            .and_then(|providers| {
                providers
                    .values()
                    .find_map(|provider| provider.get("base_url").and_then(toml::Value::as_str))
            })?
            .to_string();
        let model = parsed
            .get("model")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(|model| {
                serde_json::to_string(&vec![serde_json::json!({
                    "name": model,
                    "id": model,
                })])
                .unwrap_or_default()
            })
            .filter(|list| !list.is_empty());
        return Some((base_url, api_key.to_string(), model));
    }

    if let Some(auth) = config.get("auth") {
        if auth.get("tokens").is_some() || auth.get("auth_mode").is_some() {
            let auth_json = serde_json::to_string(auth).ok()?;
            return Some((String::new(), auth_json, None));
        }
    }

    None
}

/// gemini 形态:env 里的 GEMINI_API_KEY/GOOGLE_API_KEY 与
/// GOOGLE_GEMINI_BASE_URL;官方 OAuth 记录 env 为空 → None。
fn extract_gemini(config: &Value) -> Option<(String, String, Option<String>)> {
    let env = config.get("env")?.as_object()?;
    let api_key = env
        .get("GEMINI_API_KEY")
        .or_else(|| env.get("GOOGLE_API_KEY"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let api_url = env
        .get("GOOGLE_GEMINI_BASE_URL")
        .or_else(|| env.get("GEMINI_BASE_URL"))
        .and_then(Value::as_str)
        .map(str::to_string)
        // gemini CLI 无 base_url 时用官方端点,档案里记空串。
        .unwrap_or_default();
    let model = env
        .get("GEMINI_MODEL")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((api_url, api_key?, model))
}

// ─── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_extract_reads_env_and_model_mapping() {
        let config = serde_json::json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://relay.example",
                "ANTHROPIC_AUTH_TOKEN": "sk-tok",
                "ANTHROPIC_MODEL": "m-main",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "m-sonnet",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "m-main"
            }
        });
        let (url, key, model) = extract_claude(&config).unwrap();
        assert_eq!(url, "https://relay.example");
        assert_eq!(key, "sk-tok");
        let models: Vec<serde_json::Value> = serde_json::from_str(&model.unwrap()).unwrap();
        // 同 ID 去重:Opus 与 Main 同为 m-main 只留一条;角色名做显示名。
        assert_eq!(models.len(), 2);
        assert!(models.contains(&serde_json::json!({"name":"Main","id":"m-main"})));
        assert!(models.contains(&serde_json::json!({"name":"Sonnet","id":"m-sonnet"})));
    }

    #[test]
    fn claude_extract_without_env_is_none() {
        // 预设没填 key(只有 editorMode 等)→ 跳过。
        let config = serde_json::json!({ "editorMode": "normal" });
        assert!(extract_claude(&config).is_none());
    }

    #[test]
    fn codex_extract_reads_auth_and_toml_config() {
        let config = serde_json::json!({
            "auth": { "OPENAI_API_KEY": "sk-codex" },
            "config": "model = \"qwen3.7-plus\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"bailian\"\nbase_url = \"https://coding.example.com/v1\"\n"
        });
        let (url, key, model) = extract_codex(&config).unwrap();
        assert_eq!(url, "https://coding.example.com/v1");
        assert_eq!(key, "sk-codex");
        // 比结构不比字符串：序列化后的键序受 serde_json 的 preserve_order 特性合并影响。
        let model: Value = serde_json::from_str(model.as_deref().unwrap()).unwrap();
        assert_eq!(
            model,
            serde_json::json!([{ "id": "qwen3.7-plus", "name": "qwen3.7-plus" }])
        );
    }

    #[test]
    fn codex_extract_reads_official_chatgpt_oauth() {
        let config = serde_json::json!({
            "auth": {
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": null,
                "tokens": {
                    "access_token": "acc-123",
                    "refresh_token": "ref-456"
                }
            }
        });
        let (url, key, model) = extract_codex(&config).unwrap();
        assert_eq!(url, "");
        assert!(key.contains("acc-123"));
        assert!(model.is_none());
    }

    #[test]
    fn gemini_extract_official_oauth_is_none() {
        // Google Official:env 空,提不出 key → 跳过。
        let config = serde_json::json!({ "config": { "general": {} }, "env": {} });
        assert!(extract_gemini(&config).is_none());
    }

    #[test]
    fn gemini_extract_reads_key_env() {
        let config = serde_json::json!({
            "env": { "GEMINI_API_KEY": "g-key", "GOOGLE_GEMINI_BASE_URL": "https://g.example" }
        });
        let (url, key, model) = extract_gemini(&config).unwrap();
        assert_eq!(url, "https://g.example");
        assert_eq!(key, "g-key");
        assert!(model.is_none());
    }

    #[test]
    fn app_type_mapping_covers_three_protocols() {
        assert_eq!(app_type_to_agent_type("claude"), Some("claude_code"));
        assert_eq!(app_type_to_agent_type("codex"), Some("codex"));
        assert_eq!(app_type_to_agent_type("gemini"), Some("gemini"));
        assert_eq!(app_type_to_agent_type("pi"), None);
        assert_eq!(app_type_to_agent_type("hermes"), None);
    }
}
