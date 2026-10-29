//! `launchbar(request)` — 启动栏 / Agent 设置页共用的文件通道。
//!
//! 职责：
//! - `load`：读取 `tools/<agent>/launchbar.json`（启动栏唯一 UI 声明）。
//!   本命令只做边界防守：目录名校验、文件大小上限、JSON 解析；
//!   `optionsFrom: "experts"` 在加载时填入 `$BERTH_HOME/experts/*.json`。
//!   组件白名单由前端注册表执行。文件不存在或损坏时返回诊断而非错误。
//!   不投影 `tool.json` views，不拼目标 CLI argv。
//! - `list_agents`：列出所有 agent 工具目录（详见 `tool::profile`）。

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::tool::path::{cli_tools_directory, is_valid_manifest_id};

/// 单份 launchbar.json 上限。手写 UI 配置远小于此。
const MAX_LAUNCHBAR_BYTES: u64 = 1024 * 1024;

// ─── Requests / responses ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LaunchbarRequest {
    /// 读取 `<tools>/<agent>/launchbar.json`（每次直读，无缓存）。
    Load { agent: String },
    /// 列出所有可投影为 Agent 的 `tool.json` 资产。
    ListAgents,
    /// 读取 `<tools>/<agent>/icon.svg|icon.png` 为 data URL。
    LoadIcon { agent: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LaunchbarResponse {
    File {
        file: LaunchbarFile,
    },
    Agents {
        agents: Vec<crate::tool::profile::AgentProfileSummary>,
        /// tools 根目录（设置页「打开目录」用）。
        directory: String,
    },
    Icon {
        data_url: Option<String>,
    },
}

/// `config` 为 `None` 时 `diagnostics` 说明原因。文件不存在是 warning。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchbarFile {
    pub agent: String,
    pub config: Option<serde_json::Value>,
    pub diagnostics: Vec<LaunchbarDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchbarDiagnostic {
    pub severity: String,
    pub message: String,
}

// ─── Seam dispatch ────────────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn launchbar(request: LaunchbarRequest) -> Result<LaunchbarResponse, AppCommandError> {
    match request {
        LaunchbarRequest::Load { agent } => Ok(LaunchbarResponse::File {
            file: load(&agent)?,
        }),
        LaunchbarRequest::ListAgents => Ok(LaunchbarResponse::Agents {
            agents: crate::tool::profile::list_agent_profiles(),
            directory: cli_tools_directory().to_string_lossy().into_owned(),
        }),
        LaunchbarRequest::LoadIcon { agent } => Ok(LaunchbarResponse::Icon {
            data_url: load_icon(&agent)?,
        }),
    }
}

const MAX_ICON_BYTES: u64 = 1024 * 1024;
const ICON_FILES: &[(&str, &str)] = &[("icon.svg", "image/svg+xml"), ("icon.png", "image/png")];

fn load_icon(agent: &str) -> Result<Option<String>, AppCommandError> {
    if !is_valid_manifest_id(agent) {
        return Err(AppCommandError::invalid_input(
            "icon agent directory must match [a-z0-9][a-z0-9._-]* (max 128 chars)",
        ));
    }
    let dir = cli_tools_directory().join(agent);
    for (file_name, mime) in ICON_FILES {
        let path = dir.join(file_name);
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(AppCommandError::io)?;
        let encoded = base64_encode(&bytes);
        return Ok(Some(format!("data:{mime};base64,{encoded}")));
    }
    Ok(None)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

fn load(agent: &str) -> Result<LaunchbarFile, AppCommandError> {
    if !is_valid_manifest_id(agent) {
        return Err(AppCommandError::invalid_input(
            "launchbar agent directory must match [a-z0-9][a-z0-9._-]* (max 128 chars)",
        ));
    }
    let path = cli_tools_directory().join(agent).join("launchbar.json");
    let not_found = || LaunchbarFile {
        agent: agent.to_string(),
        config: None,
        diagnostics: vec![LaunchbarDiagnostic {
            severity: "warning".to_string(),
            message: format!("no launchbar.json for agent '{agent}'"),
        }],
    };
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(not_found()),
        Err(error) => return Err(AppCommandError::io(error)),
    };
    if metadata.len() > MAX_LAUNCHBAR_BYTES {
        return Ok(LaunchbarFile {
            agent: agent.to_string(),
            config: None,
            diagnostics: vec![LaunchbarDiagnostic {
                severity: "error".to_string(),
                message: format!(
                    "launchbar.json exceeds the {MAX_LAUNCHBAR_BYTES} byte size limit"
                ),
            }],
        });
    }
    let bytes = std::fs::read(&path).map_err(AppCommandError::io)?;
    let mut config = match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return Ok(LaunchbarFile {
                agent: agent.to_string(),
                config: None,
                diagnostics: vec![LaunchbarDiagnostic {
                    severity: "error".to_string(),
                    message: format!("launchbar.json is not valid JSON: {error}"),
                }],
            });
        }
    };
    fill_expert_options(&mut config)?;
    Ok(LaunchbarFile {
        agent: agent.to_string(),
        config: Some(config),
        diagnostics: Vec::new(),
    })
}

/// 无人值守启动（任务定时）用的启动输入：各项声明的 `unattended` 值（如跳过审批的那一档）。
/// 一项都没声明的 Agent 返回 `None`，不能无人值守。
pub(crate) fn unattended_inputs(
    agent: &str,
) -> Result<Option<std::collections::BTreeMap<String, serde_json::Value>>, AppCommandError> {
    let Some(config) = load(agent)?.config else {
        return Ok(None);
    };
    Ok(unattended_of(&config))
}

fn unattended_of(
    config: &serde_json::Value,
) -> Option<std::collections::BTreeMap<String, serde_json::Value>> {
    let inputs: std::collections::BTreeMap<String, serde_json::Value> = config
        .get("items")?
        .as_array()?
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            let value = item.get("unattended")?.as_str()?;
            Some((id.to_owned(), serde_json::Value::String(value.to_owned())))
        })
        .collect();
    (!inputs.is_empty()).then_some(inputs)
}

/// `optionsFrom: "experts"` 在加载时填入当前 BERTH_HOME/experts 文件列表。
/// 启动栏只展示选项；选中值随 typed inputs 交给启动脚本。
fn fill_expert_options(config: &mut serde_json::Value) -> Result<(), AppCommandError> {
    let Some(items) = config
        .get_mut("items")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return Ok(());
    };
    let mut options = None;
    for item in items {
        if item.get("optionsFrom").and_then(serde_json::Value::as_str) != Some("experts") {
            continue;
        }
        if options.is_none() {
            options = Some(expert_options()?);
        }
        item["options"] = serde_json::Value::Array(options.clone().unwrap_or_default());
    }
    Ok(())
}

pub(crate) fn expert_options() -> Result<Vec<serde_json::Value>, AppCommandError> {
    let experts = berth_tool_core::paths::experts(&crate::platform::paths::berth_home_dir())
        .map_err(AppCommandError::configuration_invalid)?;
    Ok(experts
        .into_iter()
        .map(|(value, label)| serde_json::json!({ "value": value, "label": label }))
        .collect())
}

// ─── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unattended_inputs_collect_declared_values_only() {
        let config = serde_json::json!({"items": [
            {"id": "sandbox", "unattended": "bypass-all"},
            {"id": "model"},
        ]});
        let inputs = unattended_of(&config).unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs["sandbox"], "bypass-all");
        assert!(unattended_of(&serde_json::json!({"items": [{"id": "model"}]})).is_none());
    }
    use crate::tool::path::TEST_ENV_LOCK;
    use std::path::PathBuf;

    fn with_temp_berth_home(test: impl FnOnce(PathBuf)) {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let dir = std::env::temp_dir().join(format!("launchbar-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        std::env::set_var("BERTH_HOME", &dir);
        test(dir.clone());
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_reads_launchbar_json_as_ui_config() {
        with_temp_berth_home(|home| {
            let dir = home.join("tools/demo");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("launchbar.json"),
                r#"{
                  "version": 1,
                  "items": [
                    {
                      "id": "sandbox",
                      "component": "select",
                      "label": "沙箱",
                      "options": [
                        { "value": "read-only", "label": "只读" }
                      ]
                    },
                    { "id": "provider", "component": "select", "label": "服务商",
                      "optionsFrom": "providerVendor" }
                  ]
                }"#,
            )
            .unwrap();

            let file = load("demo").unwrap();
            assert!(file.diagnostics.is_empty());
            let items = file.config.unwrap()["items"].as_array().unwrap().clone();
            assert_eq!(items.len(), 2);
            assert_eq!(items[0]["id"], "sandbox");
            assert_eq!(items[0]["options"][0]["value"], "read-only");
            assert_eq!(items[1]["optionsFrom"], "providerVendor");
        });
    }

    #[test]
    fn experts_options_from_reads_current_berth_home_entries() {
        with_temp_berth_home(|home| {
            let experts = home.join("experts");
            std::fs::create_dir_all(&experts).unwrap();
            std::fs::write(
                experts.join("backend.json"),
                r#"{ "name": "后端开发专家" }"#,
            )
            .unwrap();
            std::fs::write(
                experts.join("frontend.json"),
                r#"{ "name": "前端开发专家" }"#,
            )
            .unwrap();
            let dir = home.join("tools/demo");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("launchbar.json"),
                r#"{
                  "version": 1,
                  "items": [
                    { "id": "expert", "component": "select", "label": "专家",
                      "optionsFrom": "experts" }
                  ]
                }"#,
            )
            .unwrap();

            let file = load("demo").unwrap();
            assert_eq!(
                file.config.unwrap()["items"][0]["options"],
                serde_json::json!([
                    { "value": "backend", "label": "后端开发专家" },
                    { "value": "frontend", "label": "前端开发专家" }
                ])
            );
        });
    }

    #[test]
    fn missing_launchbar_json_is_warning_not_error() {
        with_temp_berth_home(|_home| {
            let file = load("ghost").unwrap();
            assert!(file.config.is_none());
            assert_eq!(file.diagnostics[0].severity, "warning");
            assert!(file.diagnostics[0].message.contains("no launchbar.json"));
        });
    }

    #[test]
    fn invalid_launchbar_json_is_error_diagnostic() {
        with_temp_berth_home(|home| {
            let dir = home.join("tools/broken");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("launchbar.json"), b"not json").unwrap();
            let file = load("broken").unwrap();
            assert!(file.config.is_none());
            assert_eq!(file.diagnostics[0].severity, "error");
            assert!(file.diagnostics[0].message.contains("not valid JSON"));
        });
    }

    #[test]
    fn load_icon_returns_data_url_and_none_when_absent() {
        with_temp_berth_home(|home| {
            let dir = home.join("tools/demo");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("icon.svg"), b"<svg/>").unwrap();
            let data_url = load_icon("demo").unwrap().unwrap();
            assert!(data_url.starts_with("data:image/svg+xml;base64,"));
            assert!(load_icon("ghost").unwrap().is_none());
        });
    }
}
