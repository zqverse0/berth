//! 保真闸门（S0）：同一请求直连与经代理到达上游的原始字节逐项比对，并验证流式逐块透传。
//! `cargo test -p berth-provider-proxy --test fidelity -- --nocapture` 打印两份原始请求。

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use std::sync::Arc;

use berth_provider_proxy::{serve, Denied, Resolver, Route, RouteRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const BODY: &str =
    r#"{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;
const CHUNK_GAP: Duration = Duration::from_millis(400);

/// 上游：记录原始请求字节，回一个分两块、中间停顿的 SSE 流。
async fn spawn_echo_upstream() -> (SocketAddr, mpsc::UnboundedReceiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let raw = read_http_request(&mut socket).await;
            tx.send(raw).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\
                      transfer-encoding: chunked\r\n\r\n11\r\ndata: chunk-one\n\n\r\n",
                )
                .await
                .unwrap();
            tokio::time::sleep(CHUNK_GAP).await;
            socket
                .write_all(b"11\r\ndata: chunk-two\n\n\r\n0\r\n\r\n")
                .await
                .unwrap();
        }
    });
    (addr, rx)
}

struct TestResolver(SocketAddr);

impl Resolver for TestResolver {
    /// 服务商 `1` 的 `claude` 协议 → 回显上游；令牌 `berth-tk-fake` ↔ 真 key `sk-real`。
    async fn resolve(&self, request: RouteRequest) -> Result<Route, Denied> {
        if request.token != "berth-tk-fake" {
            return Err(Denied::InvalidToken);
        }
        if (request.provider.as_str(), request.protocol.as_str()) != ("1", "claude") {
            return Err(Denied::UnknownProvider);
        }
        assert_eq!(request.model.as_deref(), Some("deepseek-chat"));
        Ok(Route {
            upstream_base: format!("http://{}", self.0),
            key: "sk-real".to_owned(),
        })
    }
}

async fn spawn_proxy(upstream: SocketAddr) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let client = berth_provider_proxy::upstream_client().unwrap();
    tokio::spawn(serve(listener, client, Arc::new(TestResolver(upstream))));
    addr
}

/// 模拟 Claude Code（Node）直连时的请求：混合大小写、特定顺序。
fn client_request(host: SocketAddr, prefix: &str, api_key: &str, with_accept: bool) -> Vec<u8> {
    let accept = if with_accept {
        "Accept: application/json\r\n"
    } else {
        ""
    };
    format!(
        "POST {prefix}/v1/messages?beta=true HTTP/1.1\r\n\
         Host: {host}\r\n\
         {accept}\
         X-Stainless-Lang: js\r\n\
         anthropic-version: 2023-06-01\r\n\
         anthropic-beta: claude-code-20250219\r\n\
         x-api-key: {api_key}\r\n\
         User-Agent: claude-cli/2.1.217 (external, cli)\r\n\
         content-type: application/json\r\n\
         accept-encoding: gzip, deflate\r\n\
         Content-Length: {}\r\n\
         Connection: keep-alive\r\n\r\n{BODY}",
        BODY.len()
    )
    .into_bytes()
}

async fn read_http_request(socket: &mut TcpStream) -> Vec<u8> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = socket.read(&mut buf).await.unwrap();
        raw.extend_from_slice(&buf[..n]);
        if let Some(end) = find(&raw, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
            let len = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .map_or(0, |v| v.trim().parse::<usize>().unwrap());
            if raw.len() >= end + 4 + len {
                return raw;
            }
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 发送请求并返回 (响应原始字节, 首个数据块到达耗时)。
async fn send(target: SocketAddr, request: &[u8]) -> (Vec<u8>, Duration) {
    let mut socket = TcpStream::connect(target).await.unwrap();
    let started = Instant::now();
    socket.write_all(request).await.unwrap();
    let mut response = Vec::new();
    let mut first_chunk = None;
    let mut buf = [0u8; 4096];
    loop {
        let n = socket.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        response.extend_from_slice(&buf[..n]);
        if first_chunk.is_none() && find(&response, b"chunk-one").is_some() {
            first_chunk = Some(started.elapsed());
        }
        if find(&response, b"0\r\n\r\n").is_some() {
            break;
        }
    }
    (response, first_chunk.expect("first chunk never arrived"))
}

/// 直连与经代理各发一次，返回 (直连原始请求, 经代理原始请求, 直连响应, 经代理响应, 首块耗时)。
async fn round_trip(with_accept: bool) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Duration) {
    let (upstream, mut captured) = spawn_echo_upstream().await;
    let proxy = spawn_proxy(upstream).await;
    let (direct_response, _) = send(
        upstream,
        &client_request(upstream, "", "sk-real", with_accept),
    )
    .await;
    let direct = captured.recv().await.unwrap();
    let (proxied_response, first_chunk) = send(
        proxy,
        &client_request(proxy, "/p/1/claude", "berth-tk-fake", with_accept),
    )
    .await;
    let proxied = captured.recv().await.unwrap();
    (
        direct,
        proxied,
        direct_response,
        proxied_response,
        first_chunk,
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn upstream_receives_byte_identical_request() {
    for with_accept in [true, false] {
        let (direct, proxied, ..) = round_trip(with_accept).await;
        println!("=== direct ===\n{}", String::from_utf8_lossy(&direct));
        println!("=== proxied ===\n{}", String::from_utf8_lossy(&proxied));
        // 假令牌换成真 key、Host 换成上游后，上游收到的字节与直连完全相同：
        // 头名大小写、顺序、值、请求体，且代理没有补任何头。
        assert_eq!(
            String::from_utf8_lossy(&direct),
            String::from_utf8_lossy(&proxied),
            "with_accept={with_accept}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn response_streams_through_unchanged() {
    let (_, _, direct_response, proxied_response, first_chunk) = round_trip(true).await;
    println!(
        "=== direct response ===\n{}",
        String::from_utf8_lossy(&direct_response)
    );
    println!(
        "=== proxied response ===\n{}",
        String::from_utf8_lossy(&proxied_response)
    );
    // 第一块必须在上游发第二块之前到达调用方（没有攒包）。
    assert!(
        first_chunk < CHUNK_GAP,
        "first chunk buffered: {first_chunk:?}"
    );
    assert_eq!(
        String::from_utf8_lossy(&direct_response),
        String::from_utf8_lossy(&proxied_response),
        "response bytes"
    );
}

/// 发一个请求到代理，返回状态行。
async fn status_line(proxy: SocketAddr, request: String) -> String {
    let mut socket = TcpStream::connect(proxy).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 256];
    let n = socket.read(&mut buf).await.unwrap();
    String::from_utf8_lossy(&buf[..n])
        .lines()
        .next()
        .unwrap()
        .to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_untrusted_callers_before_touching_upstream() {
    let (upstream, mut captured) = spawn_echo_upstream().await;
    let proxy = spawn_proxy(upstream).await;
    let get = |path: &str, host: &str, extra: &str| {
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n")
    };
    let local = proxy.to_string();
    let cases = [
        (
            get("/p/1/claude/v1/models", &local, "x-api-key: wrong\r\n"),
            "401",
        ),
        (get("/p/1/claude/v1/models", &local, ""), "401"),
        (
            get(
                "/p/2/claude/v1/models",
                &local,
                "x-api-key: berth-tk-fake\r\n",
            ),
            "404",
        ),
        (
            get("/v1/models", &local, "x-api-key: berth-tk-fake\r\n"),
            "404",
        ),
        (
            get(
                "/p/1/claude/v1/models",
                "evil.example",
                "x-api-key: berth-tk-fake\r\n",
            ),
            "403",
        ),
        (
            get(
                "/p/1/claude/v1/models",
                &local,
                "x-api-key: berth-tk-fake\r\nOrigin: https://evil.example\r\n",
            ),
            "403",
        ),
    ];
    for (request, expected) in cases {
        let line = status_line(proxy, request.clone()).await;
        assert!(line.contains(expected), "{request:?} -> {line}");
    }
    assert!(
        captured.try_recv().is_err(),
        "a rejected request reached upstream"
    );
}
