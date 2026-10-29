//! 上游连接：按 curl 规则读系统代理（`HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，Berth「系统代理」
//! 设置即写这些变量），https 目标经 HTTP `CONNECT` 隧道或 SOCKS5 出去，其余直连。
//! 与直连的 SDK 读同一组变量，走同一条出口。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use http::Uri;
use hyper_util::client::legacy::connect::proxy::{SocksV5, Tunnel};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::proxy::matcher::Matcher;
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tower_service::Service;

use crate::BoxError;

#[derive(Clone)]
pub struct UpstreamConnector {
    http: HttpConnector,
    proxy: Arc<Matcher>,
}

impl UpstreamConnector {
    pub fn new(proxy: Matcher) -> Self {
        let mut http = HttpConnector::new();
        // https 目标由外层 rustls 包 TLS，这里只负责拿到 TCP 流。
        http.enforce_http(false);
        Self {
            http,
            proxy: Arc::new(proxy),
        }
    }
}

impl Service<Uri> for UpstreamConnector {
    type Response = TokioIo<TcpStream>;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, BoxError>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, dst: Uri) -> Self::Future {
        let http = self.http.clone();
        // 只代理 https：hyper-util 的隧道对无端口目标默认 443，http 目标经它会连错端口。
        let intercept = (dst.scheme_str() == Some("https"))
            .then(|| self.proxy.intercept(&dst))
            .flatten();
        Box::pin(async move {
            let Some(intercept) = intercept else {
                return Ok(http.clone().call(dst).await?);
            };
            let proxy = intercept.uri().clone();
            match proxy.scheme_str() {
                Some(scheme @ ("socks5" | "socks5h")) => {
                    // socks5h：域名交给代理解析（与 curl 一致）；socks5：本地解析。
                    let mut socks = SocksV5::new(proxy.clone(), http).local_dns(scheme == "socks5");
                    if let Some((user, pass)) = intercept.raw_auth() {
                        socks = socks.with_auth(user.to_owned(), pass.to_owned());
                    }
                    Ok(socks.call(dst).await?)
                }
                _ => {
                    let mut tunnel = Tunnel::new(proxy, http);
                    if let Some(auth) = intercept.basic_auth() {
                        tunnel = tunnel.with_auth(auth.clone());
                    }
                    Ok(tunnel.call(dst).await?)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 假 HTTP 代理：读到 CONNECT 请求头后回 200，返回收到的请求行。
    async fn fake_connect_proxy() -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let mut head = Vec::new();
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                head.extend_from_slice(&buf[..n]);
            }
            socket
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            String::from_utf8_lossy(&head)
                .lines()
                .next()
                .unwrap()
                .to_owned()
        });
        (port, handle)
    }

    #[tokio::test]
    async fn https_goes_through_the_configured_http_proxy() {
        let (port, proxy) = fake_connect_proxy().await;
        let matcher = Matcher::builder()
            .https(format!("http://127.0.0.1:{port}"))
            .build();
        let mut connector = UpstreamConnector::new(matcher);
        connector
            .call("https://api.deepseek.com/chat/completions".parse().unwrap())
            .await
            .unwrap();
        assert_eq!(
            proxy.await.unwrap(),
            "CONNECT api.deepseek.com:443 HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn no_proxy_and_plain_http_connect_directly() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = target.local_addr().unwrap();
        // 代理地址指向一个不存在的端口：若误走代理，连接会失败。
        let matcher = Matcher::builder()
            .all("http://127.0.0.1:1")
            .no("127.0.0.1")
            .build();
        let mut connector = UpstreamConnector::new(matcher);
        connector
            .call(format!("https://{addr}/").parse().unwrap())
            .await
            .unwrap();
        let matcher = Matcher::builder().all("http://127.0.0.1:1").build();
        let mut connector = UpstreamConnector::new(matcher);
        connector
            .call(format!("http://{addr}/").parse().unwrap())
            .await
            .unwrap();
    }
}
