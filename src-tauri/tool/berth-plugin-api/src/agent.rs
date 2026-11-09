//! 接入点 `agent` 的宿主侧（docs/plugin-architecture.md §4）：`berth tools launch <launch.js> …`。
//!
//! 宿主做完一切 Berth 相关的事——解析并按 launchbar.json 校验启动输入、读专家表与它引用的资产、
//! 读一次性服务商档案（读完即删）、加载 `$BERTH_HOME/.env`、准备临时目录——再把结果作为
//! `LaunchContext` 交给插件的 `args` / `isNativePlugin` / `launch` 钩子（`agent.js` 引导模块）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use berth_tool_core::experts;
use berth_tool_core::paths::is_valid_manifest_id;
use berth_tool_core::provider_injection::{
    LaunchProfile, LAUNCH_PROFILE_ARG, LAUNCH_PROFILE_SCHEMA,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::script::js_string;

const BOOTSTRAP: &str = include_str!("agent.js");
/// 启动清单文件路径的环境变量：交给 Agent，也是 `write_manifest` 的落点。
pub const LAUNCH_MANIFEST_ENV: &str = "BERTH_LAUNCH_MANIFEST";
/// 只保留最近这么多份启动清单。
const MANIFEST_KEEP: usize = 200;

/// 调用方（berth-cli）提供、本 crate 不自己求的值。
pub struct LaunchExtras {
    /// 求 `berth guide --brief`；只在选了内置专家（Berth 助手）时调用，其他 Agent 干净启动。
    pub brief: fn() -> String,
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
        "brief": "",
    });
    if let [flag, id] = argv {
        if flag == "--inspect" {
            // 只读：对某份启动清单运行插件的 inspect 钩子。
            let id = safe_id(id, "manifest")?;
            let file = experts::launches_dir(&home).join(format!("{id}.json"));
            let result = inspect_with(host, &script, &read_json(&file)?)?;
            println!("{result}");
            return Ok(0);
        }
    }
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
    let expert = request
        .expert_id
        .as_deref()
        .map(|id| load_expert(&home, id))
        .transpose()?;
    sweep_stale_temp_dirs(&std::env::temp_dir());
    let tmp = TempDir::create(&host.plugin_id)?;
    if request.expert_id.as_deref() == Some(berth_tool_core::builtin::EXPERT) {
        data["brief"] = json!((extras.brief)());
    }
    data["mode"] = json!("launch");
    data["manifest"] = prepare_manifest(&home, &request.inputs, &package, expert.as_ref())?;
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

/// 对一份启动清单运行插件可选的 `inspect` 钩子，核对声明与实际：`{implemented, items}`。
/// 没有实现时 `implemented` 为假，界面显示「未验证」。只给清单里的名字和路径，不给 MCP 定义和密钥。
pub fn inspect(
    home: &Path,
    manifest: &Value,
    project: crate::rpc::ProjectLookup,
) -> Result<Value, String> {
    let agent = manifest["agent"].as_str().unwrap_or_default();
    let agent = safe_id(agent, "agent")?;
    berth_tool_core::plugins::ensure_enabled(&agent).map_err(|error| error.to_string())?;
    let script = std::fs::canonicalize(home.join("tools").join(&agent).join("launch.js"))
        .map_err(|error| format!("{agent}: {error}"))?;
    let package = script.parent().ok_or("launch script has no package directory")?;
    inspect_with(crate::host_for(package, project)?, &script, manifest)
}

fn inspect_with(
    host: crate::rpc::Host,
    script: &Path,
    manifest: &Value,
) -> Result<Value, String> {
    let mut assets: Map<String, Value> = Map::new();
    for item in manifest["declared"].as_array().into_iter().flatten() {
        let kind = item["kind"].as_str().unwrap_or_default().to_owned();
        let entry = json!({ "name": item["id"], "path": item["path"] });
        if let Some(group) = assets.entry(kind).or_insert_with(|| json!([])).as_array_mut() {
            group.push(entry);
        }
    }
    let package = script.parent().map(Path::to_path_buf).unwrap_or_default();
    let data = json!({
        "id": host.plugin_id,
        "mode": "inspect",
        "expert": null,
        "inspect": {
            "expert": manifest["expert"],
            "assets": assets,
            "paths": {
                "package": package.to_string_lossy(),
                "tmp": manifest["tmp"],
                "cwd": manifest["cwd"],
                "home": std::env::var("HOME").unwrap_or_default(),
            },
        },
    });
    run_bootstrap(host, script, data)
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
    if let Some(key) = prompt_input_key(package)? {
        items.entry(key).or_insert(Value::Null);
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

/// tool.json 声明的派发内容输入键（宿主输入，不是启动栏控件）。
fn prompt_input_key(package: &Path) -> Result<Option<String>, String> {
    let mut manifest = read_json(&package.join("tool.json"))?;
    berth_tool_core::manifest::normalize(&mut manifest);
    Ok(manifest
        .pointer("/extensions/org.berth.agent/promptInput")
        .and_then(Value::as_str)
        .map(str::to_owned))
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

/// 专家表 `experts/<id>.json` → `Expert`（提示词正文、skills、展开后的 MCP、全部原生插件候选）+ 按类型分组的 `assets`。
/// 校验与设置页共用 `experts::issues`。
fn load_expert(home: &Path, expert_id: &str) -> Result<Value, String> {
    let id = safe_id(expert_id, "expert")?;
    let file = experts::resolve_asset(home, "experts", &id)
        .map_err(|code| format!("expert {id}: {code}"))?;
    let mut table = experts::read_expert(&file).map_err(|error| format!("expert {id}: {error}"))?;
    experts::with_memory(home, &id, &mut table)?;
    if let Some(issue) = experts::issues(home, &table).first() {
        return Err(format!("expert {id}: {issue}"));
    }
    let resolve = |kind: &str, item: &str| {
        experts::resolve_asset(home, kind, item).map_err(|code| format!("{kind}/{item}: {code}"))
    };
    let (prompt, prompt_file) = if table.prompt.is_empty() {
        (Value::Null, Value::Null)
    } else {
        let path = resolve("prompt", &table.prompt)?;
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        (json!(text.trim_end()), json!(path.to_string_lossy()))
    };
    let mut mcp = Map::new();
    let mut assets = Map::new();
    if !table.prompt.is_empty() {
        let path = prompt_file.clone();
        assets.insert("prompt".to_owned(), json!([{ "name": table.prompt, "path": path }]));
    }
    for (kind, items) in table.asset_refs() {
        let mut group = Vec::new();
        for item in items {
            let path = resolve(kind, item)?;
            let mut entry = json!({ "name": item, "path": path.to_string_lossy() });
            if kind == "mcp" {
                let spec = expand_env(neutral_mcp(read_json(&path)?), home, &id)?;
                mcp.insert(item.to_owned(), spec.clone());
                entry["spec"] = spec;
            }
            group.push(entry);
        }
        assets.insert(kind.to_owned(), Value::Array(group));
    }
    Ok(json!({
        "id": id,
        "name": table.name.trim(),
        "prompt": prompt,
        // 提示词文件路径：只给启动记录显示来源。
        "promptFile": prompt_file,
        "skills": assets["skills"],
        "mcp": mcp,
        "plugins": assets["plugins"],
        "assets": assets,
    }))
}

/// 插件拿到的 MCP 中性格式：去掉只给人看的说明字段，按 `url` / `command` 补 `type`
/// （缺 `type` 的定义会被 Claude CLI 静默丢弃，实测 2.1.312）。转成自家配置归插件。
fn neutral_mcp(mut spec: Value) -> Value {
    if let Some(map) = spec.as_object_mut() {
        map.retain(|key, _| key != "name" && key != "description" && !key.starts_with('_'));
        if let Some(env) = map.get_mut("env").and_then(Value::as_object_mut) {
            env.retain(|key, _| !key.starts_with('_'));
        }
        if !map.contains_key("type") {
            let kind = if map.contains_key("url") { "http" } else { "stdio" };
            map.insert("type".to_owned(), json!(kind));
        }
    }
    spec
}

/// MCP 定义里的 `"$NAME"` 换成环境变量（缺失报错），`${BERTH_HOME}` / `${BERTH_EXPERT}` 换成资产目录 / 专家 id。
fn expand_env(value: Value, home: &Path, expert: &str) -> Result<Value, String> {
    Ok(match value {
        Value::Object(map) => {
            if map.contains_key("secretRef") {
                return Err("secretRef is retired; use a complete $ENV_NAME value".into());
            }
            Value::Object(
                map.into_iter()
                    .map(|(key, item)| Ok((key, expand_env(item, home, expert)?)))
                    .collect::<Result<_, String>>()?,
            )
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| expand_env(item, home, expert))
                .collect::<Result<_, _>>()?,
        ),
        Value::String(text) if text.contains("${BERTH_HOME}") || text.contains("${BERTH_EXPERT}") => {
            json!(text
                .replace("${BERTH_HOME}", &home.to_string_lossy())
                .replace("${BERTH_EXPERT}", expert))
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

/// 准备本次启动清单：定下路径并交给 Agent，清掉超量的旧清单。内容由 `agent.js` 组装，每次变化都整份写。
/// 派发内容（promptInput）不进清单，提示词只记专家自己的。
fn prepare_manifest(
    home: &Path,
    inputs: &Map<String, Value>,
    package: &Path,
    expert: Option<&Value>,
) -> Result<Value, String> {
    let dir = berth_tool_core::experts::launches_dir(home);
    prune_manifests(&dir);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let id = format!("{now}-{}", std::process::id());
    std::env::set_var(LAUNCH_MANIFEST_ENV, dir.join(format!("{id}.json")));
    let dispatched = prompt_input_key(package)?;
    let inputs: Map<String, Value> = inputs
        .iter()
        .filter(|(key, _)| Some(key.as_str()) != dispatched.as_deref())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let prompt_hash = expert.and_then(|expert| expert["prompt"].as_str()).map(|text| {
        let digest = Sha256::digest(text.as_bytes());
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("sha256:{hex}")
    });
    Ok(json!({
        "id": id,
        "target": std::env::var("BERTH_TARGET_REF").ok(),
        "inputs": inputs,
        "promptHash": prompt_hash,
    }))
}

/// 新清单写入前留出位置：文件名以毫秒时间开头，按名字排序就是新旧。
fn prune_manifests(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .collect();
    files.sort();
    let excess = (files.len() + 1).saturating_sub(MANIFEST_KEEP);
    for file in &files[..excess.min(files.len())] {
        let _ = std::fs::remove_file(file);
    }
}

/// `agent.js` 整份写清单。可观察性不能拦住启动，写失败只是界面上看不到。
pub(crate) fn write_manifest(text: &str) {
    let Some(path) = std::env::var_os(LAUNCH_MANIFEST_ENV).map(PathBuf::from) else {
        return;
    };
    let Some(dir) = path.parent() else { return };
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        builder.mode(0o700);
        options.mode(0o600);
    }
    let temporary = path.with_extension("tmp");
    let written = builder.create(dir).and_then(|()| {
        use std::io::Write;
        options.open(&temporary)?.write_all(text.as_bytes())?;
        std::fs::rename(&temporary, &path)
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
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

/// `TempDir` 靠 `Drop` 删除，进程被杀就留下：启动时清掉所属进程已死的目录。
/// 只认 `berth-<id>-<pid>-<nanos>`，其他 `berth-*`（如 `/tmp/berth-1000`）一律不碰。
fn sweep_stale_temp_dirs(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let stale = entry
            .file_name()
            .to_str()
            .and_then(temp_dir_pid)
            .is_some_and(|pid| !crate::ns::process::is_alive(pid));
        // 只删真目录：同名符号链接不跟随。
        if stale && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// `berth-<id>-<pid>-<nanos>` 里的 pid；id 可以含 `-`，所以从尾部取。
fn temp_dir_pid(name: &str) -> Option<i32> {
    let mut parts = name.strip_prefix("berth-")?.rsplitn(3, '-');
    let nanos = parts.next()?;
    let pid = parts.next()?;
    let id = parts.next()?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    (is_valid_manifest_id(id) && digits(nanos) && digits(pid))
        .then(|| pid.parse().ok().filter(|pid| *pid > 0))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_runs_the_optional_hook_and_flags_what_is_missing() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path();
        for id in ["with", "without"] {
            std::fs::create_dir_all(root.join("tools").join(id)).unwrap();
            std::fs::write(root.join("tools").join(id).join("tool.json"), format!(r#"{{"id":"{id}"}}"#)).unwrap();
            std::fs::write(root.join("tools").join(id).join("launchbar.json"), r#"{"items":[]}"#).unwrap();
        }
        // 只认 m1：模拟声明了却没加载的 m2。launch 钩子不该被调用。
        std::fs::write(
            root.join("tools/with/launch.js"),
            r#"export default {
                 launch() { throw new Error("inspect must not launch") },
                 inspect: (ctx) => ctx.assets.mcp.map((asset) => ({
                   kind: "mcp", id: asset.name,
                   status: asset.name === "m1" && ctx.paths.tmp === "/t" ? "applied" : "skipped",
                 })),
               }"#,
        )
        .unwrap();
        std::fs::write(root.join("tools/without/launch.js"), "export default { launch() { return 0 } }").unwrap();
        let manifest = |agent: &str| {
            json!({
                "agent": agent, "cwd": "/p", "tmp": "/t", "expert": {"id": "dev", "name": "Dev"},
                "declared": [
                    {"kind": "mcp", "id": "m1", "path": "/h/mcp/m1.json"},
                    {"kind": "mcp", "id": "m2", "path": "/h/mcp/m2.json"},
                ],
            })
        };
        let run = |agent: &str| inspect(root, &manifest(agent), Box::new(|| Value::Null));
        let with = run("with").unwrap();
        assert_eq!(with["implemented"], true);
        assert_eq!(with["items"][0]["status"], "applied");
        assert_eq!(with["items"][1]["status"], "skipped");
        let without = run("without").unwrap();
        assert_eq!(without, json!({ "implemented": false, "items": [] }));
        assert!(run("../with").is_err());
    }

    #[test]
    fn sweep_removes_only_dead_owner_temp_dirs_of_the_exact_format() {
        let root = tempfile::tempdir().unwrap();
        // pid 取内核上限之外：一定不存在。
        let dead = "berth-claude-4194999-123";
        let dead_dashed = "berth-my-agent-4194999-456";
        let alive = format!("berth-claude-{}-789", std::process::id());
        let kept = ["berth-1000", "berth-claude", "berth-claude-x-1", "other-4194999-1", alive.as_str()];
        for name in [dead, dead_dashed].iter().chain(kept.iter()) {
            std::fs::create_dir(root.path().join(name)).unwrap();
        }
        sweep_stale_temp_dirs(root.path());
        assert!(!root.path().join(dead).exists());
        assert!(!root.path().join(dead_dashed).exists());
        for name in kept {
            assert!(root.path().join(name).exists(), "{name} 不该被清理");
        }
    }

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
        assert_eq!(expert["assets"]["mcp"][0]["spec"], expert["mcp"]["m"]);
        std::fs::write(root.join("experts/bad.json"), r#"{"name":"Bad","extra":1}"#).unwrap();
        assert!(load_expert(root, "bad").unwrap_err().contains("extra"));
    }

    #[test]
    fn mcp_is_neutralized_before_plugins_see_it() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path();
        for dir in ["experts", "mcp"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(
            root.join("experts/dev.json"),
            r#"{"name":"Dev","mcp":["remote","local","sse"]}"#,
        )
        .unwrap();
        // 说明字段里的 `$MISSING` 不该因为缺环境变量拦住启动。
        std::fs::write(
            root.join("mcp/remote.json"),
            r#"{"name":"R","description":"$MISSING_VAR","_status":"x","url":"https://x","protocolVersion":"auto"}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("mcp/local.json"),
            r#"{"command":"m","args":["--expert","${BERTH_EXPERT}","${BERTH_HOME}/d"],"env":{"_comment":"$MISSING_VAR","A":"1"}}"#,
        )
        .unwrap();
        std::fs::write(root.join("mcp/sse.json"), r#"{"type":"sse","url":"https://y"}"#).unwrap();
        let expert = load_expert(root, "dev").unwrap();
        assert_eq!(
            expert["mcp"]["remote"],
            json!({"type":"http","url":"https://x","protocolVersion":"auto"})
        );
        assert_eq!(
            expert["mcp"]["local"],
            json!({"type":"stdio","command":"m","args":["--expert","dev",format!("{}/d", root.display())],"env":{"A":"1"}})
        );
        assert_eq!(expert["mcp"]["sse"]["type"], json!("sse"));
    }

    #[test]
    fn open_expert_keys_become_assets_and_bad_ones_fail_by_name() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path();
        for dir in ["experts", "demo/a", "tools/x"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let write = |id: &str, raw: &str| {
            std::fs::write(root.join(format!("experts/{id}.json")), raw).unwrap();
        };
        write("ok", r#"{"name":"Ok","demo":["a"]}"#);
        let expert = load_expert(root, "ok").unwrap();
        assert_eq!(expert["assets"]["demo"][0]["name"], json!("a"));
        assert!(expert["assets"]["demo"][0]["path"].as_str().unwrap().ends_with("demo/a"));
        assert_eq!(expert["skills"], json!([]));

        write("typo", r#"{"name":"T","dmeo":["a"]}"#);
        assert!(load_expert(root, "typo").unwrap_err().contains("dmeo/a"));
        write("reserved", r#"{"name":"R","tools":["x"]}"#);
        assert!(load_expert(root, "reserved").unwrap_err().contains("tools"));
    }

    #[test]
    fn launch_manifest_records_reports_and_unhandled_without_secrets() {
        let _lock = berth_tool_core::paths::TEST_ENV_LOCK
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let home = tempfile::tempdir().unwrap();
        let root = home.path();
        let previous = std::env::var_os("BERTH_HOME");
        std::env::set_var("BERTH_HOME", root);
        std::env::set_var("BERTH_TEST_SECRET", "sk-mcp-secret");
        let package = root.join("tools/demo");
        for dir in ["experts", "prompts", "skills/s1", "mcp", "demo/a"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            root.join("experts/dev.json"),
            r#"{"name":"Dev","prompt":"dev","skills":["s1"],"mcp":["m"],"demo":["a"]}"#,
        )
        .unwrap();
        std::fs::write(root.join("prompts/dev.md"), "be terse\n").unwrap();
        std::fs::write(root.join("mcp/m.json"), r#"{"command":"m","env":{"KEY":"$BERTH_TEST_SECRET"}}"#).unwrap();
        std::fs::write(
            package.join("tool.json"),
            r#"{"id":"demo","extensions":{"org.berth.agent":{"promptInput":"task"}}}"#,
        )
        .unwrap();
        std::fs::write(package.join("launchbar.json"), r#"{"items":[{"id":"mode"},{"id":"expert"}]}"#).unwrap();
        // 插件只报告 prompt 和 skill：MCP 与开放资产 demo/a 没报，应算未处理。
        std::fs::write(
            package.join("launch.js"),
            r#"export default { launch: (ctx) => {
                 ctx.report([{ kind: "prompt", id: "dev", status: "applied" }])
                 ctx.report([{ kind: "skills", id: "s1", status: "skipped", reason: "no skills" },
                             { kind: "native-memory", id: "/x", status: "isolated" }])
                 ctx.plan({ note: "legacy" })
                 return ctx.assets.demo[0].name === "a" && ctx.assets.prompt[0].name === "dev" ? 0 : 3
               } }"#,
        )
        .unwrap();
        std::fs::write(
            root.join("provider.json"),
            r#"{"schema":"berth.provider/1","name":"relay","model":"m1","models":[],"endpoints":{"claude":{"baseUrl":"https://x","apiKey":"sk-provider-secret"}}}"#,
        )
        .unwrap();
        let argv: Vec<String> = [
            "--berth-launch-inputs",
            r#"{"expert":"dev","mode":"fast","task":"secret dispatch"}"#,
            "--berth-provider",
            root.join("provider.json").to_str().unwrap(),
        ]
        .iter()
        .map(|item| (*item).to_owned())
        .collect();
        // 超量旧清单被清掉，不匹配的不算。
        let dir = root.join("run/launches");
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..MANIFEST_KEEP {
            std::fs::write(dir.join(format!("{:013}-1.json", index)), "{}").unwrap();
        }
        let extras = LaunchExtras { brief: String::new, project: Box::new(|| Value::Null) };
        let code = launch(&package.join("launch.js"), &argv, extras);
        let path = PathBuf::from(std::env::var_os(LAUNCH_MANIFEST_ENV).unwrap());
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let count = std::fs::read_dir(&dir).unwrap().count();
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        std::env::remove_var("BERTH_TEST_SECRET");
        assert_eq!(code, 0);
        assert_eq!(count, MANIFEST_KEEP);
        assert!(!dir.join("0000000000000-1.json").exists());
        for secret in ["sk-mcp-secret", "sk-provider-secret", "secret dispatch"] {
            assert!(!text.contains(secret), "{secret} leaked");
        }
        let manifest: Value = serde_json::from_str(&text).unwrap();
        let unhandled: Vec<String> = manifest["unhandled"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| format!("{}/{}", item["kind"].as_str().unwrap(), item["id"].as_str().unwrap()))
            .collect();
        assert_eq!(unhandled, ["demo/a", "mcp/m"]);
        assert_eq!(manifest["declared"].as_array().unwrap().len(), 4);
        assert_eq!(manifest["report"].as_array().unwrap().len(), 3);
        assert_eq!(manifest["plan"]["note"], "legacy");
        assert_eq!(manifest["inputs"]["mode"], "fast");
        assert_eq!(manifest["provider"]["name"], "relay");
        assert_eq!(manifest["prompt"]["text"], "be terse");
        assert!(manifest["prompt"]["hash"].as_str().unwrap().starts_with("sha256:"));
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
            brief: String::new,
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

    #[test]
    fn only_the_builtin_expert_gets_the_brief() {
        let _lock = berth_tool_core::paths::TEST_ENV_LOCK
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let home = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        std::env::set_var("BERTH_HOME", home.path());
        let package = home.path().join("tools/demo");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(home.path().join("experts")).unwrap();
        for id in [berth_tool_core::builtin::EXPERT, "dev"] {
            std::fs::write(home.path().join(format!("experts/{id}.json")), r#"{"name":"E"}"#).unwrap();
        }
        std::fs::write(package.join("tool.json"), r#"{"id":"demo"}"#).unwrap();
        std::fs::write(package.join("launchbar.json"), r#"{"items":[]}"#).unwrap();
        // 退出码 = 拿到 brief 时 9，否则 0；启动计划进启动记录。
        std::fs::write(
            package.join("launch.js"),
            r#"export default { launch: (ctx) => { ctx.plan({ skills: ["tdd"] }); return ctx.brief ? 9 : 0 } }"#,
        )
        .unwrap();
        let run = |expert: Option<&str>| {
            let argv: Vec<String> = expert
                .map(|id| vec!["--berth-expert".to_owned(), id.to_owned()])
                .unwrap_or_default();
            let extras = LaunchExtras {
                brief: || "BRIEF".to_owned(),
                project: Box::new(|| Value::Null),
            };
            launch(&package.join("launch.js"), &argv, extras)
        };
        let builtin = run(Some(berth_tool_core::builtin::EXPERT));
        let other = run(Some("dev"));
        let record: Value =
            serde_json::from_str(&std::env::var(crate::script::LAUNCH_RECORD_ENV).unwrap()).unwrap();
        let none = run(None);
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        assert_eq!((builtin, other, none), (9, 0, 0));
        assert_eq!(
            (record["agent"].as_str(), record["expert"]["id"].as_str(), record["brief"].as_u64()),
            (Some("demo"), Some("dev"), Some(0))
        );
        assert_eq!(record["plan"]["skills"][0], "tdd");
    }
}
