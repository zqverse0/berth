//! 本地服务商凭据代理：把调用方出示的假令牌原位换成真 key、`Host` 换成上游，
//! 其余请求 / 响应原样透传。
//!
//! 有序头重建参考 cc-switch（MIT，`src-tauri/src/proxy/forwarder.rs`）；按底线不做协议转换、
//! 故障转移与客户端伪装（`.berth/tasks/10-01-provider-proxy/prd.md` §3）。
//! 与 cc-switch 的差异：不剥离 CDN / 追踪头——代理在本机，直连时客户端发什么，这里就转什么；
//! 不按协议重写认证头——令牌在哪个头里、什么格式，真 key 就原样放回哪里。
//!
//! 本 crate 不读 keyring / 数据库：宿主（GUI / CLI）实现 [`Resolver`] 交出上游地址与 key。

mod connect;
mod server;

use std::sync::Arc;

use bytes::Bytes;
use http::request::Parts;
use http::{HeaderMap, HeaderValue, Request, Response, StatusCode, Uri, Version};
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::proxy::matcher::Matcher;
use hyper_util::rt::TokioExecutor;

pub use connect::UpstreamConnector;

pub use server::{serve, Denied, Resolver, Route, RouteRequest};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type ProxyBody = BoxBody<Bytes, BoxError>;
pub type UpstreamClient = Client<HttpsConnector<UpstreamConnector>, Full<Bytes>>;

/// 逐跳头：只对当前连接有意义，直连时也不会到达上游（RFC 9110 §7.6.1）。
/// `connection: keep-alive` 例外：上游连接本就复用，原样保留与直连一致。
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// 正式实例的监听端口；dev 实例用下一个端口，两个实例可以同时运行（令牌各自独立）。
pub fn port(dev: bool) -> u16 {
    if dev {
        15723
    } else {
        15722
    }
}

/// 某档案经代理的根地址，调用方再拼 `/<protocol>`。
pub fn provider_base_url(port: u16, provider_id: i32) -> String {
    format!("http://127.0.0.1:{port}/p/{provider_id}")
}

/// 本机端口上是否有代理在监听（启动 Agent 前检查，不在就直接报错，不起一个必然失败的 Agent）。
pub fn is_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

/// 调用方出示的假令牌，与要换上的真 key。
#[derive(Clone, Copy)]
pub struct Credential<'a> {
    pub token: &'a str,
    pub key: &'a str,
}

/// 上游客户端：只走 HTTP/1.1（主流 LLM SDK 直连时的协议），保留头名原始大小写，不跟随
/// 重定向（hyper 本就不跟随，3xx 原样交回调用方），系统证书校验同 reqwest，系统代理在
/// 创建时读取（见 [`connect`]）。
pub fn upstream_client() -> Result<UpstreamClient, BoxError> {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone())?;
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(tls)
        .https_or_http()
        .enable_http1()
        .wrap_connector(UpstreamConnector::new(Matcher::from_system()));
    Ok(Client::builder(TokioExecutor::new())
        .http1_preserve_header_case(true)
        .build(connector))
}

/// 按客户端原始顺序重建请求头：`Host` 原位换成上游；任何头里出现的假令牌原位换成真 key
/// （头名、`Bearer` 前缀等格式不动，key 该放哪个头由服务商决定），档案没有 Key 时该头
/// 不发；逐跳头剥离；其余原样。
/// `content-length` 原位保留：请求体不改，长度不变。
pub fn rebuild_request_headers(
    incoming: &HeaderMap,
    upstream_authority: &str,
    credential: Credential<'_>,
) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(incoming.len());
    for (name, value) in incoming {
        let key = name.as_str();
        if key == "host" {
            if let Ok(host) = HeaderValue::from_str(upstream_authority) {
                out.append(name.clone(), host);
            }
        } else if key == "connection" && value.as_bytes().eq_ignore_ascii_case(b"keep-alive")
            || !HOP_BY_HOP.contains(&key)
        {
            let carries_token = value
                .to_str()
                .is_ok_and(|text| text.contains(credential.token));
            if carries_token && credential.key.is_empty() {
                // 无 Key 的档案（本地 Ollama 等）：带令牌的头整条不发。
                continue;
            }
            let swapped = value
                .to_str()
                .ok()
                .filter(|_| carries_token)
                .and_then(|text| {
                    HeaderValue::from_str(&text.replace(credential.token, credential.key)).ok()
                });
            out.append(name.clone(), swapped.unwrap_or_else(|| value.clone()));
        }
    }
    out
}

/// 转发一次请求到 `upstream_url`（完整 URL，含路径与查询）。接收端须用
/// `http1::Builder` 的 `preserve_header_case(true)`（头名大小写带到上游与回程）和
/// `auto_date_header(false)`（不补上游没发的 `date`）。
/// 错误响应不带上游细节：URL 可能含 `?key=`，错误文本可能回显凭据。
pub async fn forward(
    client: &UpstreamClient,
    parts: Parts,
    body: Bytes,
    upstream_url: &str,
    credential: Credential<'_>,
) -> Response<ProxyBody> {
    let Ok(uri) = upstream_url.parse::<Uri>() else {
        return plain(StatusCode::BAD_GATEWAY, "invalid upstream url");
    };
    let Some(authority) = uri.authority().map(|a| a.to_string()) else {
        return plain(StatusCode::BAD_GATEWAY, "invalid upstream url");
    };
    let mut upstream = Request::new(Full::new(body));
    *upstream.method_mut() = parts.method;
    *upstream.uri_mut() = uri;
    *upstream.version_mut() = Version::HTTP_11;
    *upstream.headers_mut() = rebuild_request_headers(&parts.headers, &authority, credential);
    // 带上接收端记录的原始头名大小写（hyper 内部类型，只能整体转交）。
    *upstream.extensions_mut() = parts.extensions;

    match client.request(upstream).await {
        Ok(response) => {
            let (mut parts, body) = response.into_parts();
            // `transfer-encoding` 保留：接收端据此按同样的分块方式回给调用方。
            for name in [
                "connection",
                "keep-alive",
                "proxy-connection",
                "trailer",
                "upgrade",
            ] {
                parts.headers.remove(name);
            }
            Response::from_parts(parts, body.map_err(BoxError::from).boxed())
        }
        Err(_) => plain(StatusCode::BAD_GATEWAY, "upstream request failed"),
    }
}

fn plain(status: StatusCode, message: &'static str) -> Response<ProxyBody> {
    let mut response = Response::new(
        Full::new(Bytes::from_static(message.as_bytes()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderName;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    fn names_values(map: &HeaderMap) -> Vec<(String, String)> {
        map.iter()
            .map(|(n, v)| (n.to_string(), v.to_str().unwrap().to_owned()))
            .collect()
    }

    const CREDENTIAL: Credential<'static> = Credential {
        token: "berth-tk-fake",
        key: "sk-real",
    };

    #[test]
    fn swaps_host_and_token_in_place_and_keeps_everything_else() {
        let incoming = headers(&[
            ("host", "127.0.0.1:15722"),
            ("accept", "application/json"),
            ("x-api-key", "berth-tk-fake"),
            ("anthropic-version", "2023-06-01"),
            ("connection", "keep-alive"),
            ("content-length", "12"),
            ("user-agent", "claude-cli/2.1.217"),
            ("x-subscription-token", "berth-tk-fake"),
        ]);
        assert_eq!(
            names_values(&rebuild_request_headers(
                &incoming,
                "api.example.com",
                CREDENTIAL
            )),
            [
                ("host", "api.example.com"),
                ("accept", "application/json"),
                ("x-api-key", "sk-real"),
                ("anthropic-version", "2023-06-01"),
                ("connection", "keep-alive"),
                ("content-length", "12"),
                ("user-agent", "claude-cli/2.1.217"),
                ("x-subscription-token", "sk-real"),
            ]
            .map(|(n, v)| (n.to_owned(), v.to_owned()))
        );
    }

    #[test]
    fn keyless_profile_drops_the_token_header() {
        let incoming = headers(&[
            ("host", "127.0.0.1:15722"),
            ("authorization", "Bearer berth-tk-fake"),
            ("accept", "application/json"),
        ]);
        let keyless = Credential {
            token: "berth-tk-fake",
            key: "",
        };
        assert_eq!(
            names_values(&rebuild_request_headers(
                &incoming,
                "127.0.0.1:11434",
                keyless
            )),
            [("host", "127.0.0.1:11434"), ("accept", "application/json")]
                .map(|(n, v)| (n.to_owned(), v.to_owned()))
        );
    }

    #[test]
    fn keeps_auth_scheme_and_drops_hop_by_hop() {
        let incoming = headers(&[
            ("authorization", "Bearer berth-tk-fake"),
            ("connection", "close"),
            ("transfer-encoding", "chunked"),
        ]);
        assert_eq!(
            names_values(&rebuild_request_headers(&incoming, "h", CREDENTIAL)),
            [("authorization".to_owned(), "Bearer sk-real".to_owned())]
        );
    }
}
