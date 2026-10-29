//! 远程访问：tailnet 上的浏览器打开的就是桌面 GUI 本身。
//!
//! 页面 HTML 里注入 `shim.js`，在浏览器里实现 `__TAURI_INTERNALS__`；本服务端：
//! - `GET /__berth/ws?client=<页面 id>&received=<已收条数>[&z=1]`：每个浏览器页面一条 WebSocket，命令请求 / 响应（带 id 多路复用）、订阅的事件
//!   （`listen_any`）、终端输出包都在上面。命令交给主窗口 webview 的 `on_message`，走 Tauri 自己的
//!   命令分发与 ACL，所有命令无需逐个适配；唯一的 Channel 命令 `terminal_attach_channel` 在这里直接
//!   attach。断线期间消息留在有界队列里，重连后补发。
//! - `GET /__berth/term?client=<页面 id>&received=<已收条数>[&z=1]`：终端专线，每页一条，只走终端：
//!   attach / resize / detach 命令（帧格式同上）、按键字节流、终端输出与输入确认。专线上只有小帧，
//!   回显不排在大响应后面，命令线丢包重传也不拖住终端；断线接管与补发同命令线。
//! - 其余 GET：前端静态资源（dev 转发 devUrl，正式版读内嵌资源）。
//!
//! 为什么是一条 WebSocket：每个命令一个 HTTP 请求时，浏览器同主机只开 6 个连接，突发的几十个
//! 命令把槽位占满，终端输入也排在后面（宿主执行 0–26ms，浏览器端等了 3–114s）。
//!
//! 带宽按 100 kbps 级中继设计：大于 1KB 的 JSON 响应 gzip；终端输出按路 deflate；attach 快照
//! 的 ANSI 不走 base64（`FLAG_SNAPSHOT`），原始字节 gzip 比 base64 后再 gzip 小三成；响应带 ETag（轮询未变只回「未变」）；
//! 大响应切成小块与终端、事件轮流发，打开大文件不卡住终端回显；正式版 `/_next/static/` 永久缓存。
//! ponytail: 暂无鉴权，只绑定 tailscale 地址（不绑 0.0.0.0）；协作者增多时再加令牌。
//!
//! 帧格式（大端）：
//! - 页面 → 宿主，二进制：`[u32 meta 长度][meta JSON][请求体]`，meta =
//!   `{id, cmd, json, h?, lane?, etag?}`；`cmd` 为 `__subscribe`（请求体是事件名数组）/ `__log` 时不带 id。
//! - 页面 → 宿主，文本 `ping`：页面在前台时定时发，宿主立即回 `{"pong":true}`；只有它能证明上行
//!   还通（对端 RST 后下行可能还在收数据，页面的输入却全丢了）。
//! - 终端专线，页面 → 宿主，二进制 `[4][u32 channel][u64 偏移][按键字节]`（首字节 4；命令帧首字节是
//!   u32 meta 长度的高位，恒为 0）：偏移是这路 attach 的累计输入字节数，宿主按偏移去重（重连补发恰好
//!   执行一次），比已收位置大则视为页面丢弃了过期输入、直接跳过；序号由宿主按 termd 契约生成。
//! - 宿主 → 页面，文本：`{"resumed":bool}`（每次连上的第一条）、`{"e":事件,"p":载荷}`、`{}`（心跳）、
//!   `{"pong":true}`。
//! - 宿主 → 页面，二进制：`[1][u32 channel][u32 序号][终端包]`；页面带 `z=1` 时改发
//!   `[3][u32 channel][deflate 块]`：每路终端一个 raw deflate 上下文（sync flush），解出
//!   `[u32 长度][终端包]` 序列，序号由页面按到达顺序自数。TUI 重绘高度重复，共享上下文约省 90%；
//!   `[2][u32 id][u8 flags][u32 宿主耗时 ms][u64 etag][响应块]`，flags 见 `FLAG_*`；
//!   终端专线另有 `[4][u32 channel][u64 偏移]`：该偏移之前的输入已写进终端，页面可丢弃缓冲。

use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeError, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::app_error::AppCommandError;
use crate::commands::terminal::{attach_terminal_to_sink, TerminalPacketSink};
use crate::terminal::error::{TerminalError, TerminalErrorCode};
use crate::terminal::manager::{TerminalManager, TerminalOperationError};

/// 正式版与 dev 实例同时运行时各占一个端口。
const PORT: u16 = if cfg!(debug_assertions) { 7421 } else { 7420 };
/// 上传附件、保存大文件是最大的请求体；超出视为异常。
const MAX_BODY_BYTES: usize = 128 * 1024 * 1024;
/// 小于此大小不压缩：gzip 头尾开销抵掉收益。
const GZIP_MIN_BYTES: usize = 1024;
/// 每个页面的待发事件上限：满了就标记溢出，重连后让页面整页重载。空闲时几乎没有事件，
/// 4096 条够手机在后台挂半小时。
const EVENT_QUEUE: usize = 4096;
/// 终端输出单独排队，满了推流等待（宿主侧按既有机制改发重同步），不挤占事件。
const TERMINAL_QUEUE: usize = 256;
/// 页面断线超过这么久就丢弃它的队列与终端 attach（重连时页面就得整页重载）。手机切后台常有
/// 几十分钟；页面真正关掉时 shim 发 `CLOSE_BYE`，不等这么久。
const CLIENT_TTL: Duration = Duration::from_secs(2 * 60 * 60);
/// 最近发出的数据消息留这么多字节：连接无声断掉时，已交给旧连接却没到页面的那几条按页面报的
/// 已收条数补发（终端包按序号交付，丢一包后面全卡住）。
const SENT_KEEP_BYTES: usize = 2 * 1024 * 1024;
/// 页面关闭（不是切后台）时 shim 用的关闭码：宿主立即丢弃这一页。
const CLOSE_BYE: u16 = 4000;
/// 空闲时的心跳间隔：shim 久收不到数据就判定连接已死并重连（iOS 切后台后连接常无声断掉）。
const HEARTBEAT: Duration = Duration::from_secs(15);
/// 响应切块大小：3 Mbps 下约 40ms 一块，块与块之间让终端和事件插队。
const CHUNK_BYTES: usize = 16 * 1024;
/// 内核未发送数据上限：约一块响应，慢链路上排队不超过百毫秒级。
const UNSENT_LOWAT: usize = CHUNK_BYTES;
/// 最近完成的响应留着：断线时没收到的，页面重连后重发同一 id 直接补。
/// 按总字节限：断线的页面要留半小时；放不下的响应断线后让页面重试。
const DONE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// 桌面主窗口：浏览器的命令都以它的身份执行（同一套 ACL 与窗口作用域）。
const MAIN_WINDOW: &str = "main";
const SHIM: &str = include_str!("shim.js");

const FRAME_TERMINAL: u8 = 1;
const FRAME_RESPONSE: u8 = 2;
const FRAME_TERMINAL_DEFLATE: u8 = 3;
/// 终端专线：页面 → 宿主为按键字节流，宿主 → 页面为输入确认。
const FRAME_INPUT: u8 = 4;
/// 输入遇到终端执行队列满时的重试：每次间隔与最多次数（约 5 秒）。
const INPUT_RETRY_DELAY: Duration = Duration::from_millis(20);
const INPUT_RETRIES: usize = 250;
const FLAG_OK: u8 = 1;
const FLAG_JSON: u8 = 2;
const FLAG_FIRST: u8 = 4;
const FLAG_LAST: u8 = 8;
const FLAG_GZIP: u8 = 16;
const FLAG_NOT_MODIFIED: u8 = 32;
/// attach 快照：响应体是 `[u32 meta 长度][快照 JSON（无 ansiBase64）][ANSI 原始字节]`，
/// 页面在本地补回 `ansiBase64`。
const FLAG_SNAPSHOT: u8 = 64;

type Body = UnsyncBoxBody<Bytes, Infallible>;
type Pending = Pin<Box<dyn Future<Output = InvokeResponse> + Send>>;

struct Remote {
    app: AppHandle,
    clients: Mutex<HashMap<String, Arc<Client>>>,
    /// 已挂 `listen_any` 的事件名；不卸载，每个名字一个闭包。
    hooked: Mutex<HashSet<String>>,
}

/// 一个浏览器页面（shim 生成的随机 id）。
struct Client {
    tx: mpsc::Sender<Message>,
    terminal_tx: mpsc::Sender<Message>,
    response_tx: mpsc::UnboundedSender<Message>,
    rx: Mutex<Receivers>,
    /// 第几条连接：新连接接管队列，旧连接（可能已无声断开）随即结束。
    generation: AtomicU64,
    takeover: Notify,
    calls: Mutex<Calls>,
    sent: Mutex<Sent>,
    /// 输入道：上一条带输入序号的请求做完时完成。
    input_tail: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    events: Mutex<HashSet<String>>,
    /// 页面能解 deflate-raw：之后 attach 的终端输出压缩发送。
    deflate: AtomicBool,
    /// 是终端专线（`/__berth/term`）。
    terminal_line: bool,
    /// 终端专线：channel → 这路 attach 的输入状态。
    channels: Mutex<HashMap<u32, TermChannel>>,
    lagged: AtomicBool,
    disconnected_at: Mutex<Option<Instant>>,
}

struct Receivers {
    events: mpsc::Receiver<Message>,
    terminal: mpsc::Receiver<Message>,
    responses: mpsc::UnboundedReceiver<Message>,
    /// 轮流发的起点：终端刷屏时命令响应照样有份。
    turn: usize,
}

/// 页面的命令 id 单调递增；重连后页面重发还没收到响应的请求（同一 id）。
#[derive(Default)]
struct Calls {
    last_id: u64,
    running: HashSet<u64>,
    done: VecDeque<(u64, Vec<Message>)>,
    done_bytes: usize,
}

/// 发给这一页的数据消息（不含首条 `resumed` 与心跳）：总条数与最近的若干条。
#[derive(Default)]
struct Sent {
    count: u64,
    recent: VecDeque<Message>,
    recent_bytes: usize,
}

impl Sent {
    fn record(&mut self, message: &Message) {
        self.count += 1;
        self.recent_bytes += message.len();
        self.recent.push_back(message.clone());
        while self.recent_bytes > SENT_KEEP_BYTES {
            let Some(old) = self.recent.pop_front() else {
                break;
            };
            self.recent_bytes -= old.len();
        }
    }

    /// 页面已收 `received` 条：返回还没到它手里的那些；缺口已不在保留范围内时返回 None。
    fn missing(&self, received: u64) -> Option<Vec<Message>> {
        let gap = usize::try_from(self.count.checked_sub(received)?).ok()?;
        let start = self.recent.len().checked_sub(gap)?;
        Some(self.recent.range(start..).cloned().collect())
    }
}

#[derive(Deserialize)]
struct Meta {
    #[serde(default)]
    id: u64,
    cmd: String,
    #[serde(default)]
    json: bool,
    #[serde(default)]
    h: HashMap<String, String>,
    /// 带输入序号的请求：在这一页的输入道上按到达顺序逐个执行。
    #[serde(default)]
    lane: bool,
    etag: Option<String>,
}

/// 绑定 `BERTH_REMOTE_ADDR`（`ip:port`，空串关闭），否则 `tailscale ip -4` 的地址；
/// 都没有就不启动。
pub async fn host(app: AppHandle) {
    let Some(addr) = bind_addr().await else {
        tracing::info!("[remote] no tailscale address; remote access disabled");
        return;
    };
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::info!("[remote] {addr} unavailable ({error}); not hosting");
            return;
        }
    };
    tracing::info!("[remote] listening on http://{addr}/");
    let remote = Arc::new(Remote {
        app,
        clients: Mutex::default(),
        hooked: Mutex::default(),
    });
    tokio::spawn(reap(remote.clone()));
    loop {
        let Ok((socket, _)) = listener.accept().await else {
            continue;
        };
        // 终端回显一个字节也立刻发，不等 Nagle 攒包。
        let _ = socket.set_nodelay(true);
        limit_unsent(&socket);
        let remote = remote.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let remote = remote.clone();
                async move { Ok::<_, Infallible>(handle(&remote, request).await) }
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .with_upgrades()
                .await;
        });
    }
}

/// 内核里没发出的数据最多留 `UNSENT_LOWAT`，其余留在应用队列。不限时内核发送缓冲可涨到
/// 4MB，在 ~200kbps 的中继上要排几分钟：轮流调度失效，宿主 8ms 的命令浏览器等了 26s，
/// 终端回显也排在大输出后面。
#[cfg(target_os = "linux")]
fn limit_unsent(socket: &tokio::net::TcpStream) {
    use std::os::fd::AsRawFd;
    let lowat = UNSENT_LOWAT as libc::c_int;
    // SAFETY: fd 在 socket 存活期间有效，参数是指向 c_int 的指针与其长度。
    let result = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::IPPROTO_TCP,
            libc::TCP_NOTSENT_LOWAT,
            std::ptr::addr_of!(lowat).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result != 0 {
        tracing::warn!(
            "[remote] TCP_NOTSENT_LOWAT failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

// ponytail: 只在 Linux 设；macOS 宿主要远程时再补（同名选项）。
#[cfg(not(target_os = "linux"))]
fn limit_unsent(_socket: &tokio::net::TcpStream) {}

async fn bind_addr() -> Option<String> {
    if let Ok(addr) = std::env::var("BERTH_REMOTE_ADDR") {
        return (!addr.trim().is_empty()).then(|| addr.trim().to_owned());
    }
    let output = tokio::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .await
        .ok()?;
    let stdout = String::from_utf8(output.stdout).ok()?;
    let ip = stdout.lines().next()?.trim();
    (output.status.success() && !ip.is_empty()).then(|| format!("{ip}:{PORT}"))
}

/// 丢掉断线太久的页面：接收端随之释放，挂在上面的终端推流发送失败后 detach。
async fn reap(remote: Arc<Remote>) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let mut clients = remote.clients.lock().expect("remote clients");
        clients.retain(|_, client| {
            !client
                .disconnected_at
                .lock()
                .expect("client disconnected_at")
                .is_some_and(|since| since.elapsed() > CLIENT_TTL)
        });
    }
}

impl Remote {
    fn client(&self, id: &str) -> Arc<Client> {
        self.clients
            .lock()
            .expect("remote clients")
            .entry(id.to_owned())
            .or_insert_with(|| {
                let (tx, events) = mpsc::channel(EVENT_QUEUE);
                let (terminal_tx, terminal) = mpsc::channel(TERMINAL_QUEUE);
                let (response_tx, responses) = mpsc::unbounded_channel();
                Arc::new(Client {
                    tx,
                    terminal_tx,
                    response_tx,
                    rx: Mutex::new(Receivers {
                        events,
                        terminal,
                        responses,
                        turn: 0,
                    }),
                    generation: AtomicU64::new(0),
                    takeover: Notify::new(),
                    calls: Mutex::default(),
                    input_tail: Mutex::default(),
                    sent: Mutex::default(),
                    events: Mutex::default(),
                    deflate: AtomicBool::new(false),
                    terminal_line: id.ends_with("/term"),
                    channels: Mutex::default(),
                    lagged: AtomicBool::new(false),
                    disconnected_at: Mutex::new(Some(Instant::now())),
                })
            })
            .clone()
    }

    fn subscribe(self: &Arc<Self>, client: &Client, events: HashSet<String>) {
        let mut hooked = self.hooked.lock().expect("remote hooked");
        for event in &events {
            if hooked.insert(event.clone()) {
                let remote = self.clone();
                let name = event.clone();
                self.app.listen_any(event.clone(), move |event| {
                    remote.broadcast(&name, event.payload());
                });
            }
        }
        *client.events.lock().expect("client events") = events;
    }

    fn broadcast(&self, event: &str, payload: &str) {
        let line = format!(
            "{{\"e\":{},\"p\":{}}}",
            serde_json::to_string(event).unwrap_or_default(),
            if payload.is_empty() { "null" } else { payload }
        );
        let message = Message::Text(line.into());
        for client in self.clients.lock().expect("remote clients").values() {
            if !client.events.lock().expect("client events").contains(event) {
                continue;
            }
            if client.tx.try_send(message.clone()).is_err() {
                client.lagged.store(true, Ordering::Relaxed);
            }
        }
    }
}

async fn handle(remote: &Arc<Remote>, request: Request<Incoming>) -> Response<Body> {
    let path = request.uri().path().to_owned();
    if path == "/__berth/ws" || path == "/__berth/term" {
        let query: HashMap<String, String> = request
            .uri()
            .query()
            .map(|query| {
                query
                    .split('&')
                    .filter_map(|pair| pair.split_once('='))
                    .map(|(key, value)| (key.to_owned(), value.to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let received = query.get("received").and_then(|value| value.parse().ok());
        let deflate = query.get("z").is_some_and(|value| value == "1");
        // 专线与命令线各是一个独立的 Client（各自的队列、补发计数）。
        let line = |client: &String| {
            if path == "/__berth/term" {
                format!("{client}/term")
            } else {
                client.clone()
            }
        };
        return match query.get("client") {
            Some(client) => upgrade(
                remote,
                request,
                line(client),
                received.unwrap_or(0),
                deflate,
            ),
            None => plain(StatusCode::BAD_REQUEST, "client is required"),
        };
    }
    if request.method() != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "GET only");
    }
    let headers = request.headers().clone();
    // 静态导出的路由跳转先取 `<页面>.txt`（RSC 载荷），失败时 Next 整页导航到这个 URL，
    // 浏览器就把 `workspace.txt` 当文件下载。Next 的 RSC 请求（导航与预取）一律带 `RSC: 1`，
    // 不带的就是整页导航，送回页面本身；不靠 `Sec-Fetch-Dest`（老 iOS / App 内置浏览器不发）。
    if path.ends_with(".txt") && !headers.contains_key("rsc") {
        let page = path.trim_end_matches(".txt").trim_end_matches("index");
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, if page.is_empty() { "/" } else { page })
            .body(full(Vec::new()))
            .unwrap_or_default();
    }
    let query = request
        .uri()
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    match asset(&remote.app, &path, &query, &headers).await {
        Ok((mime, mut bytes)) => {
            if mime.starts_with("text/html") {
                bytes = inject_shim(bytes);
            }
            // 正式版的 chunk 名带内容哈希；dev 的不一定，永久缓存会拿到旧代码。
            let immutable = !tauri::is_dev() && path.starts_with("/_next/static/");
            respond(&headers, StatusCode::OK, &mime, bytes, immutable)
        }
        Err(error) => plain(StatusCode::NOT_FOUND, &error),
    }
}

fn upgrade(
    remote: &Arc<Remote>,
    request: Request<Incoming>,
    client_id: String,
    received: u64,
    deflate: bool,
) -> Response<Body> {
    let Some(key) = request.headers().get(header::SEC_WEBSOCKET_KEY) else {
        return plain(StatusCode::BAD_REQUEST, "websocket upgrade required");
    };
    let accept = derive_accept_key(key.as_bytes());
    let remote = remote.clone();
    tokio::spawn(async move {
        let Ok(upgraded) = hyper::upgrade::on(request).await else {
            return;
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_BODY_BYTES))
            .max_frame_size(Some(MAX_BODY_BYTES));
        let socket =
            WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config))
                .await;
        let client = remote.client(&client_id);
        client.deflate.store(deflate, Ordering::Relaxed);
        serve(&remote, &client_id, client, received, socket).await;
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept)
        .body(empty())
        .unwrap_or_default()
}

/// 一条连接：接管这一页的队列（旧连接随即结束）。第一条告诉页面宿主是否还保有它的状态：
/// `resumed: false` 且页面之前连上过（宿主重启、页面掉线太久被回收、断线期间事件溢出、
/// 旧连接上丢的消息已补不回），页面就整页重载；否则先补发页面没收到的，再接着发队列。
async fn serve(
    remote: &Arc<Remote>,
    client_id: &str,
    client: Arc<Client>,
    received: u64,
    mut socket: WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>,
) {
    client.takeover.notify_waiters();
    let takeover = client.takeover.notified();
    tokio::pin!(takeover);
    takeover.as_mut().enable();
    let generation = client.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let lagged = client.lagged.swap(false, Ordering::Relaxed);
    *client
        .disconnected_at
        .lock()
        .expect("client disconnected_at") = None;
    let missing = client.sent.lock().expect("client sent").missing(received);
    let resumed = generation > 1 && !lagged && missing.is_some();
    let first = format!("{{\"resumed\":{resumed}}}");
    let mut bye = false;
    // 连接为什么结束：对端 RST 时页面常收不到 close，要靠 shim 的探测发现。
    let mut ended = "replay failed".to_owned();
    let mut alive = socket.send(Message::Text(first.into())).await.is_ok();
    for message in missing.into_iter().flatten() {
        if !alive {
            break;
        }
        alive = socket.send(message).await.is_ok();
    }
    if alive {
        let mut heartbeat =
            tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
        loop {
            tokio::select! {
                biased;
                _ = &mut takeover => {
                    ended = "takeover".into();
                    break;
                }
                incoming = socket.next() => match incoming {
                    Some(Ok(Message::Binary(frame))) => {
                        if frame.first() == Some(&FRAME_INPUT) {
                            input(&client, &frame);
                        } else {
                            request(remote, &client, frame);
                        }
                    }
                    // 页面的探测：立刻回 pong（证明上行也通），不进补发计数。
                    Some(Ok(Message::Text(text))) if text.as_str() == "ping" => {
                        if socket.send(Message::Text("{\"pong\":true}".into())).await.is_err() {
                            ended = "pong send failed".into();
                            break;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        ended = format!("close frame {frame:?}");
                        bye = frame.is_some_and(|frame| u16::from(frame.code) == CLOSE_BYE);
                        break;
                    }
                    Some(Err(error)) => {
                        ended = format!("read error: {error}");
                        break;
                    }
                    None => {
                        ended = "read eof".into();
                        break;
                    }
                    Some(Ok(_)) => {}
                },
                message = next_outgoing(&client) => {
                    client.sent.lock().expect("client sent").record(&message);
                    if let Err(error) = socket.send(message).await {
                        ended = format!("send error: {error}");
                        break;
                    }
                    heartbeat.reset();
                }
                _ = heartbeat.tick() => {
                    if socket.send(Message::Text("{}".into())).await.is_err() {
                        ended = "heartbeat send failed".into();
                        break;
                    }
                }
            }
        }
    }
    tracing::info!("[remote] {client_id}: connection {generation} ended: {ended}");
    if client.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    if bye {
        remote
            .clients
            .lock()
            .expect("remote clients")
            .remove(client_id);
        return;
    }
    *client
        .disconnected_at
        .lock()
        .expect("client disconnected_at") = Some(Instant::now());
}

/// 终端、事件、命令响应三队轮流取一条。
fn next_outgoing(client: &Client) -> impl Future<Output = Message> + '_ {
    std::future::poll_fn(move |cx| {
        let mut rx = client.rx.lock().expect("client rx");
        for step in 0..3 {
            let which = (rx.turn + step) % 3;
            let polled = match which {
                0 => rx.terminal.poll_recv(cx),
                1 => rx.events.poll_recv(cx),
                _ => rx.responses.poll_recv(cx),
            };
            if let Poll::Ready(Some(message)) = polled {
                rx.turn = which + 1;
                return Poll::Ready(message);
            }
        }
        Poll::Pending
    })
}

/// 解一帧请求并开始执行：派发在读循环里按到达顺序进行（与 webview 自己的 IPC 一样），
/// 等结果在单独的任务里，慢命令不挡后面的命令。
fn request(remote: &Arc<Remote>, client: &Arc<Client>, frame: Bytes) {
    let Some((meta, body)) = split_frame(&frame) else {
        tracing::warn!("[remote] malformed request frame");
        return;
    };
    match meta.cmd.as_str() {
        "__subscribe" => {
            let events: HashSet<String> = serde_json::from_slice(&body).unwrap_or_default();
            remote.subscribe(client, events);
            return;
        }
        "__log" => {
            // 浏览器页面的未捕获错误、慢命令：远端（如 iPad Safari）没有开发者工具可看。
            tracing::warn!("[remote] page: {}", String::from_utf8_lossy(&body));
            return;
        }
        _ => {}
    }
    let id = meta.id;
    {
        let mut calls = client.calls.lock().expect("client calls");
        if let Some((_, frames)) = calls.done.iter().find(|(done, _)| *done == id) {
            // 断线时没收到的响应：原样补发（页面按 id 去重）。
            for frame in frames {
                let _ = client.response_tx.send(frame.clone());
            }
            return;
        }
        if calls.running.contains(&id) {
            return;
        }
        if id <= calls.last_id {
            drop(calls);
            let error = failure("The connection dropped before the reply arrived; retry.".into());
            send_response(client, id, &meta.cmd, error, Duration::ZERO, None);
            return;
        }
        calls.last_id = id;
        calls.running.insert(id);
    }
    let started = Instant::now();
    let client = client.clone();
    // 带输入序号的请求（终端写入、resize）在这一页的输入道上逐个执行：页面不等回执连发，
    // 宿主要求序号连续（`attach_io.rs`）。
    if meta.lane {
        let (done, next) = tokio::sync::oneshot::channel();
        let previous = client
            .input_tail
            .lock()
            .expect("client input tail")
            .replace(next);
        let remote = remote.clone();
        tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            // 断线恢复后积压的输入会一口气到达，可能塞满终端执行队列（64）。被拒的输入没执行、
            // 序号也没记下，原样再试不会重复；输入道等它成功再放后面的，序号就不会断。
            let mut response = invoke(&remote, &client, &meta, body.clone()).await;
            for _ in 0..50 {
                if !is_backpressure(&response) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                response = invoke(&remote, &client, &meta, body.clone()).await;
            }
            let _ = done.send(());
            send_response(&client, id, &meta.cmd, response, started.elapsed(), None);
        });
        return;
    }
    let pending = invoke(remote, &client, &meta, body);
    tokio::spawn(async move {
        let response = pending.await;
        send_response(
            &client,
            id,
            &meta.cmd,
            response,
            started.elapsed(),
            meta.etag.as_deref(),
        );
    });
}

fn split_frame(frame: &Bytes) -> Option<(Meta, Bytes)> {
    let len = u32::from_be_bytes(frame.get(..4)?.try_into().ok()?) as usize;
    let meta = serde_json::from_slice(frame.get(4..4 + len)?).ok()?;
    Some((meta, frame.slice(4 + len..)))
}

/// 以桌面主窗口的身份执行一条命令，结果与 Tauri IPC 协议一致。同步部分（含主线程派发）立即执行。
fn invoke(remote: &Arc<Remote>, client: &Arc<Client>, meta: &Meta, body: Bytes) -> Pending {
    let ready = |response: InvokeResponse| -> Pending { Box::pin(async move { response }) };
    let body = if meta.json {
        match serde_json::from_slice(&body) {
            Ok(value) => InvokeBody::Json(value),
            Err(_) if body.is_empty() => InvokeBody::Json(serde_json::Value::Null),
            Err(error) => return ready(failure(error.to_string())),
        }
    } else {
        InvokeBody::Raw(body.to_vec())
    };
    if meta.cmd == "terminal_attach_channel" {
        let remote = remote.clone();
        let client = client.clone();
        return Box::pin(async move { attach_terminal(&remote, &client, body).await });
    }
    if meta.cmd == "terminal_resize_attached" {
        if let Some(pending) = resize_on_channel(client, &body) {
            return pending;
        }
    }
    if meta.cmd == "terminal_detach" {
        forget_channels(client, &body);
    }
    let app = &remote.app;
    let Some(webview) = app.get_webview(MAIN_WINDOW) else {
        return ready(failure(
            "The Berth desktop main window is not open on the host.".into(),
        ));
    };
    let url = match webview.url() {
        Ok(url) => url,
        Err(error) => return ready(failure(error.to_string())),
    };
    let mut headers = HeaderMap::new();
    for (name, value) in &meta.h {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(name, value);
        }
    }
    let content_type = if meta.json {
        "application/json"
    } else {
        "application/octet-stream"
    };
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    let request = InvokeRequest {
        cmd: meta.cmd.clone(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body,
        headers,
        invoke_key: app.invoke_key().to_owned(),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    // 与 webview 自己的 IPC 一样在主线程分发：同步命令的线程语义不变。
    let dispatched = app.run_on_main_thread(move || {
        webview.on_message(
            request,
            Box::new(move |_webview, _cmd, response, _callback, _error| {
                let _ = tx.send(response);
            }),
        );
    });
    if let Err(error) = dispatched {
        return ready(failure(error.to_string()));
    }
    Box::pin(async move {
        rx.await
            .unwrap_or_else(|_| failure("The command was dropped without a response.".into()))
    })
}

/// 终端输出走这一页的连接：`[1][u32 channel][u32 序号][包]`，由 shim 交给前端 `Channel` 的回调
/// （与桌面 Channel 消息形状相同）。
struct ChannelSink {
    channel: u32,
    index: u64,
    tx: mpsc::Sender<Message>,
    deflate: Option<flate2::Compress>,
}

impl TerminalPacketSink for ChannelSink {
    async fn send_packet(&mut self, packet: Vec<u8>) -> bool {
        if let Some(compress) = &mut self.deflate {
            let mut input = Vec::with_capacity(4 + packet.len());
            input.extend_from_slice(&(packet.len() as u32).to_be_bytes());
            input.extend_from_slice(&packet);
            let mut frame = Vec::with_capacity(5 + packet.len() / 2 + 64);
            frame.push(FRAME_TERMINAL_DEFLATE);
            frame.extend_from_slice(&self.channel.to_be_bytes());
            if !deflate_sync(compress, &input, &mut frame) {
                return false;
            }
            return self.tx.send(Message::Binary(frame.into())).await.is_ok();
        }
        let mut frame = Vec::with_capacity(9 + packet.len());
        frame.push(FRAME_TERMINAL);
        frame.extend_from_slice(&self.channel.to_be_bytes());
        // ponytail: 序号截成 u32，单个 attach 超过 40 亿包才回绕
        frame.extend_from_slice(&(self.index as u32).to_be_bytes());
        frame.extend_from_slice(&packet);
        self.index += 1;
        self.tx.send(Message::Binary(frame.into())).await.is_ok()
    }
}

/// 压缩 `input` 并 sync flush，追加到 `out`：页面收到这一块就能解出全部内容。
fn deflate_sync(compress: &mut flate2::Compress, input: &[u8], out: &mut Vec<u8>) -> bool {
    let start = compress.total_in();
    loop {
        if out.capacity() - out.len() < 64 {
            out.reserve(out.capacity().max(256));
        }
        let consumed = (compress.total_in() - start) as usize;
        if compress
            .compress_vec(&input[consumed..], out, flate2::FlushCompress::Sync)
            .is_err()
        {
            return false;
        }
        // 输入吃完且输出没写满，sync flush 才算完成。
        if (compress.total_in() - start) as usize == input.len() && out.len() < out.capacity() {
            return true;
        }
    }
}

async fn attach_terminal(
    remote: &Remote,
    client: &Arc<Client>,
    body: InvokeBody,
) -> InvokeResponse {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        terminal_id: String,
        client_id: String,
        on_output: String,
    }
    let InvokeBody::Json(value) = body else {
        return failure("terminal_attach_channel expects JSON".into());
    };
    let args: Args = match serde_json::from_value(value) {
        Ok(args) => args,
        Err(error) => return failure(error.to_string()),
    };
    let Some(channel) = args
        .on_output
        .strip_prefix("__CHANNEL__:")
        .and_then(|id| id.parse().ok())
    else {
        return failure("onOutput must be a channel".into());
    };
    let ids = (args.terminal_id.clone(), args.client_id.clone());
    let sink = ChannelSink {
        channel,
        index: 0,
        tx: client.terminal_tx.clone(),
        deflate: client
            .deflate
            .load(Ordering::Relaxed)
            .then(|| flate2::Compress::new(flate2::Compression::fast(), false)),
    };
    let manager = remote.app.state::<TerminalManager>().inner().clone();
    match attach_terminal_to_sink(&manager, args.terminal_id, args.client_id, sink).await {
        Ok(snapshot) => {
            open_channel(&manager, client, channel, ids);
            snapshot_response(snapshot)
        }
        Err(error) => InvokeResponse::Err(InvokeError(
            serde_json::to_value::<AppCommandError>(error).unwrap_or_default(),
        )),
    }
}

/// 快照响应：ANSI 不走 base64（`FLAG_SNAPSHOT`），页面在本地补回 `ansiBase64`。
fn snapshot_response(mut snapshot: crate::terminal::protocol::TerminalSnapshot) -> InvokeResponse {
    let ansi = std::mem::take(&mut snapshot.ansi);
    match serde_json::to_vec(&snapshot) {
        Ok(json) => {
            let mut body = Vec::with_capacity(4 + json.len() + ansi.len());
            body.extend_from_slice(&(json.len() as u32).to_be_bytes());
            body.extend_from_slice(&json);
            body.extend_from_slice(&ansi);
            InvokeResponse::Ok(InvokeResponseBody::Raw(body))
        }
        Err(error) => failure(error.to_string()),
    }
}

/// 专线上一路 attach 的输入：按键与 resize 在同一条有序队列里执行（共用 termd 的输入序号）。
struct TermChannel {
    terminal_id: String,
    client_id: String,
    /// 已收下的输入字节数：页面重连后补发的部分按它去重。
    accepted: u64,
    ops: mpsc::UnboundedSender<TermOp>,
}

enum TermOp {
    Input {
        data: Vec<u8>,
        end: u64,
    },
    Resize {
        rows: u16,
        cols: u16,
        reply: tokio::sync::oneshot::Sender<InvokeResponse>,
    },
}

/// 只在终端专线上登记：命令线上的 attach 仍走页面传来的输入序号（旧路径）。
fn open_channel(
    manager: &TerminalManager,
    client: &Arc<Client>,
    channel: u32,
    (terminal_id, client_id): (String, String),
) {
    if !client.terminal_line {
        return;
    }
    let (ops, rx) = mpsc::unbounded_channel();
    tokio::spawn(run_channel(
        manager.clone(),
        client.response_tx.clone(),
        channel,
        (terminal_id.clone(), client_id.clone()),
        rx,
    ));
    client.channels.lock().expect("client channels").insert(
        channel,
        TermChannel {
            terminal_id,
            client_id,
            accepted: 0,
            ops,
        },
    );
}

/// 页面的按键字节：按偏移去重后排进这路的输入队列。
fn input(client: &Client, frame: &[u8]) {
    let Some((channel, offset, data)) = frame.get(13..).and_then(|data| {
        let channel = u32::from_be_bytes(frame.get(1..5)?.try_into().ok()?);
        let offset = u64::from_be_bytes(frame.get(5..13)?.try_into().ok()?);
        Some((channel, offset, data))
    }) else {
        tracing::warn!("[remote] malformed input frame");
        return;
    };
    let mut channels = client.channels.lock().expect("client channels");
    let Some(state) = channels.get_mut(&channel) else {
        return;
    };
    let end = offset + data.len() as u64;
    if end <= state.accepted {
        return;
    }
    let skip = usize::try_from(state.accepted.saturating_sub(offset)).unwrap_or(usize::MAX);
    state.accepted = end;
    let _ = state.ops.send(TermOp::Input {
        data: data[skip.min(data.len())..].to_vec(),
        end,
    });
}

fn resize_on_channel(client: &Client, body: &InvokeBody) -> Option<Pending> {
    #[derive(Deserialize)]
    struct Args {
        ch: u32,
        rows: u16,
        cols: u16,
    }
    let InvokeBody::Json(value) = body else {
        return None;
    };
    let args: Args = serde_json::from_value(value.clone()).ok()?;
    let (reply, rx) = tokio::sync::oneshot::channel();
    let channels = client.channels.lock().expect("client channels");
    let sent = channels.get(&args.ch).is_some_and(|state| {
        state
            .ops
            .send(TermOp::Resize {
                rows: args.rows,
                cols: args.cols,
                reply,
            })
            .is_ok()
    });
    if !sent {
        return Some(Box::pin(async {
            failure("The terminal is not attached on this connection.".into())
        }));
    }
    Some(Box::pin(async move {
        rx.await
            .unwrap_or_else(|_| failure("The terminal input lane stopped.".into()))
    }))
}

/// detach 前丢掉这路的输入状态（队列里已收下的输入照样写完）；detach 本身照常走命令分发。
fn forget_channels(client: &Client, body: &InvokeBody) {
    let InvokeBody::Json(value) = body else {
        return;
    };
    let field = |name: &str| value.get(name).and_then(|v| v.as_str()).unwrap_or_default();
    let (terminal_id, client_id) = (field("terminalId"), field("clientId"));
    client
        .channels
        .lock()
        .expect("client channels")
        .retain(|_, state| state.terminal_id != terminal_id || state.client_id != client_id);
}

/// 一路 attach 的输入执行者：逐个写入 / resize，序号取 termd 已收下的下一个；写完回确认。
async fn run_channel(
    manager: TerminalManager,
    acks: mpsc::UnboundedSender<Message>,
    channel: u32,
    ids: (String, String),
    mut ops: mpsc::UnboundedReceiver<TermOp>,
) {
    while let Some(op) = ops.recv().await {
        match op {
            TermOp::Input { data, end } => {
                let result = ordered(&manager, &ids, move |manager, terminal, client, sequence| {
                    manager
                        .write_attached(terminal, client, sequence, &data)
                        .map(|_| ())
                })
                .await;
                if let Err(error) = result {
                    tracing::warn!("[remote] terminal input dropped: {error}");
                }
                let mut frame = Vec::with_capacity(13);
                frame.push(FRAME_INPUT);
                frame.extend_from_slice(&channel.to_be_bytes());
                frame.extend_from_slice(&end.to_be_bytes());
                let _ = acks.send(Message::Binary(frame.into()));
            }
            TermOp::Resize { rows, cols, reply } => {
                let result = ordered(&manager, &ids, move |manager, terminal, client, sequence| {
                    manager.resize_attached(terminal, client, sequence, cols, rows)
                })
                .await;
                let _ = reply.send(match result {
                    Ok(snapshot) => snapshot_response(snapshot),
                    Err(error) => InvokeResponse::Err(InvokeError(
                        serde_json::to_value(AppCommandError::from(error)).unwrap_or_default(),
                    )),
                });
            }
        }
    }
}

/// 以 termd 已收下的下一个序号执行一次输入操作；执行队列满时稍候重试（没执行的不会重复）。
async fn ordered<T, F>(
    manager: &TerminalManager,
    ids: &(String, String),
    op: F,
) -> Result<T, TerminalOperationError>
where
    T: Send + 'static,
    F: Fn(&TerminalManager, &str, &str, u64) -> Result<T, TerminalOperationError>
        + Send
        + Sync
        + 'static,
{
    let op = Arc::new(op);
    for _ in 0..INPUT_RETRIES {
        let (manager, op) = (manager.clone(), op.clone());
        let (terminal, client) = ids.clone();
        let result = tokio::task::spawn_blocking(move || {
            let sequence = manager.accepted_input_sequence(&terminal, &client)? + 1;
            op(&manager, &terminal, &client, sequence)
        })
        .await
        .unwrap_or_else(|_| Err(TerminalErrorCode::TerminalTransportDisconnected.into()));
        let backpressure = matches!(
            result,
            Err(TerminalOperationError::Runtime(TerminalError::InputBackpressure))
                | Err(TerminalOperationError::Protocol(TerminalErrorCode::InputBackpressure))
        );
        if !backpressure {
            return result;
        }
        tokio::time::sleep(INPUT_RETRY_DELAY).await;
    }
    Err(TerminalErrorCode::InputBackpressure.into())
}

fn is_backpressure(response: &InvokeResponse) -> bool {
    matches!(response, InvokeResponse::Err(InvokeError(error))
        if error.get("code").and_then(|code| code.as_str()) == Some("input_backpressure"))
}

fn failure(message: String) -> InvokeResponse {
    InvokeResponse::Err(InvokeError(serde_json::Value::String(message)))
}

/// 响应切块排进这一页的响应队列，并留一份给断线重发。
fn send_response(
    client: &Client,
    id: u64,
    cmd: &str,
    response: InvokeResponse,
    took: Duration,
    etag: Option<&str>,
) {
    if let InvokeResponse::Err(InvokeError(error)) = &response {
        tracing::warn!("[remote] {cmd} failed: {error}");
    }
    let snapshot = cmd == "terminal_attach_channel" || cmd == "terminal_resize_attached";
    let frames = response_frames(id, response, took, etag, snapshot);
    for frame in &frames {
        let _ = client.response_tx.send(frame.clone());
    }
    let mut calls = client.calls.lock().expect("client calls");
    calls.running.remove(&id);
    let size: usize = frames.iter().map(Message::len).sum();
    if size <= DONE_MAX_BYTES {
        while calls.done_bytes + size > DONE_MAX_BYTES {
            let Some((_, old)) = calls.done.pop_front() else {
                break;
            };
            calls.done_bytes -= old.iter().map(Message::len).sum::<usize>();
        }
        calls.done_bytes += size;
        calls.done.push_back((id, frames));
    }
}

fn response_frames(
    id: u64,
    response: InvokeResponse,
    took: Duration,
    etag: Option<&str>,
    snapshot: bool,
) -> Vec<Message> {
    let (mut flags, mut bytes) = match response {
        InvokeResponse::Ok(InvokeResponseBody::Json(json)) => (FLAG_OK | FLAG_JSON, json.into_bytes()),
        InvokeResponse::Ok(InvokeResponseBody::Raw(bytes)) if snapshot => {
            (FLAG_OK | FLAG_SNAPSHOT, bytes)
        }
        InvokeResponse::Ok(InvokeResponseBody::Raw(bytes)) => (FLAG_OK, bytes),
        InvokeResponse::Err(InvokeError(value)) => {
            (FLAG_JSON, serde_json::to_vec(&value).unwrap_or_default())
        }
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let hash = hasher.finish();
    // 只缓存成功结果：出错不回「未变」。
    if flags & FLAG_OK != 0 && etag == Some(format!("{hash:x}").as_str()) {
        flags |= FLAG_NOT_MODIFIED;
        bytes.clear();
    } else if flags & (FLAG_JSON | FLAG_SNAPSHOT) != 0 && bytes.len() >= GZIP_MIN_BYTES {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        if encoder.write_all(&bytes).is_ok() {
            if let Ok(gzipped) = encoder.finish() {
                flags |= FLAG_GZIP;
                bytes = gzipped;
            }
        }
    }
    let took = u32::try_from(took.as_millis()).unwrap_or(u32::MAX);
    let chunks: Vec<&[u8]> = if bytes.is_empty() {
        vec![&[]]
    } else {
        bytes.chunks(CHUNK_BYTES).collect()
    };
    let last = chunks.len() - 1;
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            let mut chunk_flags = flags;
            if index == 0 {
                chunk_flags |= FLAG_FIRST;
            }
            if index == last {
                chunk_flags |= FLAG_LAST;
            }
            let mut frame = Vec::with_capacity(18 + chunk.len());
            frame.push(FRAME_RESPONSE);
            frame.extend_from_slice(&(id as u32).to_be_bytes());
            frame.push(chunk_flags);
            frame.extend_from_slice(&took.to_be_bytes());
            frame.extend_from_slice(&hash.to_be_bytes());
            frame.extend_from_slice(chunk);
            Message::Binary(frame.into())
        })
        .collect()
}

/// 把 shim 插在 `<head>` 最前：先于页面所有脚本执行。
fn inject_shim(html: Vec<u8>) -> Vec<u8> {
    let text = String::from_utf8_lossy(&html);
    let Some(head) = text.find("<head") else {
        return html;
    };
    let Some(close) = text[head..].find('>') else {
        return html;
    };
    let at = head + close + 1;
    let mut injected = String::with_capacity(text.len() + SHIM.len() + 20);
    injected.push_str(&text[..at]);
    injected.push_str("<script>");
    injected.push_str(SHIM);
    injected.push_str("</script>");
    injected.push_str(&text[at..]);
    injected.into_bytes()
}

/// dev 转发 devUrl（Next dev server）；正式版读内嵌资源（自动补 `.html` / `index.html`）。
async fn asset(
    app: &AppHandle,
    path: &str,
    query: &str,
    headers: &HeaderMap,
) -> Result<(String, Vec<u8>), String> {
    if tauri::is_dev() {
        let base = app
            .config()
            .build
            .dev_url
            .clone()
            .ok_or_else(|| "devUrl is not configured".to_owned())?;
        let url = format!("{}{path}{query}", base.as_str().trim_end_matches('/'));
        // RSC 请求头（`RSC`、`Next-Router-*`、`Next-Url`）必须带上：缺了 Next dev 回整页 HTML，
        // 前端认不出 RSC 载荷，每次路由跳转都退化成整页重载。
        let mut request = reqwest::Client::new().get(&url);
        for (name, value) in headers {
            let name = name.as_str();
            if name == "rsc" || name.starts_with("next-") {
                request = request.header(name, value.as_bytes());
            }
        }
        let response = request
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("{url}: {}", response.status()));
        }
        let mime = response
            .headers()
            .get(header::CONTENT_TYPE.as_str())
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        return Ok((mime, bytes.to_vec()));
    }
    let asset = app
        .asset_resolver()
        .get(path.to_owned())
        .ok_or_else(|| format!("{path} not found"))?;
    Ok((asset.mime_type, asset.bytes))
}

/// 统一出口：ETag / 304、缓存头、按需 gzip。
fn respond(
    request: &HeaderMap,
    status: StatusCode,
    mime: &str,
    bytes: Vec<u8>,
    immutable: bool,
) -> Response<Body> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let etag = format!("\"{:x}\"", hasher.finish());
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let matched = status == StatusCode::OK
        && request
            .get(header::IF_NONE_MATCH)
            .is_some_and(|value| value.as_bytes() == etag.as_bytes());
    let builder = Response::builder()
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, cache);
    if matched {
        return builder
            .status(StatusCode::NOT_MODIFIED)
            .body(empty())
            .unwrap_or_default();
    }
    let builder = builder
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::VARY, "accept-encoding");
    if bytes.len() >= GZIP_MIN_BYTES && compressible(mime) && accepts_gzip(request) {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        if encoder.write_all(&bytes).is_ok() {
            if let Ok(gzipped) = encoder.finish() {
                return builder
                    .header(header::CONTENT_ENCODING, "gzip")
                    .body(full(gzipped))
                    .unwrap_or_default();
            }
        }
    }
    builder.body(full(bytes)).unwrap_or_default()
}

fn full(bytes: Vec<u8>) -> Body {
    BodyExt::boxed_unsync(Full::new(Bytes::from(bytes)))
}

fn empty() -> Body {
    full(Vec::new())
}

fn compressible(mime: &str) -> bool {
    mime.starts_with("text/")
        || ["javascript", "json", "svg", "xml", "wasm"]
            .iter()
            .any(|kind| mime.contains(kind))
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("gzip"))
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        )
        .body(full(message.as_bytes().to_vec()))
        .unwrap_or_default()
}
