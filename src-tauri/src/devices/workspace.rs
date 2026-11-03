//! 到对方 GUI 的命令线：对方项目在本机 Berth 里直接用，界面是本机的，属于对方项目的调用
//! 由前端（`src/lib/transport/device.ts`）经这里发给对方 GUI，只传参数与结果。
//!
//! 本机每台设备一个回环端口，接到的每条连接（WebSocket 命令线、终端专线）作为一条隧道流经这台设备
//! 唯一的节点会话（[`super::Node`]，[`Request::Connect`] 等）送到对方 `berth node`，再接到对方 GUI 的
//! 设备 socket（`remote::DEVICE_SOCKET`）。会话自带优先级与基于时延的拥塞控制：终端专线插队，命令线
//! 普通，其余只用空闲带宽（S3 实测，见任务 11-01-device-window）；有按键时文件传输再让路一会儿。

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use berth_node::api::{Lane, Push, Request};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use super::Node;

/// 每台设备固定一个本机端口：页面 origin 不变，webview 缓存的外壳下次直接命中。dev 与正式版错开。
const PORT_BASE: u16 = if cfg!(debug_assertions) { 48000 } else { 47000 };
/// 隧道请求的截止时间：断线期间排队，续上后发出；超过视为这条流坏了。
const REQUEST_DEADLINE: Duration = Duration::from_secs(300);
const CHUNK: usize = 16 * 1024;
/// 终端专线上有按键后，文件传输让路这么久（与终端共用上行）。
const TRANSFER_YIELD: Duration = Duration::from_secs(3);

/// 流收到的东西：数据块（偏移、字节）或结束（总字节数）。
enum Piece {
    Data(u64, Vec<u8>),
    Closed(u64),
}

type Sinks = Arc<Mutex<HashMap<u64, UnboundedSender<Piece>>>>;

/// 一台设备的本机端口。新连接走当前节点（`current`）：对方换了 berth 路径、节点会话重建后，
/// 端口不变，后来的连接改走新会话。
struct Proxy {
    port: u16,
    current: Arc<Mutex<(Arc<Node>, Sinks)>>,
}

static PROXIES: LazyLock<Mutex<HashMap<i32, Proxy>>> = LazyLock::new(Mutex::default);
static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);

/// 接上节点的推送：按流分给各连接。每个节点会话只能接一次。
fn attach(node: &Arc<Node>) -> Result<(Arc<Node>, Sinks), String> {
    let pushes = node
        .pushes
        .lock()
        .expect("node pushes lock")
        .take()
        .ok_or("device tunnel already started")?;
    let sinks: Sinks = Arc::default();
    tokio::spawn(route(pushes, sinks.clone()));
    Ok((node.clone(), sinks))
}

/// 确保这台设备的本机端口在监听，并让它走 `node` 这个节点会话；返回端口。
pub(super) async fn port(device: i32, node: &Arc<Node>) -> Result<u16, String> {
    // 两条线同时来要端口：排队，后来的直接拿到先来的结果。
    static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _starting = STARTING.lock().await;
    if let Some(proxy) = PROXIES.lock().expect("proxies lock").get(&device) {
        let mut current = proxy.current.lock().expect("proxy lock");
        if !Arc::ptr_eq(&current.0, node) {
            // 旧会话上的连接一律关掉：前端随即重连，走新会话（否则老连接仍连着旧的对方）。
            current.1.lock().expect("sinks lock").clear();
            *current = attach(node)?;
        }
        return Ok(proxy.port);
    }
    let port = PORT_BASE + device as u16;
    let v4 = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| format!("127.0.0.1:{port}: {error}"))?;
    // 前端连 `localhost`（CSP 只放行它），webview 可能先试 ::1。
    let v6 = TcpListener::bind(("::1", port)).await.ok();
    let current = Arc::new(Mutex::new(attach(node)?));
    for listener in std::iter::once(v4).chain(v6) {
        let current = current.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    continue;
                };
                let _ = socket.set_nodelay(true);
                let (node, sinks) = current.lock().expect("proxy lock").clone();
                tokio::spawn(stream(socket, node, sinks));
            }
        });
    }
    PROXIES
        .lock()
        .expect("proxies lock")
        .insert(device, Proxy { port, current });
    Ok(port)
}

/// 节点推来的字节按流分给各连接。
async fn route(mut pushes: UnboundedReceiver<(Push, Vec<u8>)>, sinks: Sinks) {
    while let Some((push, body)) = pushes.recv().await {
        let (stream, piece) = match push {
            Push::Data { stream, offset } => (stream, Piece::Data(offset, body)),
            Push::Closed { stream, offset } => (stream, Piece::Closed(offset)),
        };
        if let Some(sink) = sinks.lock().expect("sinks lock").get(&stream) {
            let _ = sink.send(piece);
        }
    }
}

/// 发一个隧道请求：调用时即按顺序排进会话；结果不用等（失败由流关闭体现）。
fn fire(node: &Node, request: Request, body: &[u8]) {
    tokio::spawn(node.data.request(&request, body, REQUEST_DEADLINE));
}

/// 一条本机连接 ↔ 一条隧道流。
async fn stream(socket: TcpStream, node: Arc<Node>, sinks: Sinks) {
    let (mut reader, mut writer) = socket.into_split();
    let mut buf = vec![0; CHUNK];
    let n = match reader.read(&mut buf).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };
    // 按请求行分道：终端专线 / 命令线 / 其余（插件页）。
    let head = &buf[..n];
    let lane = if head.starts_with(b"GET /__berth/term") {
        Lane::Interactive
    } else if head.starts_with(b"GET /__berth/ws") {
        Lane::Normal
    } else {
        Lane::Bulk
    };
    let id = NEXT_STREAM.fetch_add(1, Ordering::Relaxed);
    let (sink, mut pieces) = unbounded_channel();
    sinks.lock().expect("sinks lock").insert(id, sink);
    fire(&node, Request::Connect { stream: id, lane }, &[]);

    // 下行：按偏移排序写给本机连接。
    let down = {
        tokio::spawn(async move {
            let (mut next, mut pending, mut end) = (0u64, BTreeMap::new(), None);
            while let Some(piece) = pieces.recv().await {
                match piece {
                    Piece::Data(offset, bytes) => {
                        pending.insert(offset, bytes);
                    }
                    Piece::Closed(total) => end = Some(total),
                }
                while let Some(bytes) = pending.remove(&next) {
                    next += bytes.len() as u64;
                    if writer.write_all(&bytes).await.is_err() {
                        return;
                    }
                }
                if end.is_some_and(|total| next >= total) {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        })
    };

    // 上行：本机连接读到的依次发出。
    let mut offset = 0u64;
    let mut chunk = buf[..n].to_vec();
    loop {
        if lane == Lane::Interactive {
            node.data.yield_until(std::time::Instant::now() + TRANSFER_YIELD);
        }
        fire(
            &node,
            Request::Send {
                stream: id,
                lane,
                offset,
            },
            &chunk,
        );
        offset += chunk.len() as u64;
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => chunk = buf[..n].to_vec(),
        }
    }
    // 浏览器关了连接（不会半关）：节点那边一起关。
    down.abort();
    fire(&node, Request::Shut { stream: id }, &[]);
    sinks.lock().expect("sinks lock").remove(&id);
}
