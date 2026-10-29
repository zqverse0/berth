//! 监听与路由：`/p/<服务商>/<协议>/<上游路径>` → 宿主解析出的上游地址 + `<上游路径>`。
//! 只认本机：绑定 loopback，`Host` 必须是本机地址（防 DNS rebinding），带 `Origin` 的
//! 浏览器请求一律拒绝（防网页借本机令牌调用）。

use std::convert::Infallible;
use std::future::Future;
use std::sync::Arc;

use bytes::Bytes;
use http::{header, HeaderMap, Request, Response, StatusCode};
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use crate::{forward, plain, Credential, ProxyBody, UpstreamClient};

/// 请求体上限。补全请求带图片也在几十 MiB 内；超出视为异常，避免撑爆宿主进程。
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;

/// 交给宿主解析的一次路由。
pub struct RouteRequest {
    /// 路径里的服务商标识（宿主决定是 id 还是别的）。
    pub provider: String,
    /// 路径里的协议段（`chat` / `claude` / `gemini` …），宿主据此选端点。
    pub protocol: String,
    /// 调用方出示的假令牌。
    pub token: String,
    /// 请求体 JSON 的 `model`（只读），宿主可据此选分组 Key。
    pub model: Option<String>,
}

/// 宿主解析结果：上游根地址（`<上游路径>` 直接拼在其后）与真 key。
pub struct Route {
    pub upstream_base: String,
    pub key: String,
}

pub enum Denied {
    /// 服务商不存在、是官方档案，或协议没有端点。
    UnknownProvider,
    /// 令牌无效，或无权使用该服务商。
    InvalidToken,
}

pub trait Resolver: Send + Sync + 'static {
    fn resolve(&self, request: RouteRequest) -> impl Future<Output = Result<Route, Denied>> + Send;
}

/// 在 `listener` 上服务直到出错。`listener` 须绑定在 loopback 地址上。
pub async fn serve<R: Resolver>(
    listener: TcpListener,
    client: UpstreamClient,
    resolver: Arc<R>,
) -> std::io::Result<()> {
    let port = listener.local_addr()?.port();
    loop {
        let Ok((socket, _)) = listener.accept().await else {
            continue;
        };
        let client = client.clone();
        let resolver = resolver.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let client = client.clone();
                let resolver = resolver.clone();
                async move { Ok::<_, Infallible>(handle(&client, &*resolver, port, request).await) }
            });
            let _ = http1::Builder::new()
                .preserve_header_case(true)
                .auto_date_header(false)
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
    }
}

async fn handle<R: Resolver>(
    client: &UpstreamClient,
    resolver: &R,
    port: u16,
    request: Request<Incoming>,
) -> Response<ProxyBody> {
    if request.headers().contains_key(header::ORIGIN) {
        return plain(StatusCode::FORBIDDEN, "browser requests are not accepted");
    }
    if !is_local_host(request.headers(), port) {
        return plain(StatusCode::FORBIDDEN, "unexpected host");
    }
    let Some((provider, protocol, rest)) = split_route(request.uri().path()) else {
        return plain(
            StatusCode::NOT_FOUND,
            "expected /p/<provider>/<protocol>/<path>",
        );
    };
    let (provider, protocol, rest) = (provider.to_owned(), protocol.to_owned(), rest.to_owned());
    let query = request.uri().query().map(str::to_owned);
    let Some(token) = presented_token(request.headers(), query.as_deref()) else {
        return plain(StatusCode::UNAUTHORIZED, "missing berth token");
    };
    let (parts, body) = request.into_parts();
    let body: Bytes = match Limited::new(body, MAX_REQUEST_BODY_BYTES).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "request body too large"),
    };
    let model = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("model")?.as_str().map(str::to_owned));
    let route = match resolver
        .resolve(RouteRequest {
            provider,
            protocol,
            token: token.clone(),
            model,
        })
        .await
    {
        Ok(route) => route,
        Err(Denied::UnknownProvider) => {
            return plain(StatusCode::NOT_FOUND, "unknown provider or protocol")
        }
        Err(Denied::InvalidToken) => return plain(StatusCode::UNAUTHORIZED, "invalid berth token"),
    };
    let credential = Credential {
        token: &token,
        key: &route.key,
    };
    let url = upstream_url(&route.upstream_base, &rest, query.as_deref(), credential);
    forward(client, parts, body, &url, credential).await
}

fn is_local_host(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|name| host.eq_ignore_ascii_case(&format!("{name}:{port}")))
}

/// `/p/<provider>/<protocol>[/<rest>]` → (provider, protocol, `/<rest>` 或空串)。
fn split_route(path: &str) -> Option<(&str, &str, &str)> {
    let route = path.strip_prefix("/p/")?;
    let (provider, route) = route.split_once('/')?;
    let (protocol, rest) = match route.find('/') {
        Some(index) => route.split_at(index),
        None => (route, ""),
    };
    (!provider.is_empty() && !protocol.is_empty()).then_some((provider, protocol, rest))
}

/// 调用方出示的令牌：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`?key=`；
/// 都没有时，任意请求头或查询参数里的 `berth-tk-…`（Brave 的 `X-Subscription-Token`、
/// SerpAPI 的 `?api_key=` 等，令牌放在服务商文档要求 key 放的地方即可）。
fn presented_token(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    let header_value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let bearer = header_value("authorization").and_then(|value| {
        let (scheme, token) = value.split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then_some(token)
    });
    bearer
        .or_else(|| header_value("x-api-key"))
        .or_else(|| header_value("x-goog-api-key"))
        .or_else(|| query?.split('&').find_map(|pair| pair.strip_prefix("key=")))
        .or_else(|| {
            headers
                .values()
                .filter_map(|value| value.to_str().ok())
                .chain(query.into_iter().flat_map(|query| query.split('&')))
                .find_map(berth_token_in)
        })
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

/// 文本里的 `berth-tk-<字母数字>`（令牌形态见宿主的 `token()`）。
fn berth_token_in(text: &str) -> Option<&str> {
    let start = text.find(TOKEN_PREFIX)?;
    let tail = &text[start..];
    let end = TOKEN_PREFIX.len()
        + tail[TOKEN_PREFIX.len()..]
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(tail.len() - TOKEN_PREFIX.len());
    (end > TOKEN_PREFIX.len()).then(|| &tail[..end])
}

const TOKEN_PREFIX: &str = "berth-tk-";

/// 上游地址 = 根地址 + 剩余路径 + 查询（值恰为令牌的参数换成真 key，参数名与其余参数原样；
/// 档案没有 Key 时去掉该参数）。
// ponytail: 真 key 不做百分号编码；各家 key 均为 URL 安全字符，遇到例外再编码。
fn upstream_url(base: &str, rest: &str, query: Option<&str>, credential: Credential<'_>) -> String {
    let mut url = format!("{}{rest}", base.trim_end_matches('/'));
    if let Some(query) = query {
        let query: Vec<String> = query
            .split('&')
            .filter_map(|pair| match pair.split_once('=') {
                // 无 Key 的档案：令牌参数整个去掉。
                Some((_, value)) if value == credential.token && credential.key.is_empty() => None,
                Some((name, value)) if value == credential.token => {
                    Some(format!("{name}={}", credential.key))
                }
                _ => Some(pair.to_owned()),
            })
            .collect();
        if !query.is_empty() {
            url.push('?');
            url.push_str(&query.join("&"));
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        pairs
            .iter()
            .map(|(n, v)| {
                (
                    header::HeaderName::from_static(n),
                    HeaderValue::from_static(v),
                )
            })
            .collect()
    }

    #[test]
    fn splits_provider_protocol_and_rest() {
        assert_eq!(
            split_route("/p/68/chat/v1/chat/completions"),
            Some(("68", "chat", "/v1/chat/completions"))
        );
        assert_eq!(split_route("/p/68/claude"), Some(("68", "claude", "")));
        assert_eq!(split_route("/p/68"), None);
        assert_eq!(split_route("/p//chat/x"), None);
        assert_eq!(split_route("/v1/chat"), None);
    }

    #[test]
    fn finds_token_wherever_the_client_put_it() {
        let token = |pairs, query| presented_token(&headers(pairs), query);
        assert_eq!(
            token(&[("authorization", "Bearer tk")], None).as_deref(),
            Some("tk")
        );
        assert_eq!(token(&[("x-api-key", "tk")], None).as_deref(), Some("tk"));
        assert_eq!(
            token(&[("x-goog-api-key", "tk")], None).as_deref(),
            Some("tk")
        );
        assert_eq!(token(&[], Some("alt=sse&key=tk")).as_deref(), Some("tk"));
        assert_eq!(token(&[("authorization", "Basic tk")], None), None);
        assert_eq!(token(&[], None), None);
        // 其他位置只认 `berth-tk-` 前缀的令牌。
        assert_eq!(
            token(&[("x-subscription-token", "berth-tk-ab12")], None).as_deref(),
            Some("berth-tk-ab12")
        );
        assert_eq!(
            token(&[], Some("q=x&api_key=berth-tk-ab12&n=1")).as_deref(),
            Some("berth-tk-ab12")
        );
        assert_eq!(token(&[("x-other", "tk")], Some("api_key=tk")), None);
        assert_eq!(token(&[("x-other", "berth-tk-")], None), None);
    }

    #[test]
    fn only_local_hosts_on_our_port_are_accepted() {
        assert!(is_local_host(
            &headers(&[("host", "127.0.0.1:15722")]),
            15722
        ));
        assert!(is_local_host(
            &headers(&[("host", "localhost:15722")]),
            15722
        ));
        assert!(!is_local_host(
            &headers(&[("host", "evil.example:15722")]),
            15722
        ));
        assert!(!is_local_host(&headers(&[("host", "127.0.0.1:80")]), 15722));
        assert!(!is_local_host(&headers(&[]), 15722));
    }

    #[test]
    fn swaps_only_the_token_query_pair() {
        let credential = Credential {
            token: "tk",
            key: "real",
        };
        assert_eq!(
            upstream_url(
                "https://g.example/",
                "/v1/m:stream",
                Some("alt=sse&key=tk"),
                credential
            ),
            "https://g.example/v1/m:stream?alt=sse&key=real"
        );
        assert_eq!(
            upstream_url(
                "https://serpapi.example",
                "/search",
                Some("q=cats&api_key=tk&engine=google"),
                credential
            ),
            "https://serpapi.example/search?q=cats&api_key=real&engine=google"
        );
        let keyless = Credential {
            token: "tk",
            key: "",
        };
        assert_eq!(
            upstream_url(
                "http://127.0.0.1:11434",
                "/api/tags",
                Some("key=tk"),
                keyless
            ),
            "http://127.0.0.1:11434/api/tags"
        );
        assert_eq!(
            upstream_url("http://h", "/x", Some("a=1&key=tk"), keyless),
            "http://h/x?a=1"
        );
        assert_eq!(
            upstream_url(
                "https://api.deepseek.com",
                "/chat/completions",
                None,
                credential
            ),
            "https://api.deepseek.com/chat/completions"
        );
    }
}
