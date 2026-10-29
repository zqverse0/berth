//! 声明式只读查询的通用底层。
//!
//! 凭据解析(文件 + JSON Pointer + token 注入头形态)、HTTPS/超时/响应上限、查询参数取值、
//! 失败分类(Missing/Unavailable/Failed)与请求执行只在这里实现一次:用量(`super::usage`)、
//! 站点余额(`super::balance`)、模型目录(`crate::commands::model_provider`)共用同一份实现。
//! 不识别任何 agent 品牌。
//!
//! 安全边界:URL 强制 https 且禁内嵌凭据;凭据文件与响应体有大小上限;token 只进请求头,
//! 永不进返回的数据。威胁模型:能写 tool.json 的人本就能直接读该凭据文件。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) const MAX_CREDENTIAL_BYTES: u64 = 256 * 1024;

/// 声明值来源文件上限(CLI 自己写的版本号等,比凭据文件允许更大)。
const MAX_DECLARED_VALUE_BYTES: u64 = 2 * 1024 * 1024;

/// 声明式响应上限:模型目录可能携带每个模型的完整元数据,用量/余额共用同一上限。
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageCredentialSpec {
    /// `json-file` = 从声明路径的 JSON 文件提取;
    /// `provider-key` = 调用方直传 api_key(站点余额模板专用,磁盘声明不会出现)。
    pub kind: String,
    /// 凭据文件路径模板,仅支持 `${home}` 前缀变量;provider-key 时省略。
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub token_pointer: Option<String>,
    #[serde(default)]
    pub header_pointers: BTreeMap<String, String>,
    /// 根对象每个 object 值当一个作用域试(grok auth.json 的 scope-map)。
    #[serde(default)]
    pub from_object_values: bool,
    /// scope 排序偏好(grok "https://auth.x.ai")。
    #[serde(default)]
    pub prefer_key_prefix: Option<String>,
    /// token 注入头的形态。缺省 = `Authorization: Bearer <token>`;
    /// 智谱等站要求裸 key(无前缀),部分站用自定义头名(X-Api-Key)。
    #[serde(default)]
    pub auth_header: Option<AuthHeaderSpec>,
}

/// token 注入头声明。语义:完全不声明 `authHeader` = `Authorization: Bearer <t>`;
/// 声明了 `authHeader` 就由它接管——`prefix` 缺省为裸值,`""` 也是裸值,
/// 其他值 = `{prefix} <t>`(如 "Token")。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthHeaderSpec {
    #[serde(default = "default_auth_header_name")]
    pub name: String,
    #[serde(default = "default_auth_header_prefix")]
    pub prefix: Option<String>,
}

fn default_auth_header_name() -> String {
    "Authorization".to_string()
}

fn default_auth_header_prefix() -> Option<String> {
    Some(String::new())
}

/// 声明式只读请求的投影。用量、余额、模型目录共用同一形状与同一执行器
/// (凭据解析、HTTPS 边界、超时、响应上限、错误分类都只实现一次)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredJsonRequest {
    pub method: String,
    pub url: String,
    /// 查询参数:字面量,或从声明文件的 JSON Pointer 取当次事实。
    #[serde(default)]
    pub query: BTreeMap<String, QueryValue>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// POST 的 JSON body(GET 忽略)。固定 JSON 对象,不做模板替换。
    #[serde(default)]
    pub body: Option<Value>,
}

/// 查询参数取值来源。文件形式用于 CLI 自己写的版本号一类当次事实,
/// 避免把某个 CLI 的版本号硬编码进宿主。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum QueryValue {
    Literal(String),
    FromFile { file: String, pointer: String },
}

/// 声明式查询的确定性失败分类。调用方按类别映射成各自的 wire 语义:
/// 用量/余额 → `UsageStatus`;模型目录 → 命令错误。消息本身直接展示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeclaredQueryError {
    /// 凭据缺失/未登录(文件不存在、空文件、空 api key)。
    Missing(String),
    /// 声明或环境不可用(路径非法、home 不可用、credential kind 未知、URL 非法)。
    Unavailable(String),
    /// 请求失败(传输、非 2xx、超时、响应过大、JSON 非法、指针未命中)。
    Failed(String),
}

impl std::fmt::Display for DeclaredQueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Missing(message) | Self::Unavailable(message) | Self::Failed(message) => message,
        };
        formatter.write_str(message)
    }
}

pub(super) fn declared_credential(agent: &str, id: &str) -> Result<UsageCredentialSpec, String> {
    let asset = crate::tool::asset_repository::load_tool_asset(agent)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "tool asset is missing".to_string())?;
    let spec = asset
        .agent_extension()
        .and_then(|extension| extension.get("credentials"))
        .and_then(|credentials| credentials.get(id))
        .ok_or_else(|| format!("credential declaration {id} is missing"))?;
    let credential: UsageCredentialSpec =
        serde_json::from_value(spec.clone()).map_err(|error| error.to_string())?;
    if credential.kind != "json-file" {
        return Err("tool credential must be a json-file".to_string());
    }
    Ok(credential)
}

/// 组装完成的声明式请求(唯一形态:凭据头已注入、query 已展开)。
pub(super) struct PreparedQuery {
    pub(super) url: String,
    pub(super) method: String,
    pub(super) headers: BTreeMap<String, String>,
    pub(super) body: Option<Value>,
}

impl std::fmt::Debug for PreparedQuery {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // headers 含注入后的凭据头,只报数量,不打印内容。
        formatter
            .debug_struct("PreparedQuery")
            .field("url", &self.url)
            .field("method", &self.method)
            .field("header_count", &self.headers.len())
            .field("body", &self.body)
            .finish()
    }
}

/// 声明式查询的共同前半段:取凭据 → 注入头 → 展开 query → 校验 URL。
/// 同步、不触网,便于定向测试;用量、余额、模型目录共用。
pub(super) fn prepare_declared_query(
    credential: &UsageCredentialSpec,
    provider_key: Option<&str>,
    custom_credential: Option<&str>,
    request: &DeclaredJsonRequest,
) -> Result<PreparedQuery, DeclaredQueryError> {
    let material = resolve_credential_material(credential, provider_key, custom_credential)?;
    validate_https_url(&request.url).map_err(DeclaredQueryError::Unavailable)?;
    let url = apply_query_values(&request.url, &request.query)
        .map_err(DeclaredQueryError::Unavailable)?;
    let mut headers = request.headers.clone();
    apply_credential_headers(credential, &material, &mut headers);
    Ok(PreparedQuery {
        url,
        method: request.method.clone(),
        headers,
        body: request.body.clone(),
    })
}

/// 取 token 与额外头:文件声明 / 调用方直传 `api_key` 两条来源,只此一处实现。
fn resolve_credential_material(
    credential: &UsageCredentialSpec,
    provider_key: Option<&str>,
    custom_credential: Option<&str>,
) -> Result<CredentialMaterial, DeclaredQueryError> {
    match credential.kind.as_str() {
        "json-file" => {
            let material = if let Some(raw_json) = custom_credential.filter(|s| !s.trim().is_empty())
            {
                let value: Value = serde_json::from_str(raw_json).map_err(|error| {
                    DeclaredQueryError::Unavailable(format!(
                        "custom credential is not valid JSON: {error}"
                    ))
                })?;
                parse_credential_material_from_value(credential, &value)
                    .map_err(DeclaredQueryError::Unavailable)?
            } else {
                let path = resolve_declared_credential_path(credential)
                    .map_err(DeclaredQueryError::Unavailable)?;
                read_credential_material(credential, &path)
                    .map_err(DeclaredQueryError::Unavailable)?
            };
            material.ok_or_else(|| {
                DeclaredQueryError::Missing("account credentials are not signed in".to_string())
            })
        }
        "provider-key" => match provider_key.map(str::trim).filter(|token| !token.is_empty()) {
            Some(token) => Ok(CredentialMaterial {
                token: token.to_string(),
                extra_headers: BTreeMap::new(),
            }),
            None => Err(DeclaredQueryError::Missing(
                "provider api key is empty".to_string(),
            )),
        },
        other => Err(DeclaredQueryError::Unavailable(format!(
            "unknown credential kind: {other}"
        ))),
    }
}

/// 发送已组装的声明式请求并解析响应:2xx 且为 JSON(空响应体按空对象处理,
/// 保留既有容错);非 2xx、超限、非法 JSON 都是确定性失败。
pub(super) async fn fetch_prepared_json(prepared: PreparedQuery) -> Result<Value, DeclaredQueryError> {
    let (status, bytes) = fetch_body(&prepared, MAX_RESPONSE_BYTES)
        .await
        .map_err(DeclaredQueryError::Failed)?;
    if !(200..300).contains(&status) {
        return Err(DeclaredQueryError::Failed(format!(
            "request failed (HTTP {status}){}",
            server_error_hint(&bytes)
        )));
    }
    if bytes.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| DeclaredQueryError::Failed("response is not valid JSON".to_string()))
}

/// 失败响应里取一小段服务端说明(有界、去控制字符),便于如实展示失败原因。
pub(super) fn server_error_hint(bytes: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return String::new();
    };
    let message = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/error"))
        .or_else(|| value.pointer("/message"))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        });
    let Some(message) = message else {
        return String::new();
    };
    let cleaned: String = message
        .chars()
        .filter(|ch| !ch.is_control())
        .take(200)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        String::new()
    } else {
        format!(": {cleaned}")
    }
}

fn resolve_declared_credential_path(credential: &UsageCredentialSpec) -> Result<PathBuf, String> {
    let template = credential
        .path
        .as_deref()
        .ok_or_else(|| "credential path is missing".to_string())?;
    resolve_home_path(template)?.ok_or_else(|| "home directory is unavailable".to_string())
}

/// token 注入头 + 声明的额外头。语义与用量执行器完全一致(见 AuthHeaderSpec)。
fn apply_credential_headers(
    credential: &UsageCredentialSpec,
    material: &CredentialMaterial,
    headers: &mut BTreeMap<String, String>,
) {
    let auth = credential.auth_header.as_ref();
    let auth_name = auth
        .map(|spec| spec.name.as_str())
        .unwrap_or("Authorization");
    headers.retain(|name, _| !name.eq_ignore_ascii_case(auth_name));
    headers.extend(material.extra_headers.clone());
    let value = match auth {
        None => format!("Bearer {}", material.token),
        Some(spec) => match spec.prefix.as_deref() {
            None | Some("") => material.token.clone(),
            Some(prefix) => format!("{prefix} {}", material.token),
        },
    };
    headers.insert(auth_name.to_string(), value);
}

/// 声明查询参数:字面量原样,文件形式当次读取并取 JSON Pointer。
pub(super) fn apply_query_values(
    url: &str,
    query: &BTreeMap<String, QueryValue>,
) -> Result<String, String> {
    if query.is_empty() {
        return Ok(url.to_string());
    }
    let mut parsed = reqwest::Url::parse(url).map_err(|_| "request URL is invalid".to_string())?;
    {
        let mut pairs = parsed.query_pairs_mut();
        for (name, value) in query {
            let value = match value {
                QueryValue::Literal(text) => text.clone(),
                QueryValue::FromFile { file, pointer } => read_declared_value(file, pointer)?,
            };
            pairs.append_pair(name, &value);
        }
    }
    Ok(parsed.to_string())
}

fn read_declared_value(template: &str, pointer: &str) -> Result<String, String> {
    let path = resolve_home_path(template)?.ok_or_else(|| "home directory is unavailable".to_string())?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("query value source is unreadable: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_DECLARED_VALUE_BYTES {
        return Err("query value source is not a readable file".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "query value source is not valid JSON".to_string())?;
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("query value pointer {pointer} is missing"))
}

pub(super) struct CredentialMaterial {
    pub(super) token: String,
    pub(super) extra_headers: BTreeMap<String, String>,
}

fn parse_credential_material_from_value(
    credential: &UsageCredentialSpec,
    value: &Value,
) -> Result<Option<CredentialMaterial>, String> {
    for scope in credential_scopes(value, credential) {
        let token = match credential
            .token_pointer
            .as_deref()
            .and_then(|pointer| first_string(scope, &[pointer.to_string()]))
        {
            Some(token) if !token.trim().is_empty() => token.trim().to_string(),
            _ => continue,
        };
        let mut extra_headers = BTreeMap::new();
        for (name, pointer) in &credential.header_pointers {
            if let Some(header_value) = first_header_value(scope, pointer) {
                extra_headers.insert(name.clone(), header_value);
            }
        }
        return Ok(Some(CredentialMaterial {
            token,
            extra_headers,
        }));
    }
    Ok(None)
}

pub(super) fn read_credential_material(
    credential: &UsageCredentialSpec,
    path: &Path,
) -> Result<Option<CredentialMaterial>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("credential target is not a regular file".to_string());
    }
    if metadata.len() == 0 {
        return Ok(None);
    }
    if metadata.len() > MAX_CREDENTIAL_BYTES {
        return Err("credential file exceeds the size limit".to_string());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "credential file is not valid JSON".to_string())?;
    parse_credential_material_from_value(credential, &value)
}

fn credential_scopes<'a>(root: &'a Value, credential: &UsageCredentialSpec) -> Vec<&'a Value> {
    if !credential.from_object_values {
        return vec![root];
    }
    let Some(object) = root.as_object() else {
        return vec![root];
    };
    let mut preferred = Vec::new();
    let mut others = Vec::new();
    for (key, value) in object {
        if !value.is_object() {
            continue;
        }
        if credential
            .prefer_key_prefix
            .as_deref()
            .is_some_and(|prefix| key == prefix || key.starts_with(prefix))
        {
            preferred.push(value);
        } else {
            others.push(value);
        }
    }
    preferred.append(&mut others);
    if preferred.is_empty() {
        vec![root]
    } else {
        preferred
    }
}

pub(super) fn first_value<'a>(root: &'a Value, pointers: &[String]) -> Option<&'a Value> {
    pointers.iter().find_map(|pointer| root.pointer(pointer))
}

pub(super) fn first_string(root: &Value, pointers: &[String]) -> Option<String> {
    match first_value(root, pointers)? {
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn first_header_value(root: &Value, pointer: &str) -> Option<String> {
    let value = first_string(root, &[pointer.to_string()])?;
    if value.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return None;
    }
    Some(value)
}

// ─── 路径与 URL 边界 ─────────────────────────────────────────────────
/// `${home}` 前缀变量展开。`Ok(None)` = home 目录不可用。
/// 声明必须以 `${home}` 为根(不允许任意绝对路径)、拒绝其他占位符、
/// NUL、未闭合 `${`、父目录穿越——与旧契约实现同规则,砍掉
/// `${workspace}`(用户级查询声明无工作区上下文)。
pub(crate) fn resolve_home_path(template: &str) -> Result<Option<PathBuf>, String> {
    if template.trim().is_empty() {
        return Err("path must not be empty".to_string());
    }
    if template.contains('\0') {
        return Err("path must not contain NUL characters".to_string());
    }
    if !template.starts_with("${home}") {
        return Err("path must be rooted at ${home}".to_string());
    }
    let mut cursor = 0;
    while let Some(relative_start) = template[cursor..].find("${") {
        let start = cursor + relative_start;
        let Some(relative_end) = template[start + 2..].find('}') else {
            return Err("contains an unterminated placeholder".to_string());
        };
        let end = start + 2 + relative_end;
        let placeholder = &template[start + 2..end];
        if placeholder != "home" {
            return Err(format!(
                "contains unsupported placeholder ${{{placeholder}}}"
            ));
        }
        cursor = end + 1;
    }
    if template[cursor..].contains("${") {
        return Err("contains an unterminated placeholder".to_string());
    }
    if Path::new(template)
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return Err("path traversal is not allowed".to_string());
    }
    let home = match dirs::home_dir() {
        Some(path) => path.to_string_lossy().to_string(),
        None => return Ok(None),
    };
    Ok(Some(PathBuf::from(template.replace("${home}", &home))))
}

pub(super) fn validate_https_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "usage URL is invalid".to_string())?;
    if url.scheme() != "https" {
        return Err("usage URL must use https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("usage URL must not contain credentials".to_string());
    }
    if url.host_str().is_none() {
        return Err("usage URL must include a host".to_string());
    }
    Ok(())
}

// ─── HTTP ────────────────────────────────────────────────────────────
/// 发送声明请求并返回原始响应体:超时、重试与大小上限集中在此。
async fn fetch_body(request: &PreparedQuery, max_bytes: usize) -> Result<(u16, Vec<u8>), String> {
    // 每 call 新建 client 是有意的:reqwest 在 build 时读代理 env,
    // per-call 能吃到运行时变动的代理设置(与 model_provider::models 同模式)。
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(2))
        .build()
        .map_err(|error| error.to_string())?;
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        let header_name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "usage header name is invalid")?;
        let header_value =
            HeaderValue::from_str(value).map_err(|_| "usage header value is invalid")?;
        headers.insert(header_name, header_value);
    }
    if !headers.contains_key(reqwest::header::USER_AGENT) {
        headers.insert(
            reqwest::header::USER_AGENT,
            HeaderValue::from_static("Berth/1.0"),
        );
    }
    let mut last_error = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        let builder = match request.method.as_str() {
            "GET" => client.get(&request.url),
            "POST" => client.post(&request.url).json(
                &request
                    .body
                    .clone()
                    .unwrap_or(serde_json::Value::Object(Map::new())),
            ),
            _ => return Err("usage request method is not supported".to_string()),
        };
        let response = match builder.headers(headers.clone()).send().await {
            Ok(resp) => resp,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        let status = response.status().as_u16();
        let bytes = match response.bytes().await {
            Ok(b) => b,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        if bytes.len() > max_bytes {
            return Err("response exceeds the size limit".to_string());
        }
        return Ok((status, bytes.to_vec()));
    }
    Err(last_error)
}

/// agent 类型 → 工具资产 id(声明与凭据都挂在工具资产上)。
pub(super) fn resolve_agent_subject(agent: &str) -> String {
    crate::tool::profile::list_agent_profiles()
        .into_iter()
        .find(|profile| profile.project_type.as_deref() == Some(agent))
        .map(|profile| profile.id)
        .unwrap_or_else(|| agent.to_string())
}
