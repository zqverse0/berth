//! 按服务商档案的 url/key 拉取模型列表(添加/编辑弹窗里用户显式点击
//! "获取模型列表"时调用——**绝不自动请求**,模型信息以档案预配置为
//! 唯一数据源)。
//!
//! 对齐 NewAPI / OpenAI 兼容网关的列表口径(参考 pi-provider-newapi):
//! 根地址去掉尾斜杠与 `/v1` 后,按**协议**(不按 Agent)选一种请求:
//!
//! - `chat`:`GET {root}/v1/models` + `Authorization: Bearer`;
//! - `claude`:同一地址 + `x-api-key` / `anthropic-version`;
//! - `gemini`:`GET {root}/v1beta/models?key=`。
//!
//! 每次调用恰好一个请求,失败不换鉴权头重试:一次点击连发多种鉴权失败的请求
//! 正是网关风控 / 封号的典型触发。换协议由前端按已填地址决定,且遇到
//! 鉴权 / 限流即停。
//!
//! 每个模型带上游声明的接口(new-api 的 `supported_endpoint_types`,归一为
//! `berth_tool_core::provider_injection::MODEL_APIS`);上游没给就是空,启动时按「未确认」处理。
//!
//! 凭据由调用方直传(添加弹窗尚无 provider id);失败返回带 i18n 分类的
//! 错误,由前端提示具体原因(密钥 / 地址 / 网络 / 服务商不支持),不落缓存。

use std::collections::BTreeMap;

use berth_tool_core::provider_injection::normalize_model_api;
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::Value;

use crate::app_error::{AppCommandError, AppErrorCode};

/// 请求超时:与 pi-provider-newapi 的 `/v1/models` 一致,用户显式点击。
const FETCH_TIMEOUT_SECS: u64 = 15;

/// 前端 `ModelProviderSettings` 命名空间下的相对 i18n key。
const I18N_EMPTY_URL: &str = "fetchError.emptyUrl";
const I18N_INVALID_URL: &str = "fetchError.invalidUrl";
const I18N_UNSUPPORTED_AGENT: &str = "fetchError.unsupportedAgent";
const I18N_TIMEOUT: &str = "fetchError.timeout";
const I18N_DNS: &str = "fetchError.dns";
const I18N_TLS: &str = "fetchError.tls";
const I18N_NETWORK: &str = "fetchError.network";
const I18N_AUTH: &str = "fetchError.auth";
const I18N_AUTH_MISSING_KEY: &str = "fetchError.authMissingKey";
const I18N_NOT_FOUND: &str = "fetchError.notFound";
const I18N_NOT_SUPPORTED: &str = "fetchError.notSupported";
const I18N_RATE_LIMITED: &str = "fetchError.rateLimited";
const I18N_SERVER: &str = "fetchError.server";
const I18N_NOT_JSON: &str = "fetchError.notJson";
const I18N_UNEXPECTED_SHAPE: &str = "fetchError.unexpectedShape";
const I18N_HTTP: &str = "fetchError.http";
const I18N_PROVIDER_FAILED: &str = "fetchError.providerFailed";

/// 拉取到的一个模型：id + 上游声明支持的接口（未声明为空）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FetchedModel {
    pub id: String,
    pub apis: Vec<String>,
}

/// 按协议 + 凭据拉取模型列表。空列表 = 端点可达但没有模型(合法)。
pub fn fetch(
    protocol: &str,
    api_url: &str,
    api_key: &str,
) -> impl std::future::Future<Output = Result<Vec<FetchedModel>, AppCommandError>> + Send {
    let protocol = protocol.to_string();
    let api_url = api_url.to_string();
    let api_key = api_key.trim().to_string();
    async move {
        let base = normalize_base_url(&api_url)?;
        match protocol.as_str() {
            "chat" => fetch_once(&base, &api_key, AuthFlavor::OpenAi).await,
            "claude" => fetch_once(&base, &api_key, AuthFlavor::Anthropic).await,
            "gemini" => fetch_gemini(&base, &api_key).await,
            other => Err(classified(
                AppErrorCode::InvalidInput,
                I18N_UNSUPPORTED_AGENT,
                format!("model listing is not defined for protocol '{other}'"),
                params(&[("agentType", other)]),
            )),
        }
    }
}

#[derive(Clone, Copy)]
enum AuthFlavor {
    OpenAi,
    Anthropic,
}

struct HttpJson {
    status: StatusCode,
    body: String,
}

/// 去掉尾斜杠、`/v1`、常见误填的补全面径,得到网关根地址。
fn normalize_base_url(raw: &str) -> Result<String, AppCommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(classified(
            AppErrorCode::InvalidInput,
            I18N_EMPTY_URL,
            "provider api_url is empty; fill the provider profile first",
            BTreeMap::new(),
        ));
    }
    let without_query = trimmed.split_once('?').map(|(b, _)| b).unwrap_or(trimmed);
    let mut base = without_query.trim().trim_end_matches('/').to_string();
    let suffixes = [
        "/v1/chat/completions",
        "/v1beta/openai",
        "/v1beta/models",
        "/v1/messages",
        "/v1/models",
        "/chat/completions",
        "/v1beta",
        "/v1",
    ];
    for suffix in suffixes {
        if let Some(stripped) = base
            .strip_suffix(suffix)
            .or_else(|| base.strip_suffix(&format!("{suffix}/")))
        {
            base = stripped.trim_end_matches('/').to_string();
            break;
        }
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err(classified(
            AppErrorCode::InvalidInput,
            I18N_INVALID_URL,
            "provider api_url must start with http:// or https://",
            params(&[("url", &public_url(trimmed))]),
        ));
    }
    Ok(base)
}

fn models_url(base: &str) -> String {
    format!("{base}/v1/models")
}

async fn fetch_once(
    base: &str,
    api_key: &str,
    flavor: AuthFlavor,
) -> Result<Vec<FetchedModel>, AppCommandError> {
    let url = models_url(base);
    let result = http_get_json(&url, &auth_headers(flavor, api_key)).await;
    interpret_list_response(&url, api_key, result)
}

fn auth_headers(flavor: AuthFlavor, api_key: &str) -> Vec<(String, String)> {
    match flavor {
        AuthFlavor::OpenAi => {
            if api_key.is_empty() {
                Vec::new()
            } else {
                vec![("authorization".into(), format!("Bearer {api_key}"))]
            }
        }
        AuthFlavor::Anthropic => {
            let mut headers = vec![("anthropic-version".into(), "2023-06-01".into())];
            if !api_key.is_empty() {
                headers.push(("x-api-key".into(), api_key.to_string()));
            }
            headers
        }
    }
}

async fn fetch_gemini(base: &str, api_key: &str) -> Result<Vec<FetchedModel>, AppCommandError> {
    let mut gemini_url = match reqwest::Url::parse(&format!("{base}/v1beta/models")) {
        Ok(url) => url,
        Err(_) => {
            return Err(classified(
                AppErrorCode::InvalidInput,
                I18N_INVALID_URL,
                "provider api_url is not a valid URL",
                params(&[("url", &public_url(base))]),
            ));
        }
    };
    if !api_key.is_empty() {
        gemini_url.query_pairs_mut().append_pair("key", api_key);
    }
    let gemini_url = gemini_url.to_string();
    let gemini_result = http_get_json(&gemini_url, &[]).await;
    interpret_list_response(&gemini_url, api_key, gemini_result)
}

fn interpret_list_response(
    url: &str,
    api_key: &str,
    result: Result<HttpJson, AppCommandError>,
) -> Result<Vec<FetchedModel>, AppCommandError> {
    let response = result?;
    if !response.status.is_success() {
        return Err(classify_http_status(
            url,
            api_key,
            response.status,
            &response.body,
        ));
    }
    match parse_models_json(&response.body) {
        Ok(models) => Ok(models),
        Err(ParseFail::NotJson) => Err(classified(
            AppErrorCode::TaskExecutionFailed,
            I18N_NOT_JSON,
            format!("model list from {} is not JSON", public_url(url)),
            params(&[("url", &public_url(url))]),
        )),
        Err(ParseFail::UnexpectedShape) => Err(classified(
            AppErrorCode::TaskExecutionFailed,
            I18N_UNEXPECTED_SHAPE,
            format!(
                "model list from {} is JSON but not a model catalog",
                public_url(url)
            ),
            params(&[("url", &public_url(url))]),
        )),
        Err(ParseFail::ProviderFailed(message)) => {
            let mut map = params(&[("url", &public_url(url))]);
            map.insert("providerMessage".into(), message.clone());
            Err(classified(
                AppErrorCode::TaskExecutionFailed,
                I18N_PROVIDER_FAILED,
                format!("provider rejected the model list request: {message}"),
                map,
            ))
        }
    }
}

async fn http_get_json(
    url: &str,
    headers: &[(String, String)],
) -> Result<HttpJson, AppCommandError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|error| classify_transport_error(&error, url))?;
    let mut request = client
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "berth-model-list/1");
    for (key, value) in headers {
        request = request.header(key.as_str(), value.as_str());
    }
    let response = request
        .send()
        .await
        .map_err(|error| classify_transport_error(&error, url))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| classify_transport_error(&error, url))?;
    Ok(HttpJson { status, body })
}

fn classify_transport_error(error: &reqwest::Error, url: &str) -> AppCommandError {
    let public = public_url(url);
    let detail = error.to_string();
    let lower = detail.to_lowercase();
    let mut map = params(&[
        ("url", &public),
        ("detail", &detail),
        ("timeout", &FETCH_TIMEOUT_SECS.to_string()),
    ]);
    if error.is_timeout() || lower.contains("timed out") {
        return classified(
            AppErrorCode::NetworkError,
            I18N_TIMEOUT,
            format!("model list request to {public} timed out"),
            map,
        );
    }
    if lower.contains("dns")
        || lower.contains("failed to lookup")
        || lower.contains("name or service not known")
        || lower.contains("no such host")
    {
        map.insert("detail".into(), detail);
        return classified(
            AppErrorCode::NetworkError,
            I18N_DNS,
            format!("dns lookup failed for {public}"),
            map,
        );
    }
    if lower.contains("certificate")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("pkix")
    {
        return classified(
            AppErrorCode::NetworkError,
            I18N_TLS,
            format!("tls/certificate error talking to {public}"),
            map,
        );
    }
    classified(
        AppErrorCode::NetworkError,
        I18N_NETWORK,
        format!("cannot reach {public}: {detail}"),
        map,
    )
}

fn classify_http_status(
    url: &str,
    api_key: &str,
    status: StatusCode,
    body: &str,
) -> AppCommandError {
    let public = public_url(url);
    let provider_message = extract_provider_message(body, api_key);
    let code_str = status.as_u16().to_string();
    let mut map = params(&[("url", &public), ("status", &code_str)]);
    map.insert("providerMessage".into(), provider_message.clone());
    let hint = if provider_message.is_empty() {
        String::new()
    } else {
        format!("; provider: {provider_message}")
    };
    match status.as_u16() {
        401 | 403 => {
            let key = if api_key.is_empty() {
                I18N_AUTH_MISSING_KEY
            } else {
                I18N_AUTH
            };
            classified(
                AppErrorCode::AuthenticationFailed,
                key,
                format!("model list auth failed with HTTP {status} at {public}{hint}"),
                map,
            )
        }
        404 => classified(
            AppErrorCode::NotFound,
            I18N_NOT_FOUND,
            format!("model list endpoint not found at {public} (HTTP 404)"),
            map,
        ),
        405 | 501 => classified(
            AppErrorCode::TaskExecutionFailed,
            I18N_NOT_SUPPORTED,
            format!("provider does not support model listing at {public} (HTTP {status})"),
            map,
        ),
        429 => classified(
            AppErrorCode::ResourceCapacity,
            I18N_RATE_LIMITED,
            format!("model list rate-limited at {public} (HTTP 429)"),
            map,
        ),
        500..=599 => classified(
            AppErrorCode::TaskExecutionFailed,
            I18N_SERVER,
            format!("provider server error HTTP {status} at {public}{hint}"),
            map,
        ),
        _ => classified(
            AppErrorCode::TaskExecutionFailed,
            I18N_HTTP,
            format!("model list request failed with HTTP {status} at {public}{hint}"),
            map,
        ),
    }
}

#[derive(Debug)]
enum ParseFail {
    NotJson,
    UnexpectedShape,
    ProviderFailed(String),
}

/// 解析 OpenAI / NewAPI / Anthropic / Gemini 常见列表形态。
fn parse_models_json(body: &str) -> Result<Vec<FetchedModel>, ParseFail> {
    let trimmed = body.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('<')
        || trimmed.starts_with("<!DOCTYPE")
        || trimmed.starts_with("<html")
    {
        return Err(ParseFail::NotJson);
    }
    let json: Value = serde_json::from_str(trimmed).map_err(|_| ParseFail::NotJson)?;
    if json.get("success").and_then(Value::as_bool) == Some(false) {
        let message = json
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| json.pointer("/error/message").and_then(Value::as_str))
            .unwrap_or("provider returned success=false")
            .trim();
        return Err(ParseFail::ProviderFailed(message.to_string()));
    }
    if json.get("error").is_some() && json.get("data").is_none() && json.get("models").is_none() {
        let message = extract_provider_message(trimmed, "");
        return Err(ParseFail::ProviderFailed(if message.is_empty() {
            "provider returned an error object".into()
        } else {
            message
        }));
    }
    let mut models = Vec::new();
    models.extend(string_array(
        &json,
        &["data"],
        &["id", "display_name", "name"],
    ));
    if models.is_empty() {
        models.extend(string_array(
            &json,
            &["models"],
            &["id", "name", "displayName"],
        ));
    }
    if models.is_empty() {
        if let Some(array) = json.as_array() {
            for entry in array {
                push_model_id(&mut models, entry);
            }
        }
    }
    if models.is_empty()
        && json.get("data").is_none()
        && json.get("models").is_none()
        && !json.is_array()
    {
        return Err(ParseFail::UnexpectedShape);
    }
    // 同一 id 出现多次（多渠道）时合并接口
    let mut merged: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for model in models {
        let apis = merged.entry(model.id).or_default();
        for api in model.apis {
            if !apis.contains(&api) {
                apis.push(api);
            }
        }
    }
    Ok(merged
        .into_iter()
        .map(|(id, apis)| FetchedModel { id, apis })
        .collect())
}

/// 从 `json[container][i]` 提取模型 id,按候选字段顺序取值。
fn string_array(json: &Value, container: &[&str], fields: &[&str]) -> Vec<FetchedModel> {
    let mut items = Vec::new();
    let mut node = json;
    for key in container {
        node = match node.get(*key) {
            Some(next) => next,
            None => return items,
        };
    }
    if let Some(array) = node.as_array() {
        for entry in array {
            if let Some(value) = first_string_field(entry, fields) {
                push_id(&mut items, value, entry);
            } else if let Some(value) = entry.as_str() {
                push_id(&mut items, value, entry);
            }
        }
    }
    items
}

fn push_model_id(items: &mut Vec<FetchedModel>, entry: &Value) {
    if let Some(value) = first_string_field(entry, &["id", "name", "display_name"]) {
        push_id(items, value, entry);
    } else if let Some(value) = entry.as_str() {
        push_id(items, value, entry);
    }
}

fn first_string_field<'a>(entry: &'a Value, fields: &[&str]) -> Option<&'a str> {
    for field in fields {
        if let Some(value) = entry.get(*field).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn push_id(items: &mut Vec<FetchedModel>, value: &str, entry: &Value) {
    let value = value
        .strip_prefix("models/")
        .unwrap_or(value)
        .trim()
        .to_string();
    if value.is_empty() {
        return;
    }
    let mut apis: Vec<String> = Vec::new();
    for api in entry
        .get("supported_endpoint_types")
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
    items.push(FetchedModel { id: value, apis });
}

fn extract_provider_message(body: &str, api_key: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let raw = parsed
        .as_ref()
        .and_then(|json| {
            json.pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| json.get("message").and_then(Value::as_str))
                .or_else(|| json.get("error").and_then(Value::as_str))
                .or_else(|| json.pointer("/error/type").and_then(Value::as_str))
        })
        .unwrap_or("")
        .replace('\n', " ");
    let mut message = raw;
    if !api_key.is_empty() {
        message = message.replace(api_key, "REDACTED");
    }
    const MAX: usize = 200;
    if message.chars().count() > MAX {
        message = message.chars().take(MAX).collect::<String>() + "…";
    }
    message.trim().to_string()
}

fn public_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let redacted = query
        .split('&')
        .map(|pair| {
            let key = pair.split_once('=').map(|(k, _)| k).unwrap_or(pair);
            if key.eq_ignore_ascii_case("key")
                || key.eq_ignore_ascii_case("api_key")
                || key.eq_ignore_ascii_case("token")
            {
                format!("{key}=REDACTED")
            } else {
                pair.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    if redacted.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{redacted}")
    }
}

fn params(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

fn classified(
    code: AppErrorCode,
    i18n_key: &str,
    message: impl Into<String>,
    params: BTreeMap<String, String>,
) -> AppCommandError {
    AppCommandError::new(code, message).with_i18n(i18n_key, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_array_reads_openai_shape() {
        let json = serde_json::json!({
            "data": [
                { "id": "b-model", "object": "model" },
                { "id": "a-model" },
                { "id": "" },
                { "object": "model" }
            ]
        });
        assert_eq!(
            string_array(&json, &["data"], &["id"]),
            ["b-model", "a-model"]
                .map(|id| FetchedModel {
                    id: id.to_string(),
                    apis: Vec::new(),
                })
                .to_vec()
        );
    }

    #[test]
    fn string_array_missing_container_is_empty() {
        let json = serde_json::json!({ "unexpected": [] });
        assert!(string_array(&json, &["data"], &["id"]).is_empty());
    }

    #[test]
    fn openai_url_joining_avoids_double_v1() {
        let base_with_v1 = "https://api.example.com/v1";
        let bare_base = "https://api.example.com";
        assert_eq!(
            models_url(&normalize_base_url(base_with_v1).unwrap()),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            models_url(&normalize_base_url(bare_base).unwrap()),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn normalize_strips_common_mistyped_suffixes() {
        assert_eq!(
            normalize_base_url("https://ai.example.com/v1/").unwrap(),
            "https://ai.example.com"
        );
        assert_eq!(
            normalize_base_url("https://ai.example.com/v1/chat/completions").unwrap(),
            "https://ai.example.com"
        );
        assert_eq!(
            normalize_base_url("https://ai.example.com/v1beta/models?key=secret").unwrap(),
            "https://ai.example.com"
        );
        assert_eq!(
            normalize_base_url("https://api.anthropic.com/v1/messages").unwrap(),
            "https://api.anthropic.com"
        );
    }

    #[test]
    fn normalize_rejects_empty_and_non_http() {
        assert_eq!(
            normalize_base_url("  ").unwrap_err().i18n_key.as_deref(),
            Some(I18N_EMPTY_URL)
        );
        assert_eq!(
            normalize_base_url("ai.example.com/v1")
                .unwrap_err()
                .i18n_key
                .as_deref(),
            Some(I18N_INVALID_URL)
        );
    }

    fn fetched(id: &str, apis: &[&str]) -> FetchedModel {
        FetchedModel {
            id: id.into(),
            apis: apis.iter().map(|api| api.to_string()).collect(),
        }
    }

    #[test]
    fn parse_newapi_openai_shape() {
        let body = r#"{
            "success": true,
            "object": "list",
            "data": [
                {
                    "id": "claude-sonnet-4-5",
                    "owned_by": "custom",
                    "supported_endpoint_types": ["anthropic", "openai"]
                },
                { "id": "gpt-6-astra", "supported_endpoint_types": ["openai-response", "embeddings"] },
                { "id": "gpt-4o" }
            ]
        }"#;
        assert_eq!(
            parse_models_json(body).unwrap(),
            vec![
                fetched("claude-sonnet-4-5", &["anthropic", "openai-chat"]),
                fetched("gpt-4o", &[]),
                fetched("gpt-6-astra", &["openai-responses"]),
            ]
        );
    }

    #[test]
    fn parse_anthropic_and_gemini_shapes() {
        let anthropic = r#"{
            "data": [
                { "id": "claude-3-5-haiku", "display_name": "Haiku", "type": "model" }
            ]
        }"#;
        assert_eq!(
            parse_models_json(anthropic).unwrap(),
            vec![fetched("claude-3-5-haiku", &[])]
        );
        let gemini = r#"{ "models": [ { "name": "models/gemini-2.5-pro" } ] }"#;
        assert_eq!(
            parse_models_json(gemini).unwrap(),
            vec![fetched("gemini-2.5-pro", &[])]
        );
    }

    #[test]
    fn parse_success_false_is_provider_failed() {
        let body = r#"{"success": false, "message": "get user group failed"}"#;
        match parse_models_json(body) {
            Err(ParseFail::ProviderFailed(message)) => {
                assert!(message.contains("get user group failed"));
            }
            other => panic!("expected provider failed, got {other:?}"),
        }
    }

    #[test]
    fn parse_empty_data_array_is_success() {
        assert_eq!(
            parse_models_json(r#"{"object":"list","data":[]}"#).unwrap(),
            Vec::<FetchedModel>::new()
        );
    }

    #[test]
    fn parse_missing_catalog_is_unexpected_shape() {
        match parse_models_json(r#"{"object":"ok"}"#) {
            Err(ParseFail::UnexpectedShape) => {}
            other => panic!("expected unexpected shape, got {other:?}"),
        }
    }

    #[test]
    fn parse_html_is_not_json() {
        match parse_models_json("<html><body>login</body></html>") {
            Err(ParseFail::NotJson) => {}
            other => panic!("expected not json, got {other:?}"),
        }
    }

    #[test]
    fn classify_http_distinguishes_auth_url_and_unsupported() {
        let auth = classify_http_status(
            "https://ai.example.com/v1/models",
            "sk-test",
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"Incorrect API key provided"}}"#,
        );
        assert_eq!(auth.i18n_key.as_deref(), Some(I18N_AUTH));
        assert_eq!(auth.code, AppErrorCode::AuthenticationFailed);
        assert_eq!(
            auth.i18n_params
                .as_ref()
                .unwrap()
                .get("providerMessage")
                .map(String::as_str),
            Some("Incorrect API key provided")
        );

        let missing_key = classify_http_status(
            "https://ai.example.com/v1/models",
            "",
            StatusCode::UNAUTHORIZED,
            "{}",
        );
        assert_eq!(missing_key.i18n_key.as_deref(), Some(I18N_AUTH_MISSING_KEY));

        let not_found = classify_http_status(
            "https://ai.example.com/v1/v1/models",
            "sk-test",
            StatusCode::NOT_FOUND,
            "",
        );
        assert_eq!(not_found.i18n_key.as_deref(), Some(I18N_NOT_FOUND));

        let unsupported = classify_http_status(
            "https://ai.example.com/v1/models",
            "sk-test",
            StatusCode::METHOD_NOT_ALLOWED,
            "",
        );
        assert_eq!(unsupported.i18n_key.as_deref(), Some(I18N_NOT_SUPPORTED));
    }

    #[test]
    fn public_url_redacts_gemini_key() {
        assert_eq!(
            public_url("https://generativelanguage.googleapis.com/v1beta/models?key=secret"),
            "https://generativelanguage.googleapis.com/v1beta/models?key=REDACTED"
        );
    }
}
