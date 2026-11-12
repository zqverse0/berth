//! http@1（权限 `network`）：脚本发 HTTP 请求，拿状态、响应头与文本。
//! 非 2xx 不算错误（插件自己看 `status`）；连不上、超时才 reject。
//! `fetchAll` 并发发一组请求、按原顺序返回，单项失败只体现在该项。`retry` 由宿主退避重试
//! （插件 QuickJS 没有 setTimeout）。请求都在工作线程里跑，等待时每 100 ms 查一次取消标志。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::rpc::{env_param, opt_str_param, str_param, ApiError, ApiResult, Host, Reason};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// 响应体上限：视图数据用不到更大的。
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// 退避起点；第 n 次重试等 `BACKOFF_BASE × 2^(n-1)`，不超过 `maxWaitMs`。
const BACKOFF_BASE: Duration = Duration::from_millis(500);
const DEFAULT_MAX_WAIT: Duration = Duration::from_secs(10);
const CANCEL_POLL: Duration = Duration::from_millis(100);

pub fn call(host: &Host, name: &str, params: &Value) -> Option<ApiResult> {
    match name {
        "fetch" => Some(fetch(params, &host.cancel)),
        "fetchAll" => Some(fetch_all(params, &host.cancel)),
        _ => None,
    }
}

fn fetch(params: &Value, cancel: &AtomicBool) -> ApiResult {
    let spec = Spec::parse(params)?;
    wait(spawn(spec), cancel)
}

fn fetch_all(params: &Value, cancel: &AtomicBool) -> ApiResult {
    let Value::Array(requests) = &params["requests"] else {
        return Err(ApiError::invalid("requests must be an array"));
    };
    // 先全部发出，再按顺序等：总耗时约等于最慢的一个。
    let pending: Vec<Result<mpsc::Receiver<ApiResult>, ApiError>> = requests
        .iter()
        .map(|request| Spec::parse(request).map(spawn))
        .collect();
    let mut results = Vec::with_capacity(pending.len());
    for item in pending {
        let outcome = item.and_then(|receiver| wait(receiver, cancel));
        match outcome {
            Err(error) if error.reason == Reason::Cancelled => return Err(error),
            Ok(value) => results.push(value),
            Err(error) => results.push(json!({
                "error": { "reason": error.reason.as_str(), "message": error.message }
            })),
        }
    }
    Ok(Value::Array(results))
}

/// 一个请求的参数（`fetch` 的 `{url, method, headers, body, timeoutMs, retry}`）。
struct Spec {
    url: String,
    method: reqwest::Method,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout: Duration,
    attempts: u32,
    max_wait: Duration,
}

impl Spec {
    fn parse(params: &Value) -> Result<Self, ApiError> {
        let url = str_param(params, "url")?;
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(ApiError::invalid("url must be http(s)"));
        }
        let method = opt_str_param(params, "method")?.unwrap_or("GET");
        let method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
            .map_err(|_| ApiError::invalid(format!("bad method {method}")))?;
        let retry = &params["retry"];
        Ok(Self {
            url: url.to_owned(),
            method,
            headers: env_param(params, "headers")?,
            body: opt_str_param(params, "body")?.map(str::to_owned),
            timeout: params["timeoutMs"]
                .as_u64()
                .map(Duration::from_millis)
                .unwrap_or(DEFAULT_TIMEOUT),
            attempts: retry["attempts"].as_u64().unwrap_or(1).clamp(1, 10) as u32,
            max_wait: retry["maxWaitMs"]
                .as_u64()
                .map(Duration::from_millis)
                .unwrap_or(DEFAULT_MAX_WAIT),
        })
    }
}

fn spawn(spec: Spec) -> mpsc::Receiver<ApiResult> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(perform(&spec));
    });
    receiver
}

/// 等工作线程的结果；取消后立即返回，线程结果丢弃。
fn wait(receiver: mpsc::Receiver<ApiResult>, cancel: &AtomicBool) -> ApiResult {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(ApiError::new(Reason::Cancelled, "cancelled"));
        }
        match receiver.recv_timeout(CANCEL_POLL) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ApiError::new(Reason::Internal, "request thread died"))
            }
        }
    }
}

/// 发请求；连接错误 / 超时 / 429 / 5xx 时按 `retry` 退避重试，遵守 Retry-After（秒）。
/// 次数用完仍是 429 / 5xx 就把该响应原样返回。
fn perform(spec: &Spec) -> ApiResult {
    let client = reqwest::blocking::Client::builder()
        .timeout(spec.timeout)
        .user_agent(concat!("Berth/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| ApiError::new(Reason::Internal, error.to_string()))?;
    let mut attempt = 1;
    loop {
        let last = attempt >= spec.attempts;
        let delay = match send(&client, spec) {
            Ok((reply, retry_after)) => {
                let status = reply["status"].as_u64().unwrap_or(0);
                if last || !(status == 429 || status >= 500) {
                    return Ok(reply);
                }
                retry_after
            }
            Err((error, retryable)) => {
                if last || !retryable {
                    return Err(error);
                }
                None
            }
        };
        let backoff = delay.unwrap_or(BACKOFF_BASE * 2u32.pow(attempt - 1));
        std::thread::sleep(backoff.min(spec.max_wait));
        attempt += 1;
    }
}

type Sent = Result<(Value, Option<Duration>), (ApiError, bool)>;

fn send(client: &reqwest::blocking::Client, spec: &Spec) -> Sent {
    let url = &spec.url;
    let mut request = client.request(spec.method.clone(), url);
    for (name, value) in &spec.headers {
        request = request.header(name, value);
    }
    if let Some(body) = &spec.body {
        request = request.body(body.clone());
    }
    let failed = |error: reqwest::Error| {
        let retryable = !error.is_builder();
        // reqwest 的顶层消息只有「error sending request」，原因（连不上、证书不符、超时）在 source 链里
        let mut message = format!("{url}: {error}");
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            message.push_str(&format!(": {cause}"));
            source = cause.source();
        }
        (ApiError::new(Reason::Internal, message), retryable)
    };
    let response = request.send().map_err(failed)?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok()?.trim().parse().ok())
        .map(Duration::from_secs);
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
    let bytes = response.bytes().map_err(failed)?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err((
            ApiError::new(Reason::Internal, format!("{url}: response too large")),
            false,
        ));
    }
    Ok((
        json!({
            "status": status,
            "headers": headers,
            "text": String::from_utf8_lossy(&bytes),
        }),
        retry_after,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;
    use std::time::Instant;

    /// 本地服务：第 n 个连接（从 0 数）按 `reply(n)` 延迟后回状态码；每个连接一个线程。
    fn serve(reply: fn(usize) -> (u64, u16)) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let n = count.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut buffer = [0u8; 4096];
                    let mut seen = Vec::new();
                    while !seen.windows(4).any(|window| window == b"\r\n\r\n") {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => return,
                            Ok(read) => seen.extend_from_slice(&buffer[..read]),
                        }
                    }
                    let (delay, status) = reply(n);
                    std::thread::sleep(Duration::from_millis(delay));
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\nContent-Length: 2\r\nRetry-After: 0\r\nConnection: close\r\n\r\nok"
                    );
                });
            }
        });
        format!("http://{address}/")
    }

    fn closed_port() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{address}/")
    }

    #[test]
    fn http_fetch_all_runs_concurrently_and_keeps_order() {
        let url = serve(|_| (1000, 200));
        let dead = closed_port();
        let started = Instant::now();
        let result = fetch_all(
            &json!({ "requests": [{ "url": url }, { "url": dead }, { "url": url }, { "url": url }] }),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
        let items = result.as_array().unwrap();
        assert_eq!(items.len(), 4);
        assert_eq!(items[0]["status"], 200);
        assert_eq!(items[1]["error"]["reason"], "internal");
        assert_eq!(items[3]["text"], "ok");
    }

    #[test]
    fn http_retry_backs_off_until_success() {
        let url = serve(|n| (0, if n < 2 { 503 } else { 200 }));
        let reply = fetch(
            &json!({ "url": url, "retry": { "attempts": 3, "maxWaitMs": 50 } }),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(reply["status"], 200);
        // 没给 retry：503 原样返回。
        let url = serve(|_| (0, 503));
        let reply = fetch(&json!({ "url": url }), &AtomicBool::new(false)).unwrap();
        assert_eq!(reply["status"], 503);
    }

    #[test]
    fn http_cancel_returns_promptly() {
        let url = serve(|_| (30_000, 200));
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let error = fetch(&json!({ "url": url }), &cancel).unwrap_err();
        assert_eq!(error.reason, Reason::Cancelled);
        assert!(started.elapsed() < Duration::from_millis(300));
    }
}
