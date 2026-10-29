//! 账号用量语义:声明模型、窗口映射与查询入口。
//!
//! 一个执行器 + 纯数据声明,零品牌分支:新增 agent 只落一份
//! `tools/<agent>/tool.json` 的 `usage` 声明,零代码改动。
//! 请求与凭据来自 `super::declared`;站点余额见 `super::balance`;命令见 `super::commands`。
//!
//! 失败一律折叠成 `UsageStatus`(Missing/Unavailable/Error)供前端渲染,不 reject、
//! 不回落缓存冒充成功。

use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tool::path::is_valid_manifest_id;

use super::declared::{
    declared_credential, fetch_prepared_json, first_string, first_value, prepare_declared_query,
    resolve_agent_subject, resolve_home_path, DeclaredJsonRequest, DeclaredQueryError,
    UsageCredentialSpec,
};

// ─── 声明模型(serde,deny_unknown_fields 防笔误静默通过) ─────────────
/// `tools/<agent>/tool.json` 中 `extensions.org.berth.agent.usage` 的投影。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageDeclaration {
    /// Popover 标题;缺省时前端回退到 agent 目录名。
    #[serde(default)]
    pub label: Option<String>,
    /// 本机 JSON 快照(`${home}` 起始),由 CLI 自己写出(如 Claude statusline)。
    /// 读文件即得用量:不出网、不读凭据。与 `request` 二选一。
    #[serde(default)]
    pub path: Option<String>,
    /// 包内脚本 / CLI 自带命令(argv 不经 shell,`${package}` = 包目录),stdout 为 JSON;
    /// 从 CLI 自己写的本地记录里摘额度,不出网、不读凭据。可带顶层 `updatedAt`(毫秒)。
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub credential: UsageCredentialSpec,
    /// 用量、余额、模型目录共用同一请求声明(见 `DeclaredJsonRequest`)。
    #[serde(default)]
    pub request: DeclaredJsonRequest,
    #[serde(default)]
    pub plan_type_pointers: Vec<String>,
    #[serde(default = "default_windows")]
    pub windows: Vec<UsageWindowSpec>,
}

fn default_windows() -> Vec<UsageWindowSpec> {
    Vec::new()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageWindowSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub used_percent_pointers: Vec<String>,
    /// 与 limitPointers 配对算百分比(used/limit)。
    #[serde(default)]
    pub used_pointers: Vec<String>,
    #[serde(default)]
    pub limit_pointers: Vec<String>,
    /// 余量绝对值(中转站余额),与百分比互不影响。
    #[serde(default)]
    pub remaining_pointers: Vec<String>,
    /// 余量/used/limit 的乘法因子(novita 的 0.0001 USD 单位)。
    #[serde(default = "default_value_scale")]
    pub value_scale: f64,
    #[serde(default)]
    pub resets_at_pointers: Vec<String>,
    #[serde(default)]
    pub window_minutes: Option<u32>,
    /// 余量单位(如 "CNY" / "USD"),仅展示用。
    #[serde(default)]
    pub unit: Option<String>,
}

fn default_value_scale() -> f64 {
    1.0
}

// ─── 运行时状态(前端 wire 类型) ─────────────────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus {
    /// 查询成功(窗口可能为空——响应无可用数据)。
    Ready,
    /// 凭据不存在(未登录,前端不渲染该 agent)。
    Missing,
    /// 声明/环境不可用(坏 JSON、未知 credential kind、无 home 目录)。
    Unavailable,
    /// 请求被拒或确定性失败(401/403/非 2xx)。
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: Option<i32>,
    /// 绝对值用量(只给绝对值、不给分母的服务商,如 grok 的月度 used)。
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub unit: Option<String>,
    pub window_minutes: Option<u32>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageDiagnostic {
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageState {
    /// agent 目录名,或站点余额模板 id。
    pub subject: String,
    pub status: UsageStatus,
    pub plan_type: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub updated_at: Option<i64>,
    pub diagnostics: Vec<UsageDiagnostic>,
}

impl UsageState {
    pub(crate) fn new(subject: &str, status: UsageStatus) -> Self {
        Self {
            subject: subject.to_string(),
            status,
            plan_type: None,
            windows: Vec::new(),
            updated_at: None,
            diagnostics: Vec::new(),
        }
    }

    fn with_diagnostic(mut self, severity: &str, message: impl Into<String>) -> Self {
        self.diagnostics.push(UsageDiagnostic {
            severity: severity.to_string(),
            message: message.into(),
        });
        self
    }
}

// ─── 入口:从工具资产读取声明 ──────────────────────────
/// 逐个执行工具资产中的用量查询声明。
///
/// 坏声明 → unavailable 状态(不拖垮其他 agent);网络抖动 → error 状态。
/// ponytail: 串行逐 agent 查询;agent 多到轮询变慢再并发。
pub async fn read_all() -> Vec<UsageState> {
    let mut states = Vec::new();
    for subject in crate::tool::asset_repository::list_tool_asset_ids() {
        match read_declaration(&subject) {
            Ok(Some(declaration)) => match execute(&subject, &declaration, None).await {
                Ok(state) => states.push(state),
                Err(reason) => states.push(
                    UsageState::new(&subject, UsageStatus::Error)
                        .with_diagnostic("error", reason),
                ),
            },
            Ok(None) => {}
            Err(reason) => states.push(
                UsageState::new(&subject, UsageStatus::Unavailable)
                    .with_diagnostic("error", reason),
            ),
        }
    }
    states
}

pub async fn read_for_agent(
    agent: &str,
    custom_credential: Option<&str>,
) -> Result<UsageState, String> {
    let subject = resolve_agent_subject(agent);
    if !is_valid_manifest_id(&subject) {
        return Err("agent id is invalid".to_string());
    }
    let Some(declaration) = read_declaration(&subject)? else {
        return Ok(
            UsageState::new(&subject, UsageStatus::Unavailable)
                .with_diagnostic("info", "account usage query is not declared"),
        );
    };
    execute_internal(&subject, &declaration, None, custom_credential).await
}

fn read_declaration(subject: &str) -> Result<Option<UsageDeclaration>, String> {
    let asset = crate::tool::asset_repository::load_tool_asset(subject)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "tool asset is missing".to_string())?;
    let Some(extension) = asset.agent_extension() else {
        return Ok(None);
    };
    parse_declaration(subject, extension)
}

fn parse_declaration(subject: &str, extension: &Value) -> Result<Option<UsageDeclaration>, String> {
    let Some(usage) = extension.get("usage") else {
        return Ok(None);
    };
    let mut declaration: UsageDeclaration =
        serde_json::from_value(usage.clone()).map_err(|error| error.to_string())?;
    let local = usize::from(declaration.path.is_some()) + usize::from(declaration.command.is_some());
    match (local, declaration.request.url.is_empty()) {
        (0, true) => return Err("usage must declare path, command or request".to_string()),
        (1, true) => return Ok(Some(declaration)),
        (0, false) => {}
        _ => return Err("usage must declare exactly one of path / command / request".to_string()),
    }
    if declaration.credential.kind == "tool-ref" {
        let id = declaration
            .credential
            .path
            .as_deref()
            .filter(|id| is_valid_manifest_id(id))
            .ok_or_else(|| "credential reference is invalid".to_string())?;
        declaration.credential = declared_credential(subject, id)?;
    }
    Ok(Some(declaration))
}

// ─── 执行器:凭据 → 请求 → 窗口映射 ─────────────────────────────────
/// 执行单份声明:凭据就绪 → 发请求 → 映射响应到 `UsageState`。
///
/// `Err` = 瞬时传输失败(调用方决定重试语义);其余一切确定性结果都是
/// `Ok(UsageState)`。
pub(crate) async fn execute(
    subject: &str,
    declaration: &UsageDeclaration,
    provider_key: Option<&str>,
) -> Result<UsageState, String> {
    execute_internal(subject, declaration, provider_key, None).await
}

pub(crate) async fn execute_internal(
    subject: &str,
    declaration: &UsageDeclaration,
    provider_key: Option<&str>,
    custom_credential: Option<&str>,
) -> Result<UsageState, String> {
    if let Some(template) = declaration.path.as_deref() {
        return Ok(read_snapshot(subject, declaration, template));
    }
    if let Some(command) = declaration.command.as_deref() {
        return Ok(read_command(subject, declaration, command).await);
    }
    // 全部失败都归成状态(不 reject):前端按 UsageStatus 渲染,与 401/403 同一路径。
    let state = match prepare_declared_query(
        &declaration.credential,
        provider_key,
        custom_credential,
        &declaration.request,
    ) {
        Ok(prepared) => match fetch_prepared_json(prepared).await {
            Ok(json) => map_usage_response(subject, declaration, json),
            Err(error) => usage_state_for_error(subject, error),
        },
        Err(error) => usage_state_for_error(subject, error),
    };
    Ok(state)
}

/// 本机快照上限:statusline 输入只有几 KB。
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024;

/// 读本机快照:文件还没写出 = Missing,其余读不到 = Unavailable;
/// `updated_at` 取文件修改时间,不把旧快照冒充成刚查到的。
fn read_snapshot(subject: &str, declaration: &UsageDeclaration, template: &str) -> UsageState {
    let unavailable = |message: String| {
        UsageState::new(subject, UsageStatus::Unavailable).with_diagnostic("error", message)
    };
    let path = match resolve_home_path(template) {
        Ok(Some(path)) => path,
        Ok(None) => return unavailable("home directory is unavailable".to_string()),
        Err(error) => return unavailable(error),
    };
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_SNAPSHOT_BYTES => metadata,
        Ok(_) => return unavailable("usage snapshot is not a readable file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return UsageState::new(subject, UsageStatus::Missing)
                .with_diagnostic("info", "usage snapshot has not been written yet");
        }
        Err(error) => return unavailable(error.to_string()),
    };
    let json = match std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(json) => json,
        None => return unavailable("usage snapshot is not valid JSON".to_string()),
    };
    let mut state = map_usage_response(subject, declaration, json);
    state.updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64);
    state
}

/// 跑声明的本地命令取用量;失败归成 Unavailable,不 reject。
async fn read_command(subject: &str, declaration: &UsageDeclaration, command: &[String]) -> UsageState {
    match crate::model_provider::login::run_package_command(subject, command).await {
        Ok(json) => {
            let updated_at = json.get("updatedAt").and_then(Value::as_i64);
            let mut state = map_usage_response(subject, declaration, json);
            if updated_at.is_some() {
                state.updated_at = updated_at;
            }
            state
        }
        Err(error) => UsageState::new(subject, UsageStatus::Unavailable).with_diagnostic("error", error),
    }
}

/// 声明式失败分类 → 用量状态(wire 语义在 `UsageStatus`)。
fn usage_state_for_error(subject: &str, error: DeclaredQueryError) -> UsageState {
    match error {
        DeclaredQueryError::Missing(message) => {
            UsageState::new(subject, UsageStatus::Missing).with_diagnostic("info", message)
        }
        DeclaredQueryError::Unavailable(message) => {
            UsageState::new(subject, UsageStatus::Unavailable).with_diagnostic("error", message)
        }
        DeclaredQueryError::Failed(message) => {
            UsageState::new(subject, UsageStatus::Error).with_diagnostic("error", message)
        }
    }
}

fn map_usage_response(subject: &str, declaration: &UsageDeclaration, json: Value) -> UsageState {
    let windows = declaration
        .windows
        .iter()
        .filter_map(|spec| map_window(spec, &json))
        .collect::<Vec<_>>();
    let plan_type = first_string(&json, &declaration.plan_type_pointers);
    UsageState {
        subject: subject.to_string(),
        status: UsageStatus::Ready,
        plan_type,
        windows,
        updated_at: Some(now_ms()),
        diagnostics: Vec::new(),
    }
}

fn map_window(spec: &UsageWindowSpec, json: &Value) -> Option<UsageWindow> {
    let scale = if spec.value_scale.is_finite() && spec.value_scale > 0.0 {
        spec.value_scale
    } else {
        1.0
    };
    let used = first_value(json, &spec.used_pointers)
        .and_then(as_finite_f64)
        .map(|value| value * scale);
    let used_percent = first_value(json, &spec.used_percent_pointers)
        .and_then(as_percent)
        .or_else(|| {
            let used = first_value(json, &spec.used_pointers)?;
            let limit = first_value(json, &spec.limit_pointers)?;
            ratio_percent(used, limit, spec.value_scale)
        });
    let remaining = first_value(json, &spec.remaining_pointers)
        .and_then(as_finite_f64)
        .map(|value| value * scale);
    let resets_at = first_value(json, &spec.resets_at_pointers).and_then(as_timestamp_ms);
    // 百分比、余量、绝对值、重置时间四者全无才弃掉(声明指针笔误/响应变形走这里)。
    // 只给绝对值(limit 缺失或 0)或只给重置时间都是合法上游形态,保留后分别显示
    // "已用 N" / "N 后重置"。
    if used_percent.is_none() && remaining.is_none() && used.is_none() && resets_at.is_none() {
        return None;
    }
    Some(UsageWindow {
        id: spec.id.clone(),
        label: spec.label.clone(),
        used_percent,
        used,
        remaining,
        unit: spec.unit.clone(),
        window_minutes: spec.window_minutes,
        resets_at,
    })
}

fn as_finite_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(text) => text.parse::<f64>().ok().filter(|value| value.is_finite()),
        _ => None,
    }
}

fn as_percent(value: &Value) -> Option<i32> {
    Some(as_finite_f64(value)?.round().clamp(0.0, 100.0) as i32)
}

fn ratio_percent(used: &Value, limit: &Value, scale: f64) -> Option<i32> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let used = as_finite_f64(used)? * scale;
    let limit = as_finite_f64(limit)? * scale;
    if limit <= 0.0 {
        return None;
    }
    Some(((used / limit) * 100.0).round().clamp(0.0, 100.0) as i32)
}

fn as_timestamp_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number_to_timestamp_ms(number.as_f64()?),
        Value::String(text) => {
            if let Ok(number) = text.parse::<f64>() {
                return number_to_timestamp_ms(number);
            }
            DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|value| value.with_timezone(&Utc).timestamp_millis())
        }
        _ => None,
    }
}

fn number_to_timestamp_ms(value: f64) -> Option<i64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(if value > 10_000_000_000.0 {
        value as i64
    } else {
        (value * 1000.0) as i64
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Write;

    use std::fs;
    use std::path::PathBuf;

    use crate::model_provider::declared::{
        apply_query_values, read_credential_material, resolve_home_path,
        server_error_hint, validate_https_url, AuthHeaderSpec, QueryValue,
    };

    /// 失败响应提示：有界、去控制字符；非 JSON 或没有 error 字段时留空。
    #[test]
    fn server_error_hint_is_bounded_and_reads_nested_error() {
        let hint = server_error_hint(
            br#"{"error":{"message":"Invalid or expired credentials (auth_kind=bearer)"}}"#,
        );
        assert_eq!(hint, ": Invalid or expired credentials (auth_kind=bearer)");
        assert_eq!(server_error_hint(b"<html>404</html>"), "");
        assert_eq!(server_error_hint(br#"{"detail":"no error key"}"#), "");
        let long = format!("{{\"error\":\"{}\"}}", "x".repeat(400));
        assert!(server_error_hint(long.as_bytes()).chars().count() <= 202);
    }

    /// 声明查询参数：字面量原样追加；文件形式必须 rooted at `${home}`。
    #[test]
    fn declared_query_values_append_and_reject_loose_paths() {
        let mut literal = BTreeMap::new();
        literal.insert(
            "client_version".to_string(),
            QueryValue::Literal("0.155.1".to_string()),
        );
        let url = apply_query_values("https://example.invalid/models", &literal).unwrap();
        assert_eq!(url, "https://example.invalid/models?client_version=0.155.1");

        let mut loose = BTreeMap::new();
        loose.insert(
            "client_version".to_string(),
            QueryValue::FromFile {
                file: "/tmp/not-home.json".to_string(),
                pointer: "/client_version".to_string(),
            },
        );
        let error = apply_query_values("https://example.invalid/models", &loose).unwrap_err();
        assert!(error.contains("${home}"), "unexpected error: {error}");
    }

    #[test]
    fn usage_resolves_named_credential_without_agent_branches() {
        let lock = crate::tool::path::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let home = tempfile::tempdir().unwrap();
        let package = home.path().join("tools/example");
        fs::create_dir_all(&package).unwrap();
        std::env::set_var("BERTH_HOME", home.path());
        let mut usage = sample_declaration("billing");
        usage.credential.kind = "tool-ref".into();
        fs::write(
            package.join("tool.json"),
            serde_json::json!({
                "protocol": "berth.tool/1",
                "id": "example",
                "identity": {"name": "Example", "roles": ["agent"]},
                "extensions": {"org.berth.agent": {
                    "projectType": "example",
                    "credentials": {
                        "login": {"kind": "json-file", "path": "${home}/.example/login.json", "tokenPointer": "/access"},
                        "billing": {"kind": "json-file", "path": "${home}/.example/billing.json", "tokenPointer": "/key"}
                    },
                    "usage": usage
                }}
            })
            .to_string(),
        )
        .unwrap();
        let resolved = read_declaration("example").unwrap().unwrap();
        assert_eq!(
            resolved.credential.path.as_deref(),
            Some("${home}/.example/billing.json")
        );
        assert_eq!(resolved.credential.token_pointer.as_deref(), Some("/key"));
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
    }

    /// 最小请求声明:无 query/头/body,便于逐字段断言。
    fn declared_request(method: &str, url: &str) -> DeclaredJsonRequest {
        DeclaredJsonRequest {
            method: method.into(),
            url: url.into(),
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
            body: None,
        }
    }

    /// provider-key 凭据声明(站点余额形态)。
    fn provider_declaration(
        auth_header: Option<AuthHeaderSpec>,
        request: DeclaredJsonRequest,
    ) -> UsageDeclaration {
        UsageDeclaration {
            label: None,
            credential: UsageCredentialSpec {
                kind: "provider-key".into(),
                path: None,
                token_pointer: None,
                header_pointers: BTreeMap::new(),
                from_object_values: false,
                prefer_key_prefix: None,
                auth_header,
            },
            request,
            path: None,
            command: None,
            plan_type_pointers: Vec::new(),
            windows: Vec::new(),
        }
    }

    /// json-file 凭据声明(agent 官方形态)。
    fn file_declaration(path: String, request: DeclaredJsonRequest) -> UsageDeclaration {
        UsageDeclaration {
            label: None,
            credential: UsageCredentialSpec {
                kind: "json-file".into(),
                path: Some(path),
                token_pointer: Some("/accessToken".into()),
                header_pointers: BTreeMap::new(),
                from_object_values: false,
                prefer_key_prefix: None,
                auth_header: None,
            },
            request,
            path: None,
            command: None,
            plan_type_pointers: Vec::new(),
            windows: Vec::new(),
        }
    }

    fn sample_declaration(path: &str) -> UsageDeclaration {
        UsageDeclaration {
            label: Some("Plan usage".into()),
            path: None,
            command: None,
            credential: UsageCredentialSpec {
                kind: "json-file".into(),
                path: Some(path.into()),
                token_pointer: Some("/accessToken".into()),
                header_pointers: BTreeMap::from([("X-Account".into(), "/accountId".into())]),
                from_object_values: false,
                prefer_key_prefix: None,
                auth_header: None,
            },
            request: DeclaredJsonRequest {
                method: "GET".into(),
                url: "https://example.invalid/usage".into(),
                query: BTreeMap::new(),
                headers: BTreeMap::from([("Accept".into(), "application/json".into())]),
                body: None,
            },
            plan_type_pointers: vec!["/planType".into()],
            windows: vec![
                UsageWindowSpec {
                    id: "session".into(),
                    label: "5h".into(),
                    used_percent_pointers: vec!["/session/used".into()],
                    used_pointers: Vec::new(),
                    limit_pointers: Vec::new(),
                    remaining_pointers: Vec::new(),
                    value_scale: 1.0,
                    resets_at_pointers: vec!["/session/reset".into()],
                    window_minutes: Some(300),
                    unit: None,
                },
                UsageWindowSpec {
                    id: "monthly".into(),
                    label: "30d".into(),
                    used_percent_pointers: Vec::new(),
                    used_pointers: vec!["/used/val".into(), "/config/used/val".into()],
                    limit_pointers: vec!["/limit/val".into(), "/config/limit/val".into()],
                    remaining_pointers: Vec::new(),
                    value_scale: 1.0,
                    resets_at_pointers: vec!["/end".into()],
                    window_minutes: Some(43_200),
                    unit: None,
                },
            ],
        }
    }

    #[test]
    fn maps_percent_ratio_and_timestamp_windows() {
        let declaration = sample_declaration("${home}/auth.json");
        let json = serde_json::json!({
            "planType": "plus",
            "session": { "used": 12.4, "reset": 1_700_000_000 },
            "config": { "used": { "val": "30" }, "limit": { "val": "100" } },
            "end": "2024-01-02T03:04:05Z"
        });
        let state = map_usage_response("demo", &declaration, json);
        assert_eq!(state.status, UsageStatus::Ready);
        assert_eq!(state.plan_type.as_deref(), Some("plus"));
        assert_eq!(state.windows[0].used_percent, Some(12));
        assert_eq!(state.windows[0].resets_at, Some(1_700_000_000_000));
        assert_eq!(state.windows[1].used_percent, Some(30));
        assert!(state.windows[1].resets_at.is_some());
    }

    #[test]
    fn maps_remaining_with_value_scale() {
        let spec = UsageWindowSpec {
            id: "balance".into(),
            label: "Balance".into(),
            used_percent_pointers: Vec::new(),
            used_pointers: Vec::new(),
            limit_pointers: Vec::new(),
            remaining_pointers: vec!["/availableBalance".into()],
            value_scale: 0.0001,
            resets_at_pointers: Vec::new(),
            window_minutes: None,
            unit: Some("USD".into()),
        };
        let json = serde_json::json!({ "availableBalance": 12345.0 });
        let window = map_window(&spec, &json).unwrap();
        assert_eq!(window.used_percent, None);
        assert!((window.remaining.unwrap() - 1.2345).abs() < 1e-9);
        assert_eq!(window.unit.as_deref(), Some("USD"));
    }

    #[test]
    fn skips_windows_without_usable_numbers() {
        let declaration = sample_declaration("${home}/auth.json");
        let state = map_usage_response("demo", &declaration, serde_json::json!({}));
        assert!(state.windows.is_empty());
        assert_eq!(state.status, UsageStatus::Ready);
    }

    /// 只有绝对值 used、没有可用分母(limit 缺失或 0)的窗口也要保留:
    /// 上游只给绝对值时,界面显示"已用 N"而不是把窗口丢掉。
    /// 上游只给重置时间（没有百分比/绝对值/余量）时也要保留窗口:
    /// 界面至少能告诉用户"什么时候重置"。
    #[test]
    fn maps_reset_only_window_when_upstream_gives_no_numbers() {
        let mut declaration = sample_declaration("${home}/auth.json");
        declaration.windows = vec![UsageWindowSpec {
            id: "weekly".into(),
            label: "7d".into(),
            used_percent_pointers: vec!["/config/creditUsagePercent".into()],
            used_pointers: Vec::new(),
            limit_pointers: Vec::new(),
            remaining_pointers: Vec::new(),
            value_scale: 1.0,
            resets_at_pointers: vec!["/config/currentPeriod/end".into()],
            window_minutes: Some(10_080),
            unit: None,
        }];
        // 只有周期结束时间:creditUsagePercent 缺失(grok 当前上游行为)。
        let json = serde_json::json!({
            "config": {"currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "end": 1_790_000_000}}
        });
        let state = map_usage_response("grok", &declaration, json);
        assert_eq!(state.windows.len(), 1);
        assert_eq!(state.windows[0].used_percent, None);
        assert_eq!(state.windows[0].used, None);
        assert!(state.windows[0].resets_at.is_some());
        assert_eq!(state.windows[0].window_minutes, Some(10_080));
    }

    #[test]
    fn maps_used_only_window_without_percentage() {
        let mut declaration = sample_declaration("${home}/auth.json");
        declaration.windows = vec![UsageWindowSpec {
            id: "used".into(),
            label: "Used".into(),
            used_percent_pointers: Vec::new(),
            used_pointers: vec!["/config/used/val".into()],
            limit_pointers: vec!["/config/monthlyLimit/val".into()],
            remaining_pointers: Vec::new(),
            value_scale: 1.0,
            resets_at_pointers: vec!["/config/billingPeriodEnd".into()],
            window_minutes: Some(43_200),
            unit: Some("credits".into()),
        }];
        let json = serde_json::json!({
            "config": {
                "used": {"val": 2},
                "monthlyLimit": {"val": 0},
                "billingPeriodEnd": 1_790_000_000
            }
        });
        let state = map_usage_response("grok", &declaration, json);
        assert_eq!(state.windows.len(), 1);
        assert_eq!(state.windows[0].used, Some(2.0));
        assert_eq!(
            state.windows[0].used_percent, None,
            "limit 为 0 时不算百分比"
        );
        assert_eq!(state.windows[0].unit.as_deref(), Some("credits"));
        assert!(state.windows[0].resets_at.is_some());
    }

    #[test]
    fn rejects_non_https_urls() {
        assert!(validate_https_url("http://example.com/usage").is_err());
        assert!(validate_https_url("https://user:pass@example.com/usage").is_err());
        assert!(validate_https_url("https://example.com/usage").is_ok());
    }

    #[test]
    fn credential_read_does_not_echo_token() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(br#"{"accessToken":"secret-token","accountId":"acc-1"}"#)
            .unwrap();
        let declaration = sample_declaration("${home}/auth.json");
        let material = read_credential_material(&declaration.credential, file.path())
            .unwrap()
            .unwrap();
        assert_eq!(material.token, "secret-token");
        assert_eq!(material.extra_headers["X-Account"], "acc-1");
        let state = UsageState::new("demo", UsageStatus::Ready);
        let encoded = serde_json::to_string(&state).unwrap();
        assert!(!encoded.contains("secret-token"));
    }

    #[test]
    fn object_value_scan_reads_nested_issuer_entries() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(
            br#"{
              "https://other.example/iss": {"key":"other-tok","user_id":"u-other"},
              "https://auth.x.ai::abc": {"key":"xai-tok","user_id":"u-1"}
            }"#,
        )
        .unwrap();
        let mut declaration = sample_declaration("${home}/auth.json");
        declaration.credential.token_pointer = Some("/key".into());
        declaration.credential.header_pointers =
            BTreeMap::from([("x-userid".into(), "/user_id".into())]);
        declaration.credential.from_object_values = true;
        declaration.credential.prefer_key_prefix = Some("https://auth.x.ai".into());
        let material = read_credential_material(&declaration.credential, file.path())
            .unwrap()
            .unwrap();
        assert_eq!(material.token, "xai-tok");
        assert_eq!(material.extra_headers["x-userid"], "u-1");
    }

    #[test]
    fn missing_credential_file_is_not_an_error() {
        let declaration = sample_declaration("${home}/auth.json");
        let missing = PathBuf::from("/tmp/berth-missing-account-usage.json");
        assert!(read_credential_material(&declaration.credential, &missing)
            .unwrap()
            .is_none());
    }

    #[test]
    fn prepare_query_injects_bearer_and_declaration_headers() {
        // 声明路径必须 ${home} 根;凭据文件落在 home 下的一次性目录,
        // 内容是无害假 token,失败残留也无妨,不做事后清理。
        let home = dirs::home_dir().unwrap();
        let unique = format!(".berth-usage-test-{}", now_ms());
        let directory = home.join(&unique);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("auth.json"),
            br#"{"accessToken":"tok-1","accountId":"acc-9"}"#,
        )
        .unwrap();
        let mut request = declared_request("GET", "https://example.com/usage");
        request.headers = BTreeMap::from([
            ("Accept".into(), "application/json".into()),
            // 声明头不得覆盖 Authorization。
            ("authorization".into(), "Bearer declared".into()),
        ]);
        let declaration = file_declaration(format!("${{home}}/{unique}/auth.json"), request);
        let prepared =
            prepare_declared_query(&declaration.credential, None, None, &declaration.request)
                .expect("credential file exists");
        assert_eq!(prepared.method, "GET");
        assert_eq!(prepared.headers.get("Authorization").unwrap(), "Bearer tok-1");
        assert_eq!(prepared.headers.get("Accept").unwrap(), "application/json");
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// 本机快照:不出网、不要凭据;没写出 = Missing,写出后按指针映射窗口。
    #[test]
    fn snapshot_usage_reads_local_file_without_request() {
        let home = dirs::home_dir().unwrap();
        let unique = format!(".berth-usage-snapshot-test-{}", now_ms());
        let extension = serde_json::json!({ "usage": {
            "path": format!("${{home}}/{unique}/usage.json"),
            "windows": [{
                "id": "five_hour", "label": "5h",
                "usedPercentPointers": ["/rate_limits/five_hour/used_percentage"],
                "resetsAtPointers": ["/rate_limits/five_hour/resets_at"]
            }]
        }});
        let declaration = parse_declaration("claude", &extension)
            .expect("path-only usage is valid")
            .expect("declared");

        let missing = read_snapshot("claude", &declaration, declaration.path.as_deref().unwrap());
        assert_eq!(missing.status, UsageStatus::Missing);

        let directory = home.join(&unique);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("usage.json"),
            br#"{"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600}}}"#,
        )
        .unwrap();
        let ready = read_snapshot("claude", &declaration, declaration.path.as_deref().unwrap());
        assert_eq!(ready.status, UsageStatus::Ready);
        assert_eq!(ready.windows[0].used_percent, Some(24));
        assert_eq!(ready.windows[0].resets_at, Some(1_738_425_600_000));
        assert!(ready.updated_at.is_some());
        let _ = std::fs::remove_dir_all(&directory);

        // path 与 request 必须二选一。
        let both = serde_json::json!({ "usage": {
            "path": "${home}/x.json",
            "request": { "method": "GET", "url": "https://example.com/usage" }
        }});
        assert!(parse_declaration("claude", &both).is_err());
        let neither = serde_json::json!({ "usage": { "windows": [] } });
        assert!(parse_declaration("claude", &neither).is_err());
    }

    /// 缺文件与空文件都是「未登录」类别,由调用方映射成 Missing 状态。
    #[test]
    fn prepare_query_reports_missing_credentials() {
        let absent = file_declaration(
            "${home}/.berth-usage-absent/auth.json".into(),
            declared_request("GET", "https://example.com/usage"),
        );
        let error = prepare_declared_query(&absent.credential, None, None, &absent.request)
            .expect_err("missing credentials must not fetch");
        assert!(matches!(error, DeclaredQueryError::Missing(_)), "{error:?}");
        assert!(!error.to_string().contains("accessToken"));

        let home = dirs::home_dir().unwrap();
        let unique = format!(".berth-usage-empty-test-{}", now_ms());
        let directory = home.join(&unique);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("auth.json"), b"").unwrap();
        let empty = file_declaration(
            format!("${{home}}/{unique}/auth.json"),
            declared_request("GET", "https://example.com/usage"),
        );
        let error = prepare_declared_query(&empty.credential, None, None, &empty.request)
            .expect_err("empty credentials must not fetch");
        assert!(matches!(error, DeclaredQueryError::Missing(_)), "{error:?}");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn provider_key_uses_supplied_key_without_file() {
        let declaration =
            provider_declaration(None, declared_request("GET", "https://example.com/usage"));
        let prepared = prepare_declared_query(
            &declaration.credential,
            Some("sk-live"),
            None,
            &declaration.request,
        )
        .expect("supplied key");
        assert_eq!(
            prepared.headers.get("Authorization").unwrap(),
            "Bearer sk-live"
        );
        let error = prepare_declared_query(
            &declaration.credential,
            Some("  "),
            None,
            &declaration.request,
        )
        .expect_err("blank key must not fetch");
        assert!(matches!(error, DeclaredQueryError::Missing(_)), "{error:?}");
    }

    /// auth 头三形态:默认 Bearer、裸值(智谱)、自定义头名 + POST body 透传。
    #[test]
    fn auth_header_shapes_and_post_body() {
        // 裸值:智谱形态,Authorization 头直接是 key。
        let zhipu = provider_declaration(
            Some(AuthHeaderSpec {
                name: "Authorization".into(),
                prefix: Some(String::new()),
            }),
            declared_request("GET", "https://example.com/usage"),
        );
        let prepared =
            prepare_declared_query(&zhipu.credential, Some("sk-zp"), None, &zhipu.request)
                .expect("prepared");
        assert_eq!(prepared.headers.get("Authorization").unwrap(), "sk-zp");

        // 自定义头名 + POST body。
        let mut post = declared_request("POST", "https://example.com/usage");
        post.body = Some(serde_json::json!({"range": "week"}));
        let custom = provider_declaration(
            Some(AuthHeaderSpec {
                name: "X-Api-Key".into(),
                prefix: None,
            }),
            post,
        );
        let prepared =
            prepare_declared_query(&custom.credential, Some("sk-x"), None, &custom.request)
                .expect("prepared");
        assert_eq!(prepared.headers.get("X-Api-Key").unwrap(), "sk-x");
        assert!(!prepared.headers.contains_key("Authorization"));
        assert_eq!(prepared.body, Some(serde_json::json!({"range": "week"})));

        // 缺省 = Authorization: Bearer(现有声明零改动兼容)。
        let default = provider_declaration(
            None,
            declared_request("GET", "https://example.com/usage"),
        );
        let prepared =
            prepare_declared_query(&default.credential, Some("sk-d"), None, &default.request)
                .expect("prepared");
        assert_eq!(
            prepared.headers.get("Authorization").unwrap(),
            "Bearer sk-d"
        );
    }

    #[test]
    fn home_template_expansion_and_boundaries() {
        let home = dirs::home_dir().unwrap();
        let resolved = resolve_home_path("${home}/.codex/auth.json")
            .unwrap()
            .unwrap();
        assert_eq!(resolved, home.join(".codex/auth.json"));
        assert!(resolve_home_path("/absolute/auth.json").is_err());
        assert!(resolve_home_path("${home}/../etc/passwd").is_err());
        assert!(resolve_home_path("${other}/auth.json").is_err());
        assert!(resolve_home_path("${home/auth.json").is_err());
    }

    #[test]
    fn usage_declaration_rejects_bad_blocks() {
        assert!(parse_declaration("example", &serde_json::json!({})).unwrap().is_none());
        assert!(parse_declaration("example", &serde_json::json!({"usage": "bad"})).is_err());
        assert!(parse_declaration(
            "example",
            &serde_json::json!({"usage": {"unknownField": 1}})
        )
        .is_err());
    }
}
