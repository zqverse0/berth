//! 客户端连接：建字节流（第一版是 ssh 子进程）、心跳判活、断线退避重连并从确认点续传。
//!
//! [`Client`] 是一条节点连接的句柄：一个后台任务持有 [`Session`] 与当前字节流，请求经通道交给它。
//! 字节流断了会话不丢：排队与未确认的消息在重连后续上，调用方只看到 [`Status`] 的变化。

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use crate::api::{self, ApiError, Push, Reply, Request};
use crate::{Decoder, Event, Outgoing, Session, SessionId};

/// 发心跳的间隔。
const PING_EVERY: Duration = Duration::from_secs(5);
/// 这么久没收到任何帧就当字节流断了（保证 15 秒内发现断线）。
const DEAD_AFTER: Duration = Duration::from_secs(12);
/// 建一条字节流（含 ssh 登录）的上限。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 写不出去这么久就当字节流断了。
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);
/// 重连退避：1、2、4 … 秒，封顶。
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// 一条字节流。
pub struct Link {
    /// 读端。
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    /// 写端。
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// 字节流断开时说明原因用（如 ssh 的最后一行 stderr）。
    pub reason: Option<Arc<Mutex<String>>>,
    /// 随字节流一起释放的资源（如 ssh 子进程，释放即结束）。
    pub guard: Option<Box<dyn Send>>,
}

/// 建字节流的函数：每次重连调用一次。
pub type Connector =
    Box<dyn FnMut() -> Pin<Box<dyn Future<Output = io::Result<Link>> + Send>> + Send>;

/// 连接状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    /// 正在建字节流或握手；`attempt > 0` 即重连中。
    Connecting {
        /// 连续失败次数。
        attempt: u32,
    },
    /// 在线。
    Online,
    /// 断开，`retry_in_ms` 后自动重连（[`Client::retry`] 立即重连）。
    Offline {
        /// 原因。
        error: String,
        /// 连续失败次数。
        attempt: u32,
        /// 距下次重连的毫秒数。
        retry_in_ms: u64,
    },
    /// 不会自动重连（对方拒绝，如协议版本不一致）；[`Client::retry`] 再试。
    Failed {
        /// 原因。
        error: String,
    },
}

/// 一个请求的回复去处。
type ReplyTx = oneshot::Sender<Result<(Value, Vec<u8>), ApiError>>;

enum Cmd {
    Request {
        id: u64,
        outgoing: Outgoing,
        reply: ReplyTx,
    },
    Cancel(u64),
    Retry,
    Yield(Instant),
}

/// 一条节点连接。drop 后后台任务结束、字节流关闭。
pub struct Client {
    tx: UnboundedSender<Cmd>,
    status: watch::Receiver<Status>,
    next_id: AtomicU64,
}

impl Client {
    /// 开始连接；返回句柄与对方推送（隧道字节）的接收端。
    pub fn start(connector: Connector) -> (Self, UnboundedReceiver<(Push, Vec<u8>)>) {
        let (tx, rx) = unbounded_channel();
        let (pushes, pushes_rx) = unbounded_channel();
        let (status_tx, status) = watch::channel(Status::Connecting { attempt: 0 });
        let mut id = [0u8; 16];
        id[..8].copy_from_slice(&random_u64().to_le_bytes());
        id[8..].copy_from_slice(&random_u64().to_le_bytes());
        let actor = Actor {
            session: Session::client(SessionId(id)),
            rx,
            pending: HashMap::new(),
            pushes,
            status: status_tx,
            connector,
            attempt: 0,
        };
        tokio::spawn(actor.run());
        let client = Self {
            tx,
            status,
            next_id: AtomicU64::new(1),
        };
        (client, pushes_rx)
    }

    /// 当前状态与变化通知。
    pub fn status(&self) -> watch::Receiver<Status> {
        self.status.clone()
    }

    /// 立即重连（跳过退避；`Failed` 后也会再试）。
    pub fn retry(&self) {
        let _ = self.tx.send(Cmd::Retry);
    }

    /// 有终端交互（按键）：到 `until` 之前这条连接的非交互流量半速、不探测，给它让路。
    pub fn yield_until(&self, until: std::time::Instant) {
        let _ = self.tx.send(Cmd::Yield(until.into()));
    }

    /// 发一个请求，`timeout` 内没有回复返回 `timeout` 错误；断线期间请求排队，续上后发出。
    /// 调用时即排进会话（多次调用按调用顺序发出），返回的 future 被 drop 即撤销请求。
    pub fn request(
        &self,
        request: &Request,
        body: &[u8],
        timeout: Duration,
    ) -> impl Future<Output = Result<(Value, Vec<u8>), ApiError>> + Send + 'static {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let deadline = (Instant::now() + timeout).into_std();
        let outgoing = Outgoing::request(id, request.priority(), api::encode(request, body))
            .deadline(deadline);
        let (reply, answer) = oneshot::channel();
        let sent = self.tx.send(Cmd::Request {
            id,
            outgoing,
            reply,
        });
        let guard = CancelOnDrop {
            tx: self.tx.clone(),
            id: sent.is_ok().then_some(id),
        };
        async move {
            // 整个守卫移进 future（只捕获字段会让它在这里就被 drop）。
            let mut guard = guard;
            let result = answer
                .await
                .unwrap_or_else(|_| Err(ApiError::new("closed", "node connection closed")));
            guard.id = None;
            result
        }
    }
}

struct CancelOnDrop {
    tx: UnboundedSender<Cmd>,
    id: Option<u64>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            let _ = self.tx.send(Cmd::Cancel(id));
        }
    }
}

/// 字节流结束的原因。
enum End {
    /// 断了，退避后重连。
    Lost(String),
    /// 对方拒绝，不自动重连。
    Rejected(String),
    /// 句柄已 drop。
    Closed,
}

struct Actor {
    session: Session,
    rx: UnboundedReceiver<Cmd>,
    pending: HashMap<u64, ReplyTx>,
    pushes: UnboundedSender<(Push, Vec<u8>)>,
    status: watch::Sender<Status>,
    connector: Connector,
    attempt: u32,
}

fn now() -> std::time::Instant {
    Instant::now().into_std()
}

async fn sleep_until(at: Option<std::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(Instant::from_std(at)).await,
        None => std::future::pending().await,
    }
}

impl Actor {
    async fn run(mut self) {
        loop {
            let _ = self.status.send(Status::Connecting {
                attempt: self.attempt,
            });
            let wait = match self.connect().await {
                End::Closed => return,
                End::Lost(error) => {
                    self.attempt += 1;
                    let delay = backoff(self.attempt);
                    let _ = self.status.send(Status::Offline {
                        error,
                        attempt: self.attempt,
                        retry_in_ms: delay.as_millis() as u64,
                    });
                    Some(delay)
                }
                End::Rejected(error) => {
                    let _ = self.status.send(Status::Failed { error });
                    None
                }
            };
            if !self.idle(wait).await {
                return;
            }
        }
    }

    /// 没有字节流时：照常收请求、处理截止时间，等到重连时刻或 [`Cmd::Retry`]。返回 false 表示句柄已 drop。
    async fn idle(&mut self, wait: Option<Duration>) -> bool {
        let until = wait.map(|delay| now() + delay);
        loop {
            tokio::select! {
                cmd = self.rx.recv() => match cmd {
                    None => return false,
                    Some(Cmd::Retry) => return true,
                    Some(cmd) => self.on_cmd(cmd),
                },
                _ = sleep_until(self.session.next_timeout()) => self.on_timeout(),
                _ = sleep_until(until) => return true,
            }
        }
    }

    async fn connect(&mut self) -> End {
        let connecting = tokio::time::timeout(CONNECT_TIMEOUT, (self.connector)());
        tokio::pin!(connecting);
        let link = loop {
            tokio::select! {
                link = &mut connecting => break link,
                cmd = self.rx.recv() => match cmd {
                    None => return End::Closed,
                    Some(cmd) => self.on_cmd(cmd),
                },
                _ = sleep_until(self.session.next_timeout()) => self.on_timeout(),
            }
        };
        match link {
            Ok(Ok(link)) => self.serve(link).await,
            Ok(Err(error)) => End::Lost(error.to_string()),
            Err(_) => End::Lost("connection timed out".into()),
        }
    }

    async fn serve(&mut self, link: Link) -> End {
        let Link {
            mut reader,
            mut writer,
            reason,
            guard: _guard,
        } = link;
        let lost = |fallback: &str| {
            let reason = reason
                .as_ref()
                .map(|reason| reason.lock().expect("reason lock").clone())
                .filter(|reason| !reason.is_empty());
            End::Lost(reason.unwrap_or_else(|| fallback.to_owned()))
        };
        self.session.connect();
        let mut decoder = Decoder::awaiting_handshake();
        let mut buf = vec![0; 64 * 1024];
        let started = now();
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let end = loop {
            if let Some(end) = self.flush(&mut writer).await {
                break end;
            }
            if self.drain_events() {
                continue;
            }
            tokio::select! {
                read = reader.read(&mut buf) => match read {
                    Ok(0) => break lost("connection closed"),
                    Ok(n) => {
                        decoder.push(&buf[..n]);
                        if let Some(end) = self.on_frames(&mut decoder) {
                            break end;
                        }
                    }
                    Err(error) => break lost(&error.to_string()),
                },
                cmd = self.rx.recv() => match cmd {
                    None => break End::Closed,
                    Some(Cmd::Retry) => {}
                    Some(cmd) => self.on_cmd(cmd),
                },
                _ = sleep_until(self.session.next_timeout()) => self.on_timeout(),
                _ = ping.tick() => {
                    let heard = self.session.last_heard().unwrap_or(started).max(started);
                    if now().duration_since(heard) > DEAD_AFTER {
                        break End::Lost("no response from node".into());
                    }
                    self.session.ping(random_u64());
                }
            }
        };
        self.session.disconnected();
        end
    }

    fn on_frames(&mut self, decoder: &mut Decoder) -> Option<End> {
        loop {
            let frame = match decoder.next_frame() {
                Ok(Some(frame)) => frame,
                Ok(None) => return None,
                Err(error) => return Some(End::Lost(error.to_string())),
            };
            match self.session.handle(now(), frame) {
                Ok(()) => {}
                Err(
                    error @ (crate::ProtoError::Rejected(_) | crate::ProtoError::Version { .. }),
                ) => return Some(End::Rejected(error.to_string())),
                Err(error) => return Some(End::Lost(error.to_string())),
            }
        }
    }

    /// 写出所有可发的帧；写失败返回断线。
    async fn flush(&mut self, writer: &mut (dyn AsyncWrite + Send + Unpin)) -> Option<End> {
        let mut wrote = false;
        while let Some(bytes) = self.session.poll_transmit(now()) {
            wrote = true;
            match tokio::time::timeout(WRITE_TIMEOUT, writer.write_all(&bytes)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Some(End::Lost(error.to_string())),
                Err(_) => return Some(End::Lost("write timed out".into())),
            }
        }
        if wrote {
            if let Err(error) = writer.flush().await {
                return Some(End::Lost(error.to_string()));
            }
        }
        None
    }

    /// 处理会话事件；返回是否有事件。
    fn drain_events(&mut self) -> bool {
        let mut any = false;
        while let Some(event) = self.session.poll_event() {
            any = true;
            match event {
                Event::Connected { .. } => {
                    self.attempt = 0;
                    let _ = self.status.send(Status::Online);
                }
                Event::Message(message) if message.reply => {
                    if let Some(reply) = self.pending.remove(&message.id) {
                        let result =
                            api::decode::<Reply>(&message.payload).and_then(|(reply, body)| {
                                match reply {
                                    Reply::Ok(value) => Ok((value, body.to_vec())),
                                    Reply::Err(error) => Err(error),
                                }
                            });
                        let _ = reply.send(result);
                    }
                }
                Event::Message(message) => {
                    if let Ok((push, body)) = api::decode::<Push>(&message.payload) {
                        let _ = self.pushes.send((push, body.to_vec()));
                    }
                }
                Event::TimedOut(id) => {
                    if let Some(reply) = self.pending.remove(&id) {
                        let _ = reply
                            .send(Err(ApiError::new("timeout", "node did not answer in time")));
                    }
                }
                Event::Cancelled { .. } => {}
            }
        }
        any
    }

    fn on_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Request {
                id,
                outgoing,
                reply,
            } => {
                self.pending.insert(id, reply);
                self.session.send(outgoing);
            }
            Cmd::Cancel(id) => {
                if self.pending.remove(&id).is_some() {
                    self.session.cancel(id);
                }
            }
            Cmd::Retry => {}
            Cmd::Yield(until) => self.session.set_yield_until(until.into_std()),
        }
    }

    fn on_timeout(&mut self) {
        self.session.handle_timeout(now());
        self.drain_events();
    }
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1 << attempt.saturating_sub(1).min(5)).min(BACKOFF_MAX)
}

/// 不引入随机数依赖：用标准库每次新建的随机哈希种子。
fn random_u64() -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(std::time::SystemTime::now())
}

/// POSIX shell 单引号转义。
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 对方 berth 可能在的位置：非交互 ssh 的 PATH 里通常没有它。按顺序取第一个可执行的。
const BERTH_CANDIDATES: &[&str] = &[
    "$HOME/.local/bin/berth",
    "/Applications/berth.app/Contents/MacOS/berth-cli",
    "/Applications/Berth.app/Contents/MacOS/berth-cli",
    "/usr/bin/berth-cli",
];

/// 探测对方 berth 路径的远端命令：找到则打印路径并以 0 退出，找不到以 1 退出。
/// 上次记下的路径（`preferred`）仍可执行就沿用：对方装了多个 Berth 时不在它们之间来回换。
/// 包一层 `sh -c`，登录 shell 是 fish / zsh 也照样跑。
pub fn probe_command(preferred: Option<&str>) -> String {
    let candidates = preferred
        .map(sh_quote)
        .into_iter()
        .chain(BERTH_CANDIDATES.iter().map(|path| format!("\"{path}\"")))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "for b in {candidates} \"$(command -v berth)\"; do [ -n \"$b\" ] && [ -x \"$b\" ] && {{ printf '%s\\n' \"$b\"; exit 0; }}; done; exit 1"
    );
    format!("sh -c {}", sh_quote(&script))
}

/// 在对方机器上起节点的远端命令。
pub fn node_command(berth: &str) -> String {
    format!("{} node stdio", sh_quote(berth))
}

/// ssh 子进程作字节流：`ssh -T <目标> <命令>` 的 stdin/stdout。不弹密码，stderr 最后一行作断线原因。
pub fn ssh(target: String, command: String) -> Connector {
    Box::new(move || {
        let (target, command) = (target.clone(), command.clone());
        Box::pin(async move {
            let mut child = tokio::process::Command::new("ssh")
                .args([
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=15",
                    // 心跳由协议层做；关掉 ssh 自己的，免得两套判活互相干扰。
                    "-o",
                    "ServerAliveInterval=0",
                    "--",
                    &target,
                    &command,
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()?;
            let reader = child.stdout.take().expect("piped stdout");
            let writer = child.stdin.take().expect("piped stdin");
            let stderr = child.stderr.take().expect("piped stderr");
            let reason = Arc::new(Mutex::new(String::new()));
            let last = reason.clone();
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let line = line.trim();
                    if !line.is_empty() {
                        *last.lock().expect("reason lock") = line.to_owned();
                    }
                }
            });
            Ok(Link {
                reader: Box::new(reader),
                writer: Box::new(writer),
                reason: Some(reason),
                guard: Some(Box::new(child)),
            })
        })
    })
}

#[cfg(test)]
mod tests;
