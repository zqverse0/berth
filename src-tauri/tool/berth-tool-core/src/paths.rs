//! 工具资产目录根与 id 规则的唯一实现（09-10 design D3：路径根由一处
//! 公共实现提供，调用者不得各自猜测）。
//!
//! 桌面 `crate::paths::{berth_home_dir, cli_tools_root}` 与 CLI 都委托到
//! 这里。规则：`$BERTH_HOME`（非空）优先，否则 `~/.berth`；tools 根跟随
//! `berth_home_dir`（用户可维护资源），**不**跟随 `BERTH_DATA_DIR`——后者
//! 是应用数据根，桌面启动会把它覆盖为 Tauri `app_data_dir()`，若跟随会
//! 把工具静默搬离用户目录布局（迁移前 rationale，见 paths.rs 原注释）。

use std::path::{Path, PathBuf};

use crate::error::ToolCoreError;

/// Test isolation: tests override `BERTH_HOME`; the lock keeps concurrent
/// test threads from racing on the shared environment variable。两宿主的
/// 测试经同一 static 互斥（桌面侧经 `tool::path` 再导出引用）。
pub static TEST_ENV_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

const BERTH_DIR_NAME: &str = ".berth";
const CLI_TOOLS_DIR_NAME: &str = "tools";
const MANIFEST_FILE_EXTENSION: &str = "json";

/// `BERTH_HOME` 覆盖名（两宿主共用）。
pub const BERTH_HOME_ENV: &str = "BERTH_HOME";

/// `$BERTH_HOME` if set (and non-empty), else `~/.berth/`.
///
/// Returns the relative `.berth` path when no home directory is available;
/// callers must still handle creation failures gracefully.
pub fn berth_home_dir() -> PathBuf {
    if let Some(custom) = std::env::var_os(BERTH_HOME_ENV).filter(|value| !value.is_empty()) {
        return PathBuf::from(custom);
    }
    dirs::home_dir()
        .map(|home| home.join(BERTH_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(BERTH_DIR_NAME))
}

/// Root directory for CLI Tool Manifests and tool asset dirs:
/// `$BERTH_HOME/tools`, else `~/.berth/tools`.
pub fn tools_root() -> PathBuf {
    berth_home_dir().join(CLI_TOOLS_DIR_NAME)
}

/// The derived, disposable index file name (not a manifest itself).
pub const INDEX_FILE_NAME: &str = "index.json";

/// `stableId` pattern from the manifest schema: `^[a-z0-9][a-z0-9._-]*$`,
/// max 128 chars. Manifests are stored as `<id>.json`, so the id doubles as
/// a safe file name component.
pub fn is_valid_manifest_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-')
    })
}

pub fn manifest_file_path(id: &str) -> Result<PathBuf, ToolCoreError> {
    if !is_valid_manifest_id(id) {
        return Err(ToolCoreError::invalid_input(
            "CLI manifest id must match [a-z0-9][a-z0-9._-]* (max 128 chars)",
        ));
    }
    Ok(tools_root().join(format!("{id}.{MANIFEST_FILE_EXTENSION}")))
}

pub fn index_file_path() -> PathBuf {
    tools_root().join(INDEX_FILE_NAME)
}

/// Extract a manifest id from a `<id>.json` file name, or `None` when the
/// name is not a valid manifest file name (including `index.json`).
pub fn file_name_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if name == INDEX_FILE_NAME {
        return None;
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some(MANIFEST_FILE_EXTENSION) {
        return None;
    }
    let id = path.file_stem()?.to_str()?.to_string();
    is_valid_manifest_id(&id).then_some(id)
}

pub fn is_regular_manifest_file(path: &Path) -> std::io::Result<bool> {
    Ok(std::fs::symlink_metadata(path)?.file_type().is_file())
}

/// Agent 启动脚本名：由 berth-cli 内嵌引擎运行（`berth tools launch <脚本>`）。
pub const LAUNCH_SCRIPT: &str = "launch.js";

/// pane 启动命令里的启动脚本：`berth-cli tools launch <tools>/<id>/launch.js …`（桌面与 CLI 同形）。
/// 只看这个位置，参数里的路径不算。
fn launch_script_arg(command: &[String]) -> Option<&Path> {
    let via_cli = command.get(1).is_some_and(|arg| arg == "tools") && command.get(2).is_some_and(|arg| arg == "launch");
    via_cli.then(|| command.get(3).map(Path::new)).flatten().filter(|path| path.file_name().is_some_and(|file| file == LAUNCH_SCRIPT))
}

/// 从 pane 启动命令取出 Agent 工具 `<id>`；宿主据此认出 Agent pane，门铃只往 Agent pane 粘贴正文。
pub fn launch_tool_id(command: &[String]) -> Option<String> {
    let tool_dir = launch_script_arg(command)?.parent()?;
    if tool_dir.parent()?.file_name()? != "tools" {
        return None;
    }
    Some(tool_dir.file_name()?.to_str()?.to_owned())
}

/// 新会话也在启动时定好 id：`projectSessions` 项声明 `"assignNew": true`（launch.js 能用指定 id 新建会话）
/// 且这次没选会话时，填一个新 id。启动命令里就带着它（`launch_session_id` 读得出），
/// 同目录多个同款 Agent 时 Berth 不必按时间猜哪个会话文件属于哪个终端。
pub fn assign_launch_session(
    tool_dir: &Path,
    inputs: &mut std::collections::BTreeMap<String, serde_json::Value>,
) {
    let Some(config) = std::fs::read(tool_dir.join("launchbar.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return;
    };
    let Some(key) = config["items"].as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item["optionsFrom"] == "projectSessions" && item["assignNew"] == true)?
            ["id"]
            .as_str()
    }) else {
        return;
    };
    let chosen = inputs
        .get(key)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| !id.trim().is_empty());
    if !chosen {
        inputs.insert(
            key.to_owned(),
            serde_json::Value::String(uuid::Uuid::new_v4().to_string()),
        );
    }
}

/// Agent 启动契约（桌面与 CLI 同一份）：`<tools>/<id>/launch.js` 必须是 tools 根内的文件，
/// 输入先分配启动会话（[`assign_launch_session`]）再序列化成 `--berth-launch-inputs` 载荷。
/// 返回 (脚本绝对路径, 载荷)；没有启动脚本为 `Ok(None)`。环境变量由调用方决定。
pub fn launch_script(
    tools_root: &Path,
    id: &str,
    mut inputs: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<Option<(PathBuf, String)>, String> {
    if !is_valid_manifest_id(id) {
        return Ok(None);
    }
    let script = tools_root.join(id).join(LAUNCH_SCRIPT);
    if !script.is_file() {
        return Ok(None);
    }
    let script = std::fs::canonicalize(&script).map_err(|error| error.to_string())?;
    let root = std::fs::canonicalize(tools_root).map_err(|error| error.to_string())?;
    if !script.starts_with(&root) {
        return Err("launch script escapes the tools directory".into());
    }
    if let Some(tool_dir) = script.parent() {
        assign_launch_session(tool_dir, &mut inputs);
    }
    let payload = serde_json::to_string(&inputs)
        .map_err(|error| format!("launch inputs are not JSON: {error}"))?;
    Ok(Some((script, payload)))
}

/// launch.js 启动时启动栏选中的输入（`--berth-launch-inputs` 的 JSON 对象，如专家、模型）。
pub fn launch_inputs(command: &[String]) -> Option<serde_json::Value> {
    launch_tool_id(command)?;
    let payload = command
        .windows(2)
        .find(|args| args[0] == "--berth-launch-inputs")?;
    serde_json::from_str::<serde_json::Value>(&payload[1])
        .ok()
        .filter(serde_json::Value::is_object)
}

/// 启动栏明确选择的会话：只认 `projectSessions`，不猜输入键或 Agent 品牌。
pub fn launch_session_id(command: &[String]) -> Option<String> {
    launch_tool_id(command)?;
    let script = launch_script_arg(command)?;
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(script.parent()?.join("launchbar.json")).ok()?,
    )
    .ok()?;
    let inputs = launch_inputs(command)?;
    let mut sessions = config["items"]
        .as_array()?
        .iter()
        .filter(|item| item["optionsFrom"] == "projectSessions")
        .filter_map(|item| inputs.get(item["id"].as_str()?)?.as_str())
        .filter(|id| !id.trim().is_empty());
    let id = sessions.next()?;
    sessions.all(|other| other == id).then(|| id.to_owned())
}

/// `<home>/experts/*.json` 里的专家：（id = 文件名，显示名 = `name`，没有就是 id），按 id 排序。
/// 启动栏 `optionsFrom: "experts"`、`berth project . expert` 共用。目录不存在时为空。
pub fn experts(home: &Path) -> Result<Vec<(String, String)>, String> {
    const MAX_FILES: usize = 512;
    const MAX_FILE_BYTES: u64 = 1024 * 1024;
    let Ok(root) = home.canonicalize() else {
        return Ok(Vec::new());
    };
    let Ok(directory) = root.join("experts").canonicalize() else {
        return Ok(Vec::new());
    };
    if !directory.starts_with(&root) {
        return Err("experts directory escapes BERTH_HOME".to_owned());
    }
    let mut paths = std::fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    if paths.len() > MAX_FILES {
        return Err(format!("experts contains more than {MAX_FILES} JSON files"));
    }
    let mut experts = Vec::with_capacity(paths.len());
    for path in paths {
        let resolved = path.canonicalize().map_err(|error| error.to_string())?;
        if !resolved.starts_with(&directory) {
            return Err("experts entry escapes its declared directory".to_owned());
        }
        let metadata = resolved.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        let Some(id) = resolved.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_valid_manifest_id(id) {
            continue;
        }
        let bytes = std::fs::read(&resolved).map_err(|error| error.to_string())?;
        let document: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("experts entry {} is invalid JSON: {error}", resolved.display()))?;
        let name = document
            .pointer("/name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(id);
        experts.push((id.to_owned(), name.to_owned()));
    }
    Ok(experts)
}

/// 启动栏选中的专家：只认 `optionsFrom: "experts"` 声明的那一项，不猜输入键。
pub fn launch_expert(tool_dir: &Path, inputs: &serde_json::Value) -> Option<String> {
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(tool_dir.join("launchbar.json")).ok()?).ok()?;
    config["items"]
        .as_array()?
        .iter()
        .filter(|item| item["optionsFrom"] == "experts")
        .find_map(|item| inputs.get(item["id"].as_str()?)?.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// pane 启动命令（`… tools launch launch.js --berth-launch-inputs <json>`）里选中的专家；群成员名就是它。
pub fn launch_command_expert(command: &[String]) -> Option<String> {
    launch_expert(launch_script_arg(command)?.parent()?, &launch_inputs(command)?)
}

/// 启动栏「专家」项的输入键（`optionsFrom: "experts"`）；`spawn --expert` 据此填启动输入。
pub fn expert_input(tool_dir: &Path) -> Option<String> {
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(tool_dir.join("launchbar.json")).ok()?).ok()?;
    config["items"]
        .as_array()?
        .iter()
        .find(|item| item["optionsFrom"] == "experts")?["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// 只有启动输入、不知道是哪个工具时（pane 里的 `BERTH_LAUNCH_INPUTS`）：任一工具的「专家」项选中的专家。
pub fn launch_expert_any(tools_root: &Path, inputs: &serde_json::Value) -> Option<String> {
    std::fs::read_dir(tools_root).ok()?.flatten().find_map(|entry| launch_expert(&entry.path(), inputs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_session_is_only_taken_from_declared_project_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = tmp.path().join("tools/demo");
        std::fs::create_dir_all(&tool).unwrap();
        std::fs::write(
            tool.join("launchbar.json"),
            r#"{"items":[{"id":"history","optionsFrom":"projectSessions"}]}"#,
        )
        .unwrap();
        let command = |payload: &str| {
            vec![
                "berth-cli".into(),
                "tools".into(),
                "launch".into(),
                tool.join("launch.js").to_string_lossy().into_owned(),
                "--berth-launch-inputs".into(),
                payload.into(),
            ]
        };
        assert_eq!(
            launch_session_id(&command(r#"{"history":"native-1"}"#)),
            Some("native-1".into())
        );
        for payload in [r#"{"history":""}"#, r#"{"session":"native-1"}"#, "not-json"] {
            assert_eq!(launch_session_id(&command(payload)), None);
        }
        // 启动输入原样可读（成员详情显示专家、模型）；不是对象或不是 launch.js 启动的没有。
        assert_eq!(
            launch_inputs(&command(r#"{"expert":"coach","model":"m"}"#)),
            Some(serde_json::json!({"expert": "coach", "model": "m"}))
        );
        assert_eq!(launch_inputs(&command("[1]")), None);
        assert_eq!(launch_inputs(&["bash".into()]), None);
    }

    #[test]
    fn launch_expert_reads_only_the_declared_experts_input() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("launchbar.json"),
            r#"{"items":[{"id":"model","optionsFrom":"providerModels"},{"id":"persona","optionsFrom":"experts"}]}"#,
        )
        .unwrap();
        let expert = |inputs| launch_expert(tmp.path(), &inputs);
        assert_eq!(expert(serde_json::json!({"persona": "dev-expert"})), Some("dev-expert".into()));
        assert_eq!(expert(serde_json::json!({"persona": " "})), None);
        assert_eq!(expert(serde_json::json!({"expert": "dev-expert"})), None);
        assert_eq!(expert_input(tmp.path()).as_deref(), Some("persona"));

        // 从 pane 的启动命令读：工具目录取自 launch.js 所在目录。
        let launch = |script: &str, payload: &str| {
            vec!["berth-cli".into(), "tools".into(), "launch".into(), script.to_owned(), "--berth-launch-inputs".into(), payload.into()]
        };
        let script = tmp.path().join("launch.js").to_string_lossy().into_owned();
        let command = |payload: &str| launch(&script, payload);
        assert_eq!(launch_command_expert(&command(r#"{"persona":"dev-expert"}"#)), None, "不在 tools/ 下不算 launch.js 启动");
        let tools = tmp.path().join("tools/demo");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::copy(tmp.path().join("launchbar.json"), tools.join("launchbar.json")).unwrap();
        let script = tools.join("launch.js").to_string_lossy().into_owned();
        let command = |payload: &str| launch(&script, payload);
        assert_eq!(launch_command_expert(&command(r#"{"persona":"dev-expert"}"#)).as_deref(), Some("dev-expert"));
        assert_eq!(launch_command_expert(&command(r#"{"persona":""}"#)), None);
    }

    #[test]
    fn a_new_session_gets_its_id_at_launch_only_when_declared() {
        let tmp = tempfile::tempdir().unwrap();
        let write = |items: &str| {
            std::fs::write(tmp.path().join("launchbar.json"), format!(r#"{{"items":{items}}}"#))
                .unwrap()
        };
        let assigned = |inputs: &[(&str, &str)]| {
            let mut inputs = inputs
                .iter()
                .map(|(key, value)| (key.to_string(), serde_json::json!(value)))
                .collect();
            assign_launch_session(tmp.path(), &mut inputs);
            inputs
        };
        write(r#"[{"id":"session","optionsFrom":"projectSessions","assignNew":true}]"#);
        let fresh = assigned(&[]);
        let id = fresh["session"].as_str().unwrap();
        assert_eq!(id.len(), 36);
        assert_ne!(assigned(&[])["session"], fresh["session"]);
        // 选了旧会话就照用；空字符串算没选。
        assert_eq!(assigned(&[("session", "old-1")])["session"], "old-1");
        assert_eq!(assigned(&[("session", " ")])["session"].as_str().unwrap().len(), 36);
        // 没声明 assignNew 的工具不动。
        write(r#"[{"id":"session","optionsFrom":"projectSessions"}]"#);
        assert!(assigned(&[]).is_empty());
    }

    #[test]
    fn manifest_id_rules_match_schema_stable_id() {
        assert!(is_valid_manifest_id("claude-code"));
        assert!(is_valid_manifest_id("a"));
        assert!(is_valid_manifest_id("0a._-"));
        assert!(!is_valid_manifest_id(""));
        assert!(!is_valid_manifest_id("A"));
        assert!(!is_valid_manifest_id("-lead"));
        assert!(!is_valid_manifest_id("has space"));
        assert!(!is_valid_manifest_id(&"x".repeat(129)));
    }

    #[test]
    fn file_name_id_extracts_valid_ids_and_skips_index() {
        assert_eq!(
            file_name_id(Path::new("claude-code.json")),
            Some("claude-code".to_string())
        );
        assert_eq!(file_name_id(Path::new("index.json")), None);
        assert_eq!(file_name_id(Path::new("claude-code.txt")), None);
        assert_eq!(file_name_id(Path::new("Bad.json")), None);
    }

    #[test]
    fn tools_root_follows_berth_home_override() {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os(BERTH_HOME_ENV);
        std::env::set_var(BERTH_HOME_ENV, "/tmp/berth-core-path-test");
        assert_eq!(
            tools_root(),
            PathBuf::from("/tmp/berth-core-path-test/tools")
        );
        match previous {
            Some(value) => std::env::set_var(BERTH_HOME_ENV, value),
            None => std::env::remove_var(BERTH_HOME_ENV),
        }
    }

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn launch_tool_id_reads_the_tools_directory_name() {
        let js = argv(&["/usr/bin/berth-cli", "tools", "launch", "/home/u/.berth/tools/demo-agent/launch.js", "--berth-launch-inputs", "{}"]);
        assert_eq!(launch_tool_id(&js).as_deref(), Some("demo-agent"));
        assert_eq!(launch_inputs(&js), Some(serde_json::json!({})));
    }

    #[test]
    fn launch_tool_id_ignores_other_commands() {
        assert_eq!(launch_tool_id(&argv(&["/bin/bash"])), None);
        assert_eq!(launch_tool_id(&argv(&["berth-cli", "tools", "launch", "/tmp/demo/launch.js"])), None);
        // 只看脚本位置，参数里的路径不算；旧的 python3 launch.py 不再认。
        assert_eq!(launch_tool_id(&argv(&["vim", "notes", "/x/tools/demo/launch.js"])), None);
        assert_eq!(launch_tool_id(&argv(&["python3", "/x/tools/demo/launch.py"])), None);
        assert_eq!(launch_tool_id(&argv(&["berth-cli", "tools", "run", "/x/tools/demo/launch.js"])), None);
    }
}
