//! 模型服务商的 Agent 侧声明（tool.json `org.berth.agent.providerInjection`）与启动档案。
//!
//! 启动时 Berth 只做一件事：把选中档案解析成一份一次性 JSON 文件（[`LaunchProfile`]），
//! 以 `--berth-provider <文件>` 交给工具包的 `launch.js`。怎么用它（写会话配置、设子进程
//! 环境、拼 `/v1`）全在工具包里，Berth 不知道任何一家的变量名或 URL 方言。不经 pane
//! 环境传递：termd 会把会话首个 pane 的环境当后续窗口的基底，环境变量会串到别的 Agent。
//!
//! 只做纯计算与写这一份文件：档案与密钥由宿主（GUI / CLI）读取后传入，本模块不碰数据库
//! 或 keyring。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Agent 参与模型服务商的声明：用哪一栏档案、有哪些模型档位、会说哪些接口。启动时怎么用
/// 档案由 `launch.js` 决定，这里不再有 env / argv 模板。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInjection {
    /// 供应商档案栏(provider.agent_type,如 "claude_code"/"codex"):
    /// 该 agent 的启动栏下拉只列出这一栏的档案。per-agent 栏,与设置页
    /// 一一对应,不做协议层映射。
    pub agent_type: String,
    /// 本 CLI 的模型档位槽声明(如 claude 的
    /// fable/haiku/opus/sonnet)。设置页据此把档案模型的 slot 输入
    /// 变成选项;值写进档案 `models[].slot`,内核不解读语义。
    #[serde(default)]
    pub slots: Option<Vec<String>>,
    /// 本 CLI 会说的模型接口（[`MODEL_APIS`]），按偏好排序。启动时每个模型取第一个
    /// 它也支持的接口；没有交集的模型不进启动档案。未声明 = 不按接口筛选。
    #[serde(default)]
    pub apis: Option<Vec<String>>,
}

/// 模型接口：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini。
/// 同一个 OpenAI 兼容地址背后有两种接口，模型可能只开通其中一种，所以按模型记录。
pub const MODEL_APIS: [&str; 4] = ["openai-chat", "openai-responses", "anthropic", "gemini"];

/// 接口名归一：认 Berth 自己的名字，也认 new-api `supported_endpoint_types` 的取值
/// （`openai` = Chat Completions，`openai-response` = Responses）；其余（嵌入、绘图…）为 `None`。
pub fn normalize_model_api(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "openai" | "openai-chat" => Some("openai-chat"),
        "openai-response" | "openai-responses" => Some("openai-responses"),
        "anthropic" => Some("anthropic"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

/// 接口走档案的哪个端点（`endpoints` 的键）。
fn api_endpoint(api: &str) -> &'static str {
    match api {
        "anthropic" => "claude",
        "gemini" => "gemini",
        _ => "chat",
    }
}

/// providerInjection：逐字段宽松解析（未知字段忽略）。`agentType` 缺失或损坏时为 `None`。
pub fn from_extension(extension: &Value) -> Option<ProviderInjection> {
    let object = extension.get("providerInjection")?.as_object()?;
    let agent_type = object
        .get("agentType")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)?;
    let strings = |key: &str| -> Option<Vec<String>> {
        object.get(key).and_then(Value::as_array).and_then(|items| {
            items
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect()
        })
    };
    let apis = strings("apis").map(|items| {
        items
            .iter()
            .filter_map(|api| normalize_model_api(api).map(str::to_string))
            .collect()
    });
    Some(ProviderInjection {
        agent_type,
        slots: strings("slots"),
        apis,
    })
}

/// 档案侧输入（只在内存里流动，调用方负责读取 key 与 discovery）。
pub struct ProviderProfile<'a> {
    /// 档案名。
    pub name: &'a str,
    /// 档案根 URL（无 `/v1`）。
    pub api_url: &'a str,
    /// 主 Key。
    pub api_key: &'a str,
    /// 回填了 Key 的 discovery_json（端点覆盖 / 分组 Key）。
    pub discovery: Option<&'a str>,
    /// 该 Agent 栏的 overlay 模型 JSON（带 slot）。
    pub overlay_models: Option<&'a str>,
    /// 档案目录模型 JSON。
    pub directory_models: Option<&'a str>,
    /// 经 Berth 凭据代理时的地址与令牌；`None` = 直接给真 Key。
    pub proxy: Option<ProxyRoute<'a>>,
}

/// 经 Berth 凭据代理启动：Agent 只拿到代理地址与占位令牌，真 Key 由代理按请求换上。
#[derive(Clone, Copy)]
pub struct ProxyRoute<'a> {
    /// `http://127.0.0.1:<port>/p/<provider-id>`，每个端点再拼 `/<协议>`。
    pub base_url: &'a str,
    pub token: &'a str,
}

/// 档案是否开启「经 Berth 代理」（`discovery_json.viaProxy`）。
pub fn via_proxy(discovery_json: Option<&str>) -> bool {
    discovery_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.get("viaProxy")?.as_bool())
        .unwrap_or(false)
}

/// 某协议实际访问的上游根地址与 Key：端点覆盖主地址 / 主 Key，分组 Key 优先。
/// 启动档案与凭据代理共用，保证两条路访问同一个上游。
pub fn resolve_upstream(
    discovery_json: Option<&str>,
    protocol: &str,
    api_url: &str,
    api_key: &str,
    selected_model: Option<&str>,
) -> (String, String) {
    let (url, key) = resolve_endpoint_override(discovery_json, protocol, api_url, api_key);
    let key = resolve_group_key(discovery_json, selected_model).unwrap_or(key);
    (url, key)
}

/// 档案声明了端点的协议；旧档案只有 `api_url`，任何协议名都解析到它，记作 `any`。
pub fn endpoint_protocols(discovery_json: Option<&str>) -> Vec<String> {
    let declared: Vec<String> = discovery_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            let endpoints = value.get("endpoints")?.as_object()?;
            Some(
                endpoints
                    .iter()
                    .filter(|(_, endpoint)| {
                        endpoint
                            .get("apiUrl")
                            .and_then(Value::as_str)
                            .is_some_and(|url| !url.trim().is_empty())
                    })
                    .map(|(protocol, _)| protocol.clone())
                    .collect(),
            )
        })
        .unwrap_or_default();
    if declared.is_empty() {
        vec!["any".to_owned()]
    } else {
        declared
    }
}

/// 交给 `launch.js` 的一次性服务商档案（`berth.provider/1`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfile {
    pub schema: String,
    pub name: String,
    /// 启动栏选中的模型；`None` = 不指定，由 launch.js 决定（一般取 `models[0]`）。
    pub model: Option<String>,
    /// 本 Agent 能用的模型（overlay 带 `slot` ∪ 档案目录），各带选定的接口与端点。
    pub models: Vec<LaunchModel>,
    /// 协议名（`chat` / `claude` / `gemini`；只填了主地址的旧档案为 `any`）→ 根地址与 Key。
    pub endpoints: BTreeMap<String, LaunchEndpoint>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    /// 这次用的接口（[`MODEL_APIS`]）；Agent 没声明 `apis` 时为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    /// 接口所在的端点（`endpoints` 的键）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// 模型和档案默认都没记录支持哪些接口：按 Agent 第一偏好取，未经上游确认。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unconfirmed: bool,
    /// 上下文长度（token）；`None` = 交给 Agent 自己的默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// 单次最长输出（token）；`None` = 交给 Agent 自己的默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchEndpoint {
    /// 无 `/v1` 的根地址（经代理时为代理地址），各家方言由 launch.js 拼。
    pub base_url: String,
    pub api_key: String,
}

pub const LAUNCH_PROFILE_SCHEMA: &str = "berth.provider/1";
/// `launch.js` 认的参数名：后跟档案文件路径，读完即删。
pub const LAUNCH_PROFILE_ARG: &str = "--berth-provider";

/// 把一份非官方档案解析成启动档案：每个端点按「端点覆盖 → 分组 Key」取上游，经代理时
/// 换成代理地址与令牌；每个模型按 `agent_apis` 选接口（见 [`ProviderInjection::apis`]）。
/// 拿不到任何 Key、或选中的模型与 Agent 没有共同接口时报错：不让 Agent 进会话后才失败。
pub fn launch_profile(
    profile: &ProviderProfile<'_>,
    agent_apis: Option<&[String]>,
    model_id: Option<&str>,
) -> Result<LaunchProfile, String> {
    let model = model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let endpoints: BTreeMap<String, LaunchEndpoint> = endpoint_protocols(profile.discovery)
        .into_iter()
        .map(|protocol| {
            let (base_url, api_key) = match profile.proxy {
                Some(proxy) => (
                    format!("{}/{protocol}", proxy.base_url),
                    proxy.token.to_owned(),
                ),
                None => resolve_upstream(
                    profile.discovery,
                    &protocol,
                    profile.api_url,
                    profile.api_key,
                    model.as_deref(),
                ),
            };
            let base_url = base_url.trim().trim_end_matches('/').to_owned();
            (protocol, LaunchEndpoint { base_url, api_key })
        })
        .filter(|(_, endpoint)| !endpoint.base_url.is_empty())
        .collect();
    if endpoints.is_empty() {
        return Err(format!(
            "Provider \"{}\" has no API URL; fill it in Settings → Model providers",
            profile.name
        ));
    }
    if endpoints
        .values()
        .all(|endpoint| endpoint.api_key.trim().is_empty())
    {
        return Err(format!(
            "Provider \"{}\" has no API key; fill it in Settings → Model providers",
            profile.name
        ));
    }
    let models = launch_models(profile, agent_apis, model.as_deref(), &endpoints)?;
    Ok(LaunchProfile {
        schema: LAUNCH_PROFILE_SCHEMA.to_owned(),
        name: profile.name.to_owned(),
        model,
        models,
        endpoints,
    })
}

/// overlay ∪ 目录模型 → 本 Agent 能用的模型。同一 id 在任一来源记录的接口都算数
/// （overlay 只带 slot 的旧数据不会抹掉目录里的接口）；模型没记录时用档案的
/// `discovery_json.defaultApis`（中转站大多所有模型走同一种接口，设一次即可）。
fn launch_models(
    profile: &ProviderProfile<'_>,
    agent_apis: Option<&[String]>,
    selected: Option<&str>,
    endpoints: &BTreeMap<String, LaunchEndpoint>,
) -> Result<Vec<LaunchModel>, String> {
    let rows: Vec<Value> = serde_json::from_str(&merge_models_json(
        profile.overlay_models,
        profile.directory_models,
    ))
    .unwrap_or_default();
    let default_apis = profile
        .discovery
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|value| api_list(value.get("defaultApis")))
        .filter(|apis| !apis.is_empty());
    let mut known_apis: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for raw in [profile.overlay_models, profile.directory_models]
        .into_iter()
        .flatten()
    {
        for row in serde_json::from_str::<Vec<Value>>(raw).unwrap_or_default() {
            if let Some(id) = row.get("id").and_then(Value::as_str) {
                let apis = model_apis(&row);
                if !apis.is_empty() {
                    known_apis.entry(id.trim().to_owned()).or_insert(apis);
                }
            }
        }
    }
    let mut models: Vec<LaunchModel> = rows
        .iter()
        .filter_map(|row| {
            let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
            let tokens = |key: &str| row.get(key).and_then(Value::as_u64).filter(|n| *n > 0);
            let model = match row {
                Value::String(id) => LaunchModel {
                    id: id.trim().to_owned(),
                    ..Default::default()
                },
                _ => LaunchModel {
                    id: row.get("id")?.as_str()?.trim().to_owned(),
                    name: text("name"),
                    slot: text("slot"),
                    context_window: tokens("contextWindow"),
                    max_output: tokens("maxOutput"),
                    ..Default::default()
                },
            };
            (!model.id.is_empty()).then_some(model)
        })
        .collect();
    if let Some(selected) = selected {
        if !models.iter().any(|model| model.id == selected) {
            models.insert(
                0,
                LaunchModel {
                    id: selected.to_owned(),
                    ..Default::default()
                },
            );
        }
    }
    let Some(agent_apis) = agent_apis.filter(|apis| !apis.is_empty()) else {
        return Ok(models);
    };
    // Agent 会说、且档案有对应端点的接口；只填了主地址的旧档案（`any`）什么接口都接。
    let reachable = |api: &str| {
        let endpoint = api_endpoint(api);
        endpoints
            .contains_key(endpoint)
            .then_some(endpoint)
            .or_else(|| endpoints.contains_key("any").then_some("any"))
    };
    let mut usable = Vec::new();
    for mut model in models {
        let supported = known_apis.get(&model.id).or(default_apis.as_ref());
        let chosen = agent_apis.iter().find_map(|api| {
            let endpoint = reachable(api)?;
            supported
                .is_none_or(|apis| apis.iter().any(|known| known == api))
                .then_some((api, endpoint))
        });
        match chosen {
            Some((api, endpoint)) => {
                model.api = Some(api.clone());
                model.endpoint = Some(endpoint.to_owned());
                model.unconfirmed = supported.is_none();
                usable.push(model);
            }
            None if selected == Some(model.id.as_str()) => {
                let model_side = supported.map_or_else(
                    || "（档案里没有对应端点）".to_owned(),
                    |apis| apis.join(" / "),
                );
                return Err(format!(
                    "模型 {} 支持的接口是 {model_side}，这个 Agent 只会 {}；请换一个模型，或在 \
                     设置 → 模型服务商 里修正该模型的接口",
                    model.id,
                    agent_apis.join(" / ")
                ));
            }
            None => {}
        }
    }
    Ok(usable)
}

/// 模型条目上记录的接口（`apis`，已归一、去重）。
fn model_apis(row: &Value) -> Vec<String> {
    api_list(row.get("apis"))
}

fn api_list(value: Option<&Value>) -> Vec<String> {
    let mut apis: Vec<String> = Vec::new();
    for api in value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(normalize_model_api)
    {
        if !apis.iter().any(|known| known == api) {
            apis.push(api.to_owned());
        }
    }
    apis
}

/// 启动档案的存放目录：优先 `$XDG_RUNTIME_DIR`（仅本用户可读、登出即清空的 tmpfs）。
fn launch_profile_dir() -> PathBuf {
    dirs::runtime_dir()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("berth-provider")
}

/// 写一份 0600 的启动档案，返回追加在 launch.js 参数尾部的 `["--berth-provider", <路径>]`。
/// launch.js 读完即删；Agent 没起来（spawn 失败）留下的文件在下次写入时按时间清掉。
pub fn write_launch_profile(profile: &LaunchProfile) -> Result<Vec<String>, String> {
    write_launch_profile_in(&launch_profile_dir(), profile)
}

fn write_launch_profile_in(dir: &Path, profile: &LaunchProfile) -> Result<Vec<String>, String> {
    use std::io::Write;
    let fail = |error: std::io::Error| format!("cannot write provider launch profile: {error}");
    std::fs::create_dir_all(dir).map_err(fail)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(fail)?;
    }
    sweep_stale(dir, Duration::from_secs(600));
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let body = serde_json::to_vec(profile).map_err(|error| error.to_string())?;
    options
        .open(&path)
        .and_then(|mut file| file.write_all(&body))
        .map_err(fail)?;
    Ok(vec![
        LAUNCH_PROFILE_ARG.to_owned(),
        path.to_string_lossy().into_owned(),
    ])
}

/// 删掉超过 `max_age` 仍没被 launch.js 取走的档案（含 Key，不让它长留磁盘）。
fn sweep_stale(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 协议（`endpoints` 的键，如 `chat` / `claude` / `gemini`）的地址与 Key；未声明则用主地址 / 主 Key。
pub fn resolve_endpoint_override(
    discovery_json: Option<&str>,
    protocol: &str,
    default_url: &str,
    default_key: &str,
) -> (String, String) {
    if let Some(raw) = discovery_json {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(endpoints) = val.get("endpoints").and_then(|e| e.as_object()) {
                if let Some(ep) = endpoints.get(protocol) {
                    let ep_url = ep
                        .get("apiUrl")
                        .or_else(|| ep.get("api_url"))
                        .and_then(|u| u.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let ep_key = ep
                        .get("apiKey")
                        .or_else(|| ep.get("api_key"))
                        .and_then(|k| k.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let final_url = ep_url
                        .map(str::to_string)
                        .unwrap_or_else(|| default_url.to_string());
                    let final_key = ep_key
                        .map(str::to_string)
                        .unwrap_or_else(|| default_key.to_string());
                    return (final_url, final_key);
                }
            }
        }
    }
    (default_url.to_string(), default_key.to_string())
}

/// 如果 discovery_json 中配置了 keyGroups，根据 selected_model 匹配对应分组的 Key；
/// 找不到特定模型时回退到第一个有效分组的 Key。
pub fn resolve_group_key(
    discovery_json: Option<&str>,
    selected_model: Option<&str>,
) -> Option<String> {
    let raw = discovery_json?;
    let val: serde_json::Value = serde_json::from_str(raw).ok()?;
    let groups = val
        .get("keyGroups")
        .or_else(|| val.get("groupKeys"))?
        .as_array()?;
    if groups.is_empty() {
        return None;
    }

    // 1. 如果有 selected_model，优先寻找包含该 model id 的分组
    if let Some(target_model) = selected_model.map(str::trim).filter(|s| !s.is_empty()) {
        for g in groups {
            if let Some(models) = g.get("models").and_then(|m| m.as_array()) {
                for m in models {
                    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
                    if id.eq_ignore_ascii_case(target_model) {
                        if let Some(k) = g
                            .get("key")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            return Some(k.to_string());
                        }
                    }
                }
            }
        }
    }

    // 2. 回退到第一个非空 Key 的分组
    for g in groups {
        if let Some(k) = g
            .get("key")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(k.to_string());
        }
    }

    None
}

/// overlay 优先（带 slot），再并入目录里尚未出现的 id。
fn merge_models_json(overlay: Option<&str>, directory: Option<&str>) -> String {
    let mut items: Vec<serde_json::Value> = Vec::new();
    let mut seen = HashSet::new();
    for raw in [overlay, directory] {
        let Some(text) = raw
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "[]")
        else {
            continue;
        };
        let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(text)
        else {
            continue;
        };
        for row in rows {
            let id = match &row {
                serde_json::Value::String(value) => value.trim().to_string(),
                serde_json::Value::Object(map) => map
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                _ => String::new(),
            };
            if id.is_empty() || !seen.insert(id) {
                continue;
            }
            items.push(row);
        }
    }
    serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_models_json_keeps_overlay_slots_then_directory_ids() {
        let merged = merge_models_json(
            Some(r#"[{"id":"claude-sonnet-x","slot":"sonnet"}]"#),
            Some(r#"[{"id":"claude-sonnet-x"},{"id":"deepseek-v4"}]"#),
        );
        let rows: Vec<serde_json::Value> = serde_json::from_str(&merged).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "claude-sonnet-x");
        assert_eq!(rows[0]["slot"], "sonnet");
        assert_eq!(rows[1]["id"], "deepseek-v4");
    }

    #[test]
    fn resolve_endpoint_override_uses_protocol_specific_urls_and_keys() {
        let discovery = r#"{
            "endpoints": {
                "claude": {
                    "apiUrl": "https://claude.api.example/v1",
                    "apiKey": "sk-claude-secret"
                },
                "chat": {
                    "apiUrl": "https://chat.api.example/v1",
                    "apiKey": "sk-chat-secret"
                }
            }
        }"#;

        // 按协议名取端点，不按 Agent 名换算
        let (url, key) = resolve_endpoint_override(
            Some(discovery),
            "claude",
            "https://default.example",
            "sk-default",
        );
        assert_eq!(url, "https://claude.api.example/v1");
        assert_eq!(key, "sk-claude-secret");

        let (url, key) = resolve_endpoint_override(
            Some(discovery),
            "chat",
            "https://default.example",
            "sk-default",
        );
        assert_eq!(url, "https://chat.api.example/v1");
        assert_eq!(key, "sk-chat-secret");

        // 未声明的协议回落主地址；Agent 名也不再被换算
        assert_eq!(
            resolve_endpoint_override(Some(discovery), "codex", "https://default.example", "").0,
            "https://default.example"
        );
        let (url, key) = resolve_endpoint_override(
            Some(discovery),
            "gemini",
            "https://default.example",
            "sk-default",
        );
        assert_eq!(url, "https://default.example");
        assert_eq!(key, "sk-default");
    }

    #[test]
    fn resolve_group_key_picks_key_matching_selected_model() {
        let discovery = r#"{
            "keyGroups": [
                {
                    "id": "1",
                    "name": "default",
                    "key": "sk-default-key",
                    "models": [
                        { "id": "gpt-4o", "name": "gpt-4o" },
                        { "id": "gpt-4o-mini", "name": "gpt-4o-mini" }
                    ]
                },
                {
                    "id": "2",
                    "name": "vip",
                    "key": "sk-vip-key",
                    "models": [
                        { "id": "o1-preview", "name": "o1-preview" }
                    ]
                }
            ]
        }"#;

        // Model in VIP group picks VIP key
        assert_eq!(
            resolve_group_key(Some(discovery), Some("o1-preview")),
            Some("sk-vip-key".to_string())
        );

        // Model in default group picks default key
        assert_eq!(
            resolve_group_key(Some(discovery), Some("gpt-4o")),
            Some("sk-default-key".to_string())
        );

        // Unknown model or None falls back to first valid key
        assert_eq!(
            resolve_group_key(Some(discovery), Some("unknown-model")),
            Some("sk-default-key".to_string())
        );
        assert_eq!(
            resolve_group_key(Some(discovery), None),
            Some("sk-default-key".to_string())
        );
    }

    fn relay(discovery: Option<&'static str>) -> ProviderProfile<'static> {
        ProviderProfile {
            name: "relay",
            api_url: "https://root/",
            api_key: "sk-main",
            discovery,
            overlay_models: Some(r#"[{"id":"m-opus","slot":"opus"}]"#),
            directory_models: Some(r#"["m-opus","m-mini"]"#),
            proxy: None,
        }
    }

    #[test]
    fn legacy_profile_has_one_any_endpoint_and_merged_models() {
        let launch = launch_profile(&relay(None), None, Some(" m-opus ")).unwrap();
        assert_eq!(launch.schema, LAUNCH_PROFILE_SCHEMA);
        assert_eq!(launch.model.as_deref(), Some("m-opus"));
        assert_eq!(launch.endpoints.len(), 1);
        assert_eq!(launch.endpoints["any"].base_url, "https://root");
        assert_eq!(launch.endpoints["any"].api_key, "sk-main");
        assert_eq!(launch.models.len(), 2);
        assert_eq!(launch.models[0].slot.as_deref(), Some("opus"));
        assert_eq!(launch.models[0].api, None);
    }

    #[test]
    fn endpoints_resolve_override_and_group_key_or_proxy() {
        let discovery = r#"{"viaProxy":true,"endpoints":{
            "chat":{"apiUrl":"https://chat","apiKey":"sk-chat"},
            "claude":{"apiUrl":"https://claude/","apiKey":""}},
            "keyGroups":[{"id":"1","key":"sk-group","models":[]}]}"#;
        let direct = launch_profile(&relay(Some(discovery)), None, None).unwrap();
        assert_eq!(direct.endpoints["chat"].base_url, "https://chat");
        assert_eq!(direct.endpoints["claude"].base_url, "https://claude");
        assert_eq!(direct.endpoints["chat"].api_key, "sk-group");

        let proxied = launch_profile(
            &ProviderProfile {
                proxy: Some(ProxyRoute {
                    base_url: "http://127.0.0.1:15722/p/7",
                    token: "berth-tk-x",
                }),
                ..relay(Some(discovery))
            },
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            proxied.endpoints["claude"].base_url,
            "http://127.0.0.1:15722/p/7/claude"
        );
        assert!(proxied
            .endpoints
            .values()
            .all(|endpoint| endpoint.api_key == "berth-tk-x"));
        assert!(via_proxy(Some(discovery)));
        assert!(!via_proxy(Some(r#"{"viaProxy":"yes"}"#)));
    }

    #[test]
    fn missing_key_fails_before_launch() {
        let keyless = ProviderProfile {
            api_key: " ",
            ..relay(None)
        };
        assert!(launch_profile(&keyless, None, None)
            .unwrap_err()
            .contains("relay"));
    }

    #[test]
    fn launch_profile_file_is_private_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let launch = launch_profile(&relay(None), None, None).unwrap();
        let args = write_launch_profile_in(dir.path(), &launch).unwrap();
        assert_eq!(args[0], LAUNCH_PROFILE_ARG);
        let path = Path::new(&args[1]);
        let read: LaunchProfile = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(read, launch);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        sweep_stale(dir.path(), Duration::ZERO);
        assert!(!path.exists());
    }

    fn apis(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn each_model_takes_the_first_agent_api_it_supports() {
        let discovery =
            r#"{"endpoints":{"chat":{"apiUrl":"https://r"},"claude":{"apiUrl":"https://r"}}}"#;
        let profile = ProviderProfile {
            overlay_models: None,
            directory_models: Some(
                r#"[{"id":"gpt-6-astra","apis":["openai-response"]},
                    {"id":"claude-x","apis":["anthropic","openai"]},
                    {"id":"mystery"}]"#,
            ),
            ..relay(Some(discovery))
        };
        let pi = apis(&["anthropic", "openai-responses", "openai-chat"]);
        let launch = launch_profile(&profile, Some(&pi), Some("gpt-6-astra")).unwrap();
        let picked: Vec<_> = launch
            .models
            .iter()
            .map(|m| {
                (
                    m.id.as_str(),
                    m.api.as_deref(),
                    m.endpoint.as_deref(),
                    m.unconfirmed,
                )
            })
            .collect();
        assert_eq!(
            picked,
            [
                ("gpt-6-astra", Some("openai-responses"), Some("chat"), false),
                ("claude-x", Some("anthropic"), Some("claude"), false),
                ("mystery", Some("anthropic"), Some("claude"), true),
            ]
        );

        // Codex 只会 Responses：只开通 Anthropic / Chat 的模型不进档案；选中它则启动前报错。
        let codex = apis(&["openai-responses"]);
        let launch = launch_profile(&profile, Some(&codex), None).unwrap();
        let ids: Vec<_> = launch.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-6-astra", "mystery"]);
        let error = launch_profile(&profile, Some(&codex), Some("claude-x")).unwrap_err();
        assert!(error.contains("claude-x") && error.contains("anthropic / openai-chat"));
    }

    #[test]
    fn provider_default_apis_confirm_unlisted_models_and_limits_pass_through() {
        let discovery = r#"{"endpoints":{"chat":{"apiUrl":"https://r"},"claude":{"apiUrl":"https://r"}},
            "defaultApis":["openai-responses"]}"#;
        let profile = ProviderProfile {
            overlay_models: None,
            directory_models: Some(
                r#"[{"id":"plain","contextWindow":200000,"maxOutput":0},
                    {"id":"claude-x","apis":["anthropic"]}]"#,
            ),
            ..relay(Some(discovery))
        };
        let pi = apis(&["anthropic", "openai-responses", "openai-chat"]);
        let launch = launch_profile(&profile, Some(&pi), None).unwrap();
        let plain = &launch.models[0];
        assert_eq!(plain.api.as_deref(), Some("openai-responses"));
        assert!(!plain.unconfirmed);
        assert_eq!(
            (plain.context_window, plain.max_output),
            (Some(200000), None)
        );
        // 模型自己记录的接口优先于档案默认。
        assert_eq!(launch.models[1].api.as_deref(), Some("anthropic"));
    }

    #[test]
    fn legacy_any_endpoint_accepts_every_api_and_overlay_keeps_directory_apis() {
        let profile = ProviderProfile {
            overlay_models: Some(r#"[{"id":"m","slot":"opus"}]"#),
            directory_models: Some(r#"[{"id":"m","apis":["openai"]}]"#),
            ..relay(None)
        };
        let codex = apis(&["openai-responses"]);
        assert!(launch_profile(&profile, Some(&codex), Some("m")).is_err());
        let grok = apis(&["openai-responses", "openai-chat"]);
        let launch = launch_profile(&profile, Some(&grok), Some("m")).unwrap();
        assert_eq!(launch.models[0].api.as_deref(), Some("openai-chat"));
        assert_eq!(launch.models[0].endpoint.as_deref(), Some("any"));
        assert_eq!(launch.models[0].slot.as_deref(), Some("opus"));
    }

    #[test]
    fn api_names_normalize_new_api_endpoint_types() {
        assert_eq!(normalize_model_api("openai"), Some("openai-chat"));
        assert_eq!(
            normalize_model_api("openai-response"),
            Some("openai-responses")
        );
        assert_eq!(normalize_model_api("Anthropic"), Some("anthropic"));
        assert_eq!(normalize_model_api("embeddings"), None);
        let spec = from_extension(&serde_json::json!({"providerInjection": {
            "agentType": "pi", "apis": ["anthropic", "openai-response", "bogus"]}}))
        .unwrap();
        assert_eq!(spec.apis.unwrap(), ["anthropic", "openai-responses"]);
    }
}
