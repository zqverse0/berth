//! 接入点 `agent` 的宿主侧（docs/plugin-architecture.md §4）：`berth tools launch <launch.js> …`。
//!
//! 宿主做完一切 Berth 相关的事——解析并按 launchbar.json 校验启动输入、读专家表与它引用的资产、
//! 读一次性服务商档案（读完即删）、加载 `$BERTH_HOME/.env`、准备临时目录——再把结果作为
//! `LaunchContext` 交给插件的 `args` / `isNativePlugin` / `launch` 钩子（`agent.js` 引导模块）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use berth_tool_core::paths::is_valid_manifest_id;
use berth_tool_core::provider_injection::{
    LaunchProfile, LAUNCH_PROFILE_ARG, LAUNCH_PROFILE_SCHEMA,
};
use serde_json::{json, Map, Value};

use crate::script::js_string;

const BOOTSTRAP: &str = include_str!("agent.js");
const EXPERT_KEYS: [&str; 5] = ["name", "prompt", "skills", "mcp", "plugins"];

/// 调用方（berth-cli）提供、本 crate 不自己求的值。
pub struct LaunchExtras {
    /// `berth guide --brief`。
    pub brief: String,
    /// 当前项目 `{id, name, root}` 或 null（`env.project`）。
    pub project: crate::rpc::ProjectLookup,
}

/// 运行 Agent 插件；返回进程退出码。宿主侧错误打印 `launch: …` 并返回 2（同 Python 运行时）。
pub fn launch(script: &Path, argv: &[String], extras: LaunchExtras) -> i32 {
    match prepare_and_run(script, argv, extras) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("launch: {error}");
            2
        }
    }
}

fn prepare_and_run(script: &Path, argv: &[String], extras: LaunchExtras) -> Result<i32, String> {
    let script =
        std::fs::canonicalize(script).map_err(|error| format!("{}: {error}", script.display()))?;
    let package = script
        .parent()
        .ok_or("launch script has no package directory")?
        .to_path_buf();
    let home = berth_tool_core::paths::berth_home_dir();
    let host = crate::host_for(&package, extras.project)?;
    load_dotenv(&home);
    set_agent_tty();

    let mut data = json!({
        "id": host.plugin_id,
        "unattended": std::env::var_os("BERTH_TASK_RUN").is_some(),
        "brief": extras.brief,
        "remote": remote_context(),
    });
    if let [flag, expert_id] = argv {
        if flag == "--plugins" {
            // 只读：该专家的 plugins 在本 Agent 上的分流（native / skipped）。
            data["mode"] = json!("plugins");
            data["expert"] = load_expert(&home, expert_id)?;
            return run_bootstrap(host, &script, data).map(|notes| {
                println!("{notes}");
                0
            });
        }
    }
    let request = parse_argv(argv)?;
    let provider = request
        .provider_file
        .as_deref()
        .map(read_provider_file)
        .transpose()?;
    validate_inputs(&request.inputs, &package)?;
    if !request.inputs.is_empty() {
        eprintln!(
            "berth-launch-inputs: {}",
            Value::Object(request.inputs.clone())
        );
    }
    let expert = request
        .expert_id
        .as_deref()
        .map(|id| load_expert(&home, id))
        .transpose()?;
    let tmp = TempDir::create(&host.plugin_id)?;
    data["mode"] = json!("launch");
    data["inputs"] = Value::Object(request.inputs);
    data["passthrough"] = json!(request.passthrough);
    data["expert"] = expert.unwrap_or(Value::Null);
    data["provider"] = provider.unwrap_or(Value::Null);
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    data["paths"] = json!({
        "package": package.to_string_lossy(),
        "tmp": tmp.0.to_string_lossy(),
        "cwd": cwd.to_string_lossy(),
        "home": std::env::var("HOME").unwrap_or_default(),
    });
    let code = run_bootstrap(host, &script, data)?;
    Ok(code.as_i64().unwrap_or(0) as i32)
}

fn run_bootstrap(host: crate::rpc::Host, script: &Path, data: Value) -> Result<Value, String> {
    let bootstrap = BOOTSTRAP.replace(
        "\"__BERTH_PLUGIN__\"",
        &js_string(&script.to_string_lossy()),
    );
    crate::script::run(host, &bootstrap, &[("__berth_launch", data.to_string())])
}

struct LaunchRequest {
    expert_id: Option<String>,
    inputs: Map<String, Value>,
    passthrough: Vec<String>,
    provider_file: Option<PathBuf>,
}

fn parse_argv(argv: &[String]) -> Result<LaunchRequest, String> {
    let mut request = LaunchRequest {
        expert_id: None,
        inputs: Map::new(),
        passthrough: Vec::new(),
        provider_file: None,
    };
    let mut seen_inputs = false;
    let mut args = argv.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--berth-launch-inputs" => {
                let raw = args
                    .next()
                    .filter(|_| !seen_inputs)
                    .ok_or("--berth-launch-inputs requires one JSON object")?;
                request.inputs = parse_inputs(raw)?;
                seen_inputs = true;
            }
            flag if flag == LAUNCH_PROFILE_ARG => {
                let file = args
                    .next()
                    .filter(|_| request.provider_file.is_none())
                    .ok_or("--berth-provider requires one file")?;
                request.provider_file = Some(PathBuf::from(file));
            }
            "--berth-expert" => {
                let id = args
                    .next()
                    .filter(|_| request.expert_id.is_none())
                    .ok_or("--berth-expert requires one value")?;
                request.expert_id = Some(safe_id(id, "expert")?);
            }
            _ => request.passthrough.push(arg.clone()),
        }
    }
    if let Some(selected) = request.inputs.get("expert") {
        request.expert_id = Some(safe_id(selected.as_str().unwrap_or_default(), "expert")?);
    }
    Ok(request)
}

fn parse_inputs(raw: &str) -> Result<Map<String, Value>, String> {
    let Ok(Value::Object(value)) = serde_json::from_str::<Value>(raw) else {
        return Err("invalid Berth launch inputs".into());
    };
    let mut inputs = Map::new();
    for (key, item) in value {
        match item {
            Value::Null => {}
            Value::String(_) | Value::Bool(_) | Value::Number(_) if !key.is_empty() => {
                inputs.insert(key, item);
            }
            _ => return Err(format!("unsupported launch input: {key}")),
        }
    }
    Ok(inputs)
}

/// launchbar.json 是启动参数唯一来源：未声明的键报错，select 取值按 options 校验。
/// 例外：tool.json 声明的 promptInput 键（宿主输入，不是启动栏控件）。
fn validate_inputs(inputs: &Map<String, Value>, package: &Path) -> Result<(), String> {
    let launchbar = read_json(&package.join("launchbar.json"))?;
    let mut items: BTreeMap<String, Value> = launchbar["items"]
        .as_array()
        .ok_or("launchbar.json has no items")?
        .iter()
        .filter_map(|item| Some((item["id"].as_str()?.to_owned(), item.clone())))
        .collect();
    let mut manifest = read_json(&package.join("tool.json"))?;
    berth_tool_core::manifest::normalize(&mut manifest);
    if let Some(key) = manifest
        .pointer("/extensions/org.berth.agent/promptInput")
        .and_then(Value::as_str)
    {
        items.entry(key.to_owned()).or_insert(Value::Null);
    }
    let unknown: Vec<&String> = inputs
        .keys()
        .filter(|key| !items.contains_key(*key))
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "launch inputs not declared in launchbar.json: {unknown:?}"
        ));
    }
    for (key, value) in inputs {
        if let Some(options) = items[key]["options"].as_array() {
            if !options.iter().any(|option| option["value"] == *value) {
                return Err(format!("invalid {key}: {value}"));
            }
        }
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

fn safe_id(value: &str, field: &str) -> Result<String, String> {
    if is_valid_manifest_id(value) {
        Ok(value.to_owned())
    } else {
        Err(format!("{field} must be a safe asset id"))
    }
}

/// `root/relative` 必须存在且解析后仍在 root 内。
fn contained(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let resolved_root =
        std::fs::canonicalize(root).map_err(|error| format!("{}: {error}", root.display()))?;
    let candidate = std::fs::canonicalize(root.join(relative))
        .map_err(|error| format!("{}: {error}", root.join(relative).display()))?;
    if !candidate.starts_with(&resolved_root) {
        return Err(format!("asset escapes {}", root.display()));
    }
    Ok(candidate)
}

fn id_list(table: &Value, field: &str) -> Result<Vec<String>, String> {
    match &table[field] {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => items
            .iter()
            .map(|item| safe_id(item.as_str().unwrap_or_default(), field))
            .collect(),
        _ => Err(format!("{field} must be an array")),
    }
}

fn asset(path: PathBuf) -> Value {
    json!({ "name": path.file_name().unwrap_or_default().to_string_lossy(), "path": path.to_string_lossy() })
}

/// 专家表 `experts/<id>.json` → `Expert`（提示词正文、skills、展开后的 MCP、全部原生插件候选）。
fn load_expert(home: &Path, expert_id: &str) -> Result<Value, String> {
    let id = safe_id(expert_id, "expert")?;
    let table = read_json(&contained(&home.join("experts"), &format!("{id}.json"))?)?;
    let object = table.as_object().ok_or("expert table must be an object")?;
    if object
        .keys()
        .any(|key| !EXPERT_KEYS.contains(&key.as_str()))
    {
        return Err("expert table has unsupported fields".into());
    }
    let name = table["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or("expert name is required")?;
    let prompt = match table["prompt"].as_str() {
        None => Value::Null,
        Some(prompt) => {
            let path = contained(
                &home.join("prompts"),
                &format!("{}.md", safe_id(prompt, "prompt")?),
            )?;
            json!(std::fs::read_to_string(&path)
                .map_err(|error| format!("{}: {error}", path.display()))?
                .trim_end())
        }
    };
    let mut mcp = Map::new();
    for server in id_list(&table, "mcp")? {
        let spec = read_json(&contained(&home.join("mcp"), &format!("{server}.json"))?)?;
        if !spec.is_object() {
            return Err(format!("MCP {server} must be an object"));
        }
        mcp.insert(server, expand_env(spec, home)?);
    }
    let assets = |dir: &str, field: &str| -> Result<Vec<Value>, String> {
        id_list(&table, field)?
            .iter()
            .map(|item| contained(&home.join(dir), item).map(asset))
            .collect()
    };
    Ok(json!({
        "id": id,
        "name": name,
        "prompt": prompt,
        "skills": assets("skills", "skills")?,
        "mcp": mcp,
        "plugins": assets("plugins", "plugins")?,
    }))
}

/// MCP 定义里的 `"$NAME"` 换成环境变量（缺失报错），`${BERTH_HOME}` 换成资产目录。
fn expand_env(value: Value, home: &Path) -> Result<Value, String> {
    Ok(match value {
        Value::Object(map) => {
            if map.contains_key("secretRef") {
                return Err("secretRef is retired; use a complete $ENV_NAME value".into());
            }
            Value::Object(
                map.into_iter()
                    .map(|(key, item)| Ok((key, expand_env(item, home)?)))
                    .collect::<Result<_, String>>()?,
            )
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| expand_env(item, home))
                .collect::<Result<_, _>>()?,
        ),
        Value::String(text) if text.contains("${BERTH_HOME}") => {
            json!(text.replace("${BERTH_HOME}", &home.to_string_lossy()))
        }
        Value::String(text) if text.starts_with('$') => {
            let name = &text[1..];
            let valid = name
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                && name
                    .chars()
                    .all(|char| char.is_ascii_alphanumeric() || char == '_');
            if !valid {
                return Err(format!("invalid environment reference: {text}"));
            }
            json!(std::env::var(name)
                .map_err(|_| format!("required environment variable is missing: {name}"))?)
        }
        other => other,
    })
}

/// 读一次性服务商档案并立即删除（含 Key，不留磁盘）→ `Provider` 数据（`endpoint()` 在引导模块里）。
fn read_provider_file(path: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path);
    let _ = std::fs::remove_file(path);
    let raw = raw.map_err(|_| {
        format!(
            "服务商启动档案 {} 已失效（每次启动只能用一次），请从 Berth 启动栏重新启动",
            path.display()
        )
    })?;
    let profile: LaunchProfile = serde_json::from_str(&raw)
        .ok()
        .filter(|profile: &LaunchProfile| profile.schema == LAUNCH_PROFILE_SCHEMA)
        .ok_or_else(|| {
            format!("服务商启动档案不是 {LAUNCH_PROFILE_SCHEMA}，请升级 Berth 或工具包")
        })?;
    let model = profile
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned);
    let mut models: Vec<Value> = profile
        .models
        .iter()
        .filter(|item| !item.id.trim().is_empty())
        .map(|item| {
            let id = item.id.trim();
            json!({
                "id": id,
                "name": item.name.as_deref().map(str::trim).filter(|name| !name.is_empty()).unwrap_or(id),
                "slot": item.slot.as_deref().unwrap_or_default().trim().to_lowercase(),
                "api": item.api.as_deref().unwrap_or_default(),
                "endpoint": item.endpoint.as_deref().unwrap_or_default(),
                "contextWindow": item.context_window.unwrap_or(0),
                "maxOutput": item.max_output.unwrap_or(0),
            })
        })
        .collect();
    // 启动栏选中但档案里没有的模型排在最前：CLI 的模型列表总能选到它。
    if let Some(model) = &model {
        if models.iter().all(|item| item["id"] != json!(model)) {
            models.insert(0, json!({"id": model, "name": model, "slot": "", "api": "", "endpoint": "", "contextWindow": 0, "maxOutput": 0}));
        }
    }
    let endpoints: Map<String, Value> = profile
        .endpoints
        .iter()
        .filter(|(_, endpoint)| !endpoint.base_url.is_empty())
        .map(|(protocol, endpoint)| {
            (protocol.clone(), json!({"baseUrl": endpoint.base_url.trim_end_matches('/'), "apiKey": endpoint.api_key}))
        })
        .collect();
    Ok(json!({ "name": profile.name, "model": model, "models": models, "endpoints": endpoints }))
}

/// `$BERTH_HOME/.env`：只补进程里还没有的变量（MCP 定义引用的 Key 常放这里）。
fn load_dotenv(home: &Path) {
    let Ok(text) = std::fs::read_to_string(home.join(".env")) else {
        return;
    };
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let (key, value) = line.split_once('=').unwrap_or((line, ""));
        let (key, value) = (
            key.trim(),
            value
                .trim()
                .trim_matches(|char| char == '"' || char == '\''),
        );
        if !key.is_empty() && std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

/// 远程项目（宿主注入 `BERTH_REMOTE_*`）：插件把 `hookCommand` 挂到 Agent 的 shell 工具入口
/// （PreToolUse 类 hook），或用 `execCommand` 执行命令；命令转到设备上执行的逻辑全在
/// `berth remote`。本地项目为 null。
fn remote_context() -> serde_json::Value {
    match std::env::var("BERTH_REMOTE_TARGET") {
        Ok(target) if !target.is_empty() && std::env::var_os("BERTH_REMOTE_MOUNT").is_some() => {
            json!({
                "target": target,
                "hookCommand": "berth remote hook",
                "execCommand": ["berth", "remote", "exec"],
            })
        }
        _ => serde_json::Value::Null,
    }
}

/// hook 进程没有控制终端：把 Agent 所在 tty 交给 `berth group hook` 写回状态序列。
fn set_agent_tty() {
    #[cfg(unix)]
    {
        let name = unsafe { libc::ttyname(0) };
        if name.is_null() {
            std::env::remove_var("BERTH_AGENT_TTY");
        } else {
            let tty = unsafe { std::ffi::CStr::from_ptr(name) }
                .to_string_lossy()
                .into_owned();
            std::env::set_var("BERTH_AGENT_TTY", tty);
        }
    }
}

/// 本次启动的临时目录（0700），launch 结束后删除。
struct TempDir(PathBuf);

impl TempDir {
    fn create(id: &str) -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.subsec_nanos());
        let path = std::env::temp_dir().join(format!("berth-{id}-{}-{nanos}", std::process::id()));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder
            .create(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        Ok(Self(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_must_be_declared_and_match_options() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("tool.json"),
            r#"{"id":"demo","extensions":{"org.berth.agent":{"promptInput":"prompt"}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("launchbar.json"),
            r#"{"items":[{"id":"mode","options":[{"value":"a"}]},{"id":"model","optionsFrom":"providerModels"}]}"#,
        )
        .unwrap();
        let inputs = |raw: &str| parse_inputs(raw).unwrap();
        assert!(validate_inputs(
            &inputs(r#"{"mode":"a","model":"x","prompt":"hi"}"#),
            dir.path()
        )
        .is_ok());
        assert!(validate_inputs(&inputs(r#"{"mode":"b"}"#), dir.path())
            .unwrap_err()
            .contains("invalid mode"));
        assert!(validate_inputs(&inputs(r#"{"other":1}"#), dir.path())
            .unwrap_err()
            .contains("not declared"));
        assert!(parse_inputs(r#"{"x":{"nested":1}}"#).is_err());
    }

    #[test]
    fn argv_splits_berth_flags_from_passthrough() {
        let argv: Vec<String> = [
            "--berth-launch-inputs",
            r#"{"expert":"dev"}"#,
            "--resume",
            "--berth-provider",
            "/tmp/p.json",
        ]
        .iter()
        .map(|item| (*item).to_owned())
        .collect();
        let request = parse_argv(&argv).unwrap();
        assert_eq!(request.expert_id.as_deref(), Some("dev"));
        assert_eq!(request.passthrough, ["--resume"]);
        assert_eq!(request.provider_file, Some(PathBuf::from("/tmp/p.json")));
    }

    #[test]
    fn expert_assets_resolve_and_mcp_env_expands() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path();
        for dir in ["experts", "prompts", "skills/s1", "mcp", "plugins/p1"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(
            root.join("experts/dev.json"),
            r#"{"name":"Dev","prompt":"dev","skills":["s1"],"mcp":["m"],"plugins":["p1"]}"#,
        )
        .unwrap();
        std::fs::write(root.join("prompts/dev.md"), "be terse\n").unwrap();
        std::fs::write(
            root.join("mcp/m.json"),
            r#"{"command":"${BERTH_HOME}/bin/m","env":{"PATH":"$PATH"}}"#,
        )
        .unwrap();
        let expert = load_expert(root, "dev").unwrap();
        assert_eq!(expert["prompt"], json!("be terse"));
        assert_eq!(expert["skills"][0]["name"], json!("s1"));
        assert_eq!(expert["plugins"][0]["name"], json!("p1"));
        assert_eq!(
            expert["mcp"]["m"]["command"],
            json!(format!("{}/bin/m", root.display()))
        );
        assert_eq!(
            expert["mcp"]["m"]["env"]["PATH"],
            json!(std::env::var("PATH").unwrap())
        );
        std::fs::write(root.join("experts/bad.json"), r#"{"name":"Bad","extra":1}"#).unwrap();
        assert!(load_expert(root, "bad").is_err());
    }

    #[test]
    fn provider_file_is_deleted_and_selected_model_comes_first() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("p.json");
        std::fs::write(
            &file,
            r#"{"schema":"berth.provider/1","name":"relay","model":"picked","models":[{"id":"m1","slot":"OPUS"}],
               "endpoints":{"claude":{"baseUrl":"https://x/","apiKey":"k"}}}"#,
        )
        .unwrap();
        let provider = read_provider_file(&file).unwrap();
        assert!(!file.exists());
        assert_eq!(provider["models"][0]["id"], json!("picked"));
        assert_eq!(provider["models"][1]["slot"], json!("opus"));
        assert_eq!(
            provider["endpoints"]["claude"]["baseUrl"],
            json!("https://x")
        );
        assert!(read_provider_file(&file).unwrap_err().contains("已失效"));
    }

    #[test]
    fn launch_runs_plugin_hooks_end_to_end() {
        let _lock = berth_tool_core::paths::TEST_ENV_LOCK
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let home = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        std::env::set_var("BERTH_HOME", home.path());
        let package = home.path().join("tools/demo");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("tool.json"),
            r#"{"id":"demo","permissions":["process"],"requires":{"process":1}}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("launchbar.json"),
            r#"{"items":[{"id":"mode","options":[{"value":"fast"}]}]}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("launch.js"),
            r#"export default {
                 args: (inputs) => ["--mode", inputs.mode],
                 launch: (ctx) => berth.process.run("sh", ["-c", `[ "$1 $2 $3" = "--mode fast extra" ] && exit 7`, "sh", ...ctx.args]),
               }"#,
        )
        .unwrap();
        let argv: Vec<String> = ["--berth-launch-inputs", r#"{"mode":"fast"}"#, "extra"]
            .iter()
            .map(|item| (*item).to_owned())
            .collect();
        let extras = || LaunchExtras {
            brief: String::new(),
            project: Box::new(|| Value::Null),
        };
        let code = launch(&package.join("launch.js"), &argv, extras());
        let bad = launch(
            &package.join("launch.js"),
            &[
                "--berth-launch-inputs".to_owned(),
                r#"{"mode":"slow"}"#.to_owned(),
            ],
            extras(),
        );
        std::fs::write(
            package.join("tool.json"),
            r#"{"id":"demo","requires":{"process":9}}"#,
        )
        .unwrap();
        let unsupported = launch(&package.join("launch.js"), &argv, extras());
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        assert_eq!(code, 7);
        assert_eq!(bad, 2, "未声明的取值在启动前报错");
        assert_eq!(unsupported, 2, "requires 不满足时不运行");
    }
}
