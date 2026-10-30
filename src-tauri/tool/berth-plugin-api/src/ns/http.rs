//! http@1（权限 `network`）：脚本发 HTTP 请求，拿状态、响应头与文本。
//! 非 2xx 不算错误（插件自己看 `status`）；连不上、超时才 reject。

use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::rpc::{env_param, opt_str_param, str_param, ApiError, ApiResult, Reason};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// 响应体上限：视图数据用不到更大的。
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

pub fn call(name: &str, params: &Value) -> Option<ApiResult> {
    match name {
        "fetch" => Some(fetch(params)),
        _ => None,
    }
}

fn fetch(params: &Value) -> ApiResult {
    let url = str_param(params, "url")?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ApiError::invalid("url must be http(s)"));
    }
    let method = opt_str_param(params, "method")?.unwrap_or("GET");
    let method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
        .map_err(|_| ApiError::invalid(format!("bad method {method}")))?;
    let timeout = params["timeoutMs"]
        .as_u64()
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_TIMEOUT);
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("Berth/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| ApiError::new(Reason::Internal, error.to_string()))?;
    let mut request = client.request(method, url);
    for (name, value) in env_param(params, "headers")? {
        request = request.header(name, value);
    }
    if let Some(body) = opt_str_param(params, "body")? {
        request = request.body(body.to_owned());
    }
    let response = request
        .send()
        .map_err(|error| ApiError::new(Reason::Internal, format!("{url}: {error}")))?;
    let status = response.status().as_u16();
    let headers: Map<String, Value> = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            Some((
                name.as_str().to_owned(),
                Value::String(value.to_str().ok()?.to_owned()),
            ))
        })
        .collect();
    let bytes = response
        .bytes()
        .map_err(|error| ApiError::new(Reason::Internal, format!("{url}: {error}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(ApiError::new(
            Reason::Internal,
            format!("{url}: response too large"),
        ));
    }
    Ok(json!({
        "status": status,
        "headers": headers,
        "text": String::from_utf8_lossy(&bytes),
    }))
}
