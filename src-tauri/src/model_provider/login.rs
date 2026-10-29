//! 登录凭证卡：完全由 tool.json `extensions.org.berth.agent.logins` 声明生成，不落库。
//!
//! 一个声明 = 某个 Agent 可用的一个登录来源（如 Pi 的 ChatGPT 订阅）；跨包同 `id`
//! 在前端并成一张卡。Berth 只做三件事：判断凭证在不在、按声明读模型、列出卡片。
//! 不读取 / 返回 / 转发任何 token，不联网（D7 / D8）。选用登录启动时不注入任何东西，
//! CLI 用自己的登录；模型 id 自带来源前缀（如 `openai-codex/gpt-5.5`）即可区分。
//!
//! ```jsonc
//! "logins": [{
//!   "id": "chatgpt", "label": "ChatGPT 订阅", "website": "https://chatgpt.com",
//!   "credentialFile": "${home}/.pi/agent/auth.json",
//!   "credentialKey": "/openai-codex",          // 可选：该 JSON 指针存在才算有凭证
//!   "models": {                                 // 可选：不声明 = 交给 CLI 默认
//!     "path": "${home}/...json"                 // 二选一：CLI 自己写的本地文件
//!     "command": ["${berth}", "tools", "run", "<id>", "private/login-models.js"], // 或其他程序，stdout 为 JSON
//!     "listPointers": ["/models"], "idPointer": "/id", "namePointer": "/name"
//!   }
//! }]
//! ```

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model_provider::declared::resolve_home_path;

const MAX_JSON_BYTES: u64 = 2 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginDecl {
    id: String,
    label: String,
    #[serde(default)]
    website: Option<String>,
    credential_file: String,
    #[serde(default)]
    credential_key: Option<String>,
    #[serde(default)]
    models: Option<ModelsSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelsSpec {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    command: Option<Vec<String>>,
    /// 候选列表指针：按顺序取第一个命中的数组，或对象的值集合。
    list_pointers: Vec<String>,
    id_pointer: String,
    #[serde(default)]
    name_pointer: Option<String>,
    /// 声明了允许集合时，取到非允许值的条目丢弃；缺该字段的条目保留。
    #[serde(default)]
    visibility_pointer: Option<String>,
    #[serde(default)]
    visibility_allow: Vec<String>,
}

/// 一个 Agent 的一个登录来源（前端按 `login_id` 并卡）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginEntry {
    pub agent_id: String,
    pub agent_name: String,
    /// 用量查询沿用 `fetch_official_account_usage(agentType)`。
    pub agent_type: Option<String>,
    pub has_usage: bool,
    pub login_id: String,
    pub label: String,
    pub website: Option<String>,
    /// `None` = 无法判断（路径非法、读失败）。
    pub credential_present: Option<bool>,
    pub has_models: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoginModel {
    pub name: String,
    pub id: String,
    /// 用户手动添加的预选项（`login-presets.json`），可在设置页删除。
    #[serde(default)]
    pub preset: bool,
}

/// 读到的模型 ∪ 预选项。来源读取失败时仍返回预选项，`error` 如实说明原因。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoginModels {
    pub models: Vec<LoginModel>,
    pub error: Option<String>,
}

/// 预选模型存在工具包目录 `login-presets.json`（`{loginId: [{id, name}]}`），
/// 只有模型 id / 名称，不含任何凭证；不进数据库。
const PRESETS_FILE: &str = "login-presets.json";
const MAX_PRESETS: usize = 200;

type Presets = std::collections::BTreeMap<String, Vec<LoginModel>>;

fn presets_path(agent_id: &str) -> Result<PathBuf, String> {
    if !crate::tool::path::is_valid_manifest_id(agent_id) {
        return Err(format!("invalid agent id: {agent_id}"));
    }
    Ok(crate::tool::path::cli_tools_directory()
        .join(agent_id)
        .join(PRESETS_FILE))
}

fn read_presets(path: &PathBuf) -> Presets {
    read_json(path)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_value(json).ok())
        .unwrap_or_default()
}

/// 覆盖保存某个登录的预选模型（空列表 = 删除该键）。先写临时文件再改名。
pub fn save_presets(agent_id: &str, login_id: &str, models: Vec<LoginModel>) -> Result<(), String> {
    if !declarations(agent_id)
        .iter()
        .any(|decl| decl.id == login_id)
    {
        return Err(format!("login {login_id} is not declared by {agent_id}"));
    }
    let path = presets_path(agent_id)?;
    save_presets_at(&path, login_id, models)
}

fn save_presets_at(path: &PathBuf, login_id: &str, models: Vec<LoginModel>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    let cleaned: Vec<LoginModel> = models
        .into_iter()
        .filter_map(|model| {
            let id = model.id.trim().to_string();
            if id.is_empty() || id.len() > 200 || !seen.insert(id.clone()) {
                return None;
            }
            let name = match model.name.trim() {
                "" => id.clone(),
                name => name.to_string(),
            };
            Some(LoginModel {
                name,
                id,
                preset: true,
            })
        })
        .collect();
    if cleaned.len() > MAX_PRESETS {
        return Err(format!("at most {MAX_PRESETS} preset models"));
    }
    let mut presets = read_presets(path);
    if cleaned.is_empty() {
        presets.remove(login_id);
    } else {
        presets.insert(login_id.to_string(), cleaned);
    }
    let raw = serde_json::to_string_pretty(&presets).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw + "\n").map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, path).map_err(|error| error.to_string())
}

/// 预选项在前（用户明确想要的），再接读到的、去重。
fn merge_models(presets: Vec<LoginModel>, fetched: Vec<LoginModel>) -> Vec<LoginModel> {
    let mut seen = std::collections::HashSet::new();
    presets
        .into_iter()
        .map(|model| LoginModel {
            preset: true,
            ..model
        })
        .chain(fetched)
        .filter(|model| seen.insert(model.id.clone()))
        .collect()
}

fn declarations(agent_id: &str) -> Vec<LoginDecl> {
    let Some(asset) = crate::tool::asset_repository::load_tool_asset(agent_id)
        .ok()
        .flatten()
    else {
        return Vec::new();
    };
    asset
        .agent_extension()
        .and_then(|extension| extension.get("logins"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value::<LoginDecl>(item.clone()).ok())
                .filter(|decl| !decl.id.trim().is_empty() && !decl.label.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn has_usage(agent_id: &str) -> bool {
    crate::tool::asset_repository::load_tool_asset(agent_id)
        .ok()
        .flatten()
        .is_some_and(|asset| {
            asset
                .agent_extension()
                .is_some_and(|extension| extension.get("usage").is_some())
        })
}

/// 读一个受限大小的 JSON 文件；不存在返回 `Ok(None)`。
fn read_json(path: &PathBuf) -> Result<Option<Value>, String> {
    match std::fs::metadata(path) {
        Ok(meta) if !meta.is_file() => return Err("not a file".into()),
        Ok(meta) if meta.len() > MAX_JSON_BYTES => return Err("file too large".into()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// 只回答「在不在」：文件存在，且声明了 `credentialKey` 时该指针存在。
/// 内容只在内存里判断一次，不返回、不缓存。
fn credential_present(decl: &LoginDecl) -> Option<bool> {
    let path = resolve_home_path(&decl.credential_file).ok()??;
    present_at(&path, decl.credential_key.as_deref())
}

fn present_at(path: &PathBuf, key: Option<&str>) -> Option<bool> {
    let Some(key) = key else {
        return match std::fs::metadata(&path) {
            Ok(meta) => Some(meta.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
            Err(_) => None,
        };
    };
    match read_json(path) {
        Ok(Some(json)) => Some(json.pointer(key).is_some_and(|value| !value.is_null())),
        Ok(None) => Some(false),
        Err(_) => None,
    }
}

pub fn list_entries() -> Vec<LoginEntry> {
    let mut out = Vec::new();
    for profile in crate::tool::profile::list_agent_profiles() {
        let decls = declarations(&profile.id);
        if decls.is_empty() {
            continue;
        }
        let usage = has_usage(&profile.id);
        for decl in decls {
            out.push(LoginEntry {
                agent_id: profile.id.clone(),
                agent_name: profile.name.clone(),
                agent_type: profile.project_type.clone(),
                has_usage: usage,
                login_id: decl.id.clone(),
                label: decl.label.clone(),
                website: decl.website.clone(),
                credential_present: credential_present(&decl),
                has_models: decl.models.is_some(),
            });
        }
    }
    out
}

/// `${package}` → 工具包目录，`${berth}` → 同版本 berth-cli（运行包内脚本：`${berth} tools run <id> <脚本>`）；
/// 其余参数原样（不经 shell）。
fn command_argv(agent_id: &str, command: &[String]) -> Result<Vec<String>, String> {
    let package = crate::tool::path::cli_tools_directory().join(agent_id);
    let package = package.to_string_lossy();
    let berth = if command.iter().any(|arg| arg.contains("${berth}")) {
        crate::terminal::manager::runtime::resolve_cli_binary()
            .ok_or("berth-cli is missing next to Berth; reinstall Berth")?
            .to_string_lossy()
            .into_owned()
    } else {
        String::new()
    };
    let argv: Vec<String> = command
        .iter()
        .map(|arg| arg.replace("${package}", &package).replace("${berth}", &berth))
        .collect();
    if argv.first().is_none_or(|program| program.trim().is_empty()) {
        return Err("models.command must not be empty".into());
    }
    Ok(argv)
}

/// 在工具包目录里跑声明的命令（`${package}` 展开、不经 shell、超时 / 输出有上限）。
pub(crate) async fn run_package_command(
    agent_id: &str,
    command: &[String],
) -> Result<Value, String> {
    if !crate::tool::path::is_valid_manifest_id(agent_id) {
        return Err(format!("invalid agent id: {agent_id}"));
    }
    let package = crate::tool::path::cli_tools_directory().join(agent_id);
    run_command(&command_argv(agent_id, command)?, &package).await
}

async fn run_command(argv: &[String], cwd: &std::path::Path) -> Result<Value, String> {
    let mut process = crate::platform::process::tokio_command(&argv[0]);
    process
        .args(&argv[1..])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, process.output())
        .await
        .map_err(|_| "models.command timed out".to_string())?
        .map_err(|error| format!("models.command failed to start: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "models.command exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    if output.stdout.len() as u64 > MAX_JSON_BYTES {
        return Err("models.command output too large".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

pub async fn fetch_models(agent_id: &str, login_id: &str) -> Result<LoginModels, String> {
    let decl = declarations(agent_id)
        .into_iter()
        .find(|decl| decl.id == login_id)
        .ok_or_else(|| format!("login {login_id} is not declared by {agent_id}"))?;
    let presets = read_presets(&presets_path(agent_id)?)
        .remove(login_id)
        .unwrap_or_default();
    let (fetched, error) = match decl.models {
        None => (Vec::new(), None),
        Some(spec) => match read_declared(agent_id, &spec).await {
            Ok(models) => (models, None),
            Err(error) => (Vec::new(), Some(error)),
        },
    };
    Ok(LoginModels {
        models: merge_models(presets, fetched),
        error,
    })
}

async fn read_declared(agent_id: &str, spec: &ModelsSpec) -> Result<Vec<LoginModel>, String> {
    let json = match (spec.path.as_deref(), spec.command.as_deref()) {
        (Some(template), None) => {
            let path = resolve_home_path(template)?
                .ok_or_else(|| "models.path could not be resolved".to_string())?;
            read_json(&path)?.ok_or_else(|| "models file does not exist yet".to_string())?
        }
        (None, Some(command)) => run_package_command(agent_id, command).await?,
        _ => return Err("models must declare exactly one of path / command".into()),
    };
    models_from_value(spec, &json)
}

fn catalog_entries<'a>(spec: &ModelsSpec, json: &'a Value) -> Result<Vec<&'a Value>, String> {
    for pointer in &spec.list_pointers {
        let Some(value) = json.pointer(pointer) else {
            continue;
        };
        if let Some(array) = value.as_array() {
            return Ok(array.iter().collect());
        }
        if let Some(object) = value.as_object() {
            return Ok(object.values().collect());
        }
    }
    Err(format!(
        "model list pointer was not found: {}",
        spec.list_pointers.join(", ")
    ))
}

fn visible(spec: &ModelsSpec, model: &Value) -> bool {
    let Some(pointer) = spec.visibility_pointer.as_deref() else {
        return true;
    };
    if spec.visibility_allow.is_empty() {
        return true;
    }
    match model.pointer(pointer).and_then(Value::as_str) {
        Some(value) => spec.visibility_allow.iter().any(|allowed| allowed == value),
        None => true,
    }
}

pub(crate) fn models_from_value(
    spec: &ModelsSpec,
    json: &Value,
) -> Result<Vec<LoginModel>, String> {
    let name_pointer = spec.name_pointer.as_deref().unwrap_or(&spec.id_pointer);
    let mut seen = std::collections::HashSet::new();
    Ok(catalog_entries(spec, json)?
        .into_iter()
        .filter(|model| visible(spec, model))
        .filter_map(|model| {
            let id = model.pointer(&spec.id_pointer)?.as_str()?.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            Some(LoginModel {
                preset: false,
                name: model
                    .pointer(name_pointer)
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                id: id.to_string(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(value: Value) -> ModelsSpec {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn models_read_pointers_filter_hidden_and_dedupe() {
        let spec = spec(serde_json::json!({
            "path": "${home}/x.json",
            "listPointers": ["/data", "/models"],
            "idPointer": "/slug",
            "namePointer": "/display_name",
            "visibilityPointer": "/visibility",
            "visibilityAllow": ["list"]
        }));
        let json = serde_json::json!({"models": [
            {"slug": "a", "display_name": "A", "visibility": "list"},
            {"slug": "hidden", "visibility": "hide"},
            {"slug": "a"},
            {"slug": "b"}
        ]});
        let ids: Vec<_> = models_from_value(&spec, &json)
            .unwrap()
            .into_iter()
            .map(|m| (m.id, m.name))
            .collect();
        assert_eq!(
            ids,
            vec![("a".into(), "A".into()), ("b".into(), "b".into())]
        );
        assert!(models_from_value(&spec, &serde_json::json!({})).is_err());
    }

    #[test]
    fn credential_presence_checks_file_and_optional_pointer() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, r#"{"openai-codex":{"access":"secret"},"gone":null}"#).unwrap();
        assert_eq!(present_at(&file, None), Some(true));
        assert_eq!(present_at(&file, Some("/openai-codex")), Some(true));
        assert_eq!(present_at(&file, Some("/xai")), Some(false));
        assert_eq!(present_at(&file, Some("/gone")), Some(false));
        let missing = dir.path().join("missing.json");
        assert_eq!(present_at(&missing, None), Some(false));
        assert_eq!(present_at(&missing, Some("/x")), Some(false));
    }

    #[tokio::test]
    async fn command_source_runs_without_shell_and_parses_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec(serde_json::json!({
            "command": ["python3", "-c", "print('{\"models\":[{\"id\":\"p/m\"}]}')"],
            "listPointers": ["/models"],
            "idPointer": "/id"
        }));
        let json = run_command(spec.command.as_deref().unwrap(), dir.path())
            .await
            .unwrap();
        assert_eq!(models_from_value(&spec, &json).unwrap()[0].id, "p/m");
        let failed = run_command(
            &["python3".into(), "-c".into(), "exit(3)".into()],
            dir.path(),
        )
        .await;
        assert!(failed.is_err());
    }

    #[test]
    fn presets_save_merge_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PRESETS_FILE);
        let model = |id: &str| LoginModel {
            name: String::new(),
            id: id.into(),
            preset: false,
        };
        save_presets_at(
            &path,
            "chatgpt",
            vec![model(" gpt-x "), model("gpt-x"), model("")],
        )
        .unwrap();
        save_presets_at(&path, "xai", vec![model("grok-y")]).unwrap();
        let presets = read_presets(&path);
        assert_eq!(
            presets["chatgpt"],
            vec![LoginModel {
                name: "gpt-x".into(),
                id: "gpt-x".into(),
                preset: true
            }]
        );

        let merged = merge_models(
            presets["chatgpt"].clone(),
            vec![model("gpt-x"), model("gpt-z")],
        );
        assert_eq!(
            merged
                .iter()
                .map(|m| (m.id.as_str(), m.preset))
                .collect::<Vec<_>>(),
            [("gpt-x", true), ("gpt-z", false)]
        );

        save_presets_at(&path, "chatgpt", vec![]).unwrap();
        let presets = read_presets(&path);
        assert!(!presets.contains_key("chatgpt") && presets.contains_key("xai"));
    }
}
