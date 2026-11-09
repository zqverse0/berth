//! `berth node stdio|serve`：让另一台设备上的 Berth 经 ssh 操作本机。
//!
//! - `stdio`：对方执行 `ssh <本机> berth node stdio`，这里只做中继：stdin/stdout ↔ 本机常驻的 `serve`
//!   （不在就拉起）。ssh 断了只是中继退出。
//! - `serve`：每个数据实例一个，常驻。按会话 id 保留 [`Session`]：字节流断了，会话、终端订阅与排队的
//!   回复都还在，对方换一条连接重新握手就从确认点续上。没有连接的会话 [`LINGER`] 后清理，
//!   没有会话 [`LINGER`] 后退出。
//!
//! 请求直接调与 `berth project / terminal / session / task / knowledge` 相同的领域代码，不经 GUI、
//! 不起 `berth` 子进程。终端输入、尺寸、接入按发出顺序在每会话一个的工作者里执行，其余请求并发。

mod files;
mod tunnel;
mod views;

use std::collections::HashMap;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use berth_node::api::{self, ApiError, Push, Reply, Request};
use berth_node::{Decoder, Event, Frame, Outgoing, Priority, Session, SessionId};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::{CliError, EXIT_DAEMON_UNAVAILABLE, EXIT_TARGET_NOT_FOUND, EXIT_USER_ERROR};

/// 没有连接的会话保留多久；没有会话的服务保留多久。
const LINGER: Duration = Duration::from_secs(600);
/// 新连接必须在这之内发来 Hello。
const HELLO_TIMEOUT: Duration = Duration::from_secs(30);
/// 已握手连接这么久没有收到字节就当断线。
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 写不出去这么久就当连接断了。
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// 请求处理的共用环境。
pub(crate) struct Ctx;

impl Ctx {
    /// 文件访问范围：对方库里全部项目的根目录。
    async fn scope(&self) -> Result<files::Scope, ApiError> {
        let roots: Vec<PathBuf> = views::catalog()
            .await?
            .into_iter()
            .map(|entry| PathBuf::from(entry.path))
            .collect();
        Ok(files::Scope::new(roots))
    }
}

fn api_error(error: CliError) -> ApiError {
    let kind = match error.exit_code {
        EXIT_TARGET_NOT_FOUND => "not_found",
        EXIT_USER_ERROR => "invalid",
        EXIT_DAEMON_UNAVAILABLE | crate::EXIT_GUI_UNAVAILABLE | crate::EXIT_INCOMPATIBLE => {
            "unavailable"
        }
        crate::EXIT_OPERATION_TIMEOUT => "timeout",
        crate::EXIT_REJECTED => "forbidden",
        _ => "internal",
    };
    ApiError::new(kind, error.message)
}

fn internal(error: impl ToString) -> ApiError {
    ApiError::new("internal", error.to_string())
}

/// 节点服务的 socket：按数据目录区分实例（正式版与 dev 各一个）。
fn socket_path() -> io::Result<PathBuf> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("berth-node-{}", rustix::process::getuid().as_raw()));
    std::fs::create_dir_all(&dir)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let data = data_dir();
    let digest = Sha256::digest(data.as_os_str().as_encoded_bytes());
    let name: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    Ok(dir.join(format!("{name}.sock")))
}

/// 本实例的数据目录（与 GUI 同一解析）。
pub(crate) fn data_dir() -> PathBuf {
    std::env::var_os("BERTH_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
        berth_project_core::instance::default_data_dir(crate::project::build_instance())
    })
}

fn runtime() -> Result<tokio::runtime::Runtime, CliError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)
}

// ─── stdio：中继 ──────────────────────────────────────────────────────

/// `berth node stdio`
pub(crate) fn stdio() -> Result<(), CliError> {
    let path = socket_path().map_err(CliError::from_runtime)?;
    runtime()?.block_on(async {
        let stream = connect_or_spawn(&path).await.map_err(CliError::from_runtime)?;
        let (mut from_node, mut to_node) = stream.into_split();
        let up = async {
            let _ = pipe(&mut tokio::io::stdin(), &mut to_node).await;
            let _ = to_node.shutdown().await;
        };
        let mut stdout = tokio::io::stdout();
        let down = pipe(&mut from_node, &mut stdout);
        tokio::select! {
            _ = up => {}
            _ = down => {}
        }
        Ok::<_, CliError>(())
    })?;
    // 阻塞在读 stdin 的线程不会自己结束：直接退出，不等它。
    std::process::exit(0)
}

/// 逐块转发并立即 flush（交互字节不能攒在缓冲里）。
async fn pipe(
    from: &mut (impl tokio::io::AsyncRead + Unpin),
    to: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> io::Result<()> {
    let mut buf = vec![0; 64 * 1024];
    loop {
        let n = from.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        to.write_all(&buf[..n]).await?;
        to.flush().await?;
    }
}

async fn connect_or_spawn(path: &Path) -> io::Result<UnixStream> {
    if let Ok(stream) = UnixStream::connect(path).await {
        return Ok(stream);
    }
    use std::os::unix::process::CommandExt;
    // 独立进程组：ssh 会话结束时不随之收到信号。
    std::process::Command::new(std::env::current_exe()?)
        .args(["node", "serve"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match UnixStream::connect(path).await {
            Ok(stream) => return Ok(stream),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

// ─── serve：常驻服务 ──────────────────────────────────────────────────

/// `berth node serve`
pub(crate) fn serve() -> Result<(), CliError> {
    let path = socket_path().map_err(CliError::from_runtime)?;
    let executable = std::env::current_exe().ok().and_then(|path| Executable::new(path).ok());
    runtime()?
        .block_on(serve_at(&path, Ctx, LINGER, executable))
        .map_err(CliError::from_runtime)
}

struct Executable {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Executable {
    fn new(path: PathBuf) -> io::Result<Self> {
        let metadata = std::fs::metadata(&path)?;
        Ok(Self { path, device: metadata.dev(), inode: metadata.ino() })
    }

    fn replaced(&self) -> bool {
        std::fs::metadata(&self.path)
            .is_ok_and(|metadata| (metadata.dev(), metadata.ino()) != (self.device, self.inode))
    }
}

/// 已有服务在跑时直接返回；残留的 socket 文件先删掉。
fn bind(path: &Path) -> io::Result<Option<UnixListener>> {
    match UnixListener::bind(path) {
        Ok(listener) => Ok(Some(listener)),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            if std::os::unix::net::UnixStream::connect(path).is_ok() {
                return Ok(None);
            }
            std::fs::remove_file(path)?;
            UnixListener::bind(path).map(Some)
        }
        Err(error) => Err(error),
    }
}

async fn serve_at(path: &Path, ctx: Ctx, linger: Duration, executable: Option<Executable>) -> io::Result<()> {
    let Some(listener) = bind(path)? else {
        return Ok(());
    };
    let hub = Arc::new(Hub {
        sessions: Mutex::new(HashMap::new()),
        epoch: AtomicU64::new(0),
        ctx: Arc::new(ctx),
        linger,
    });
    let mut idle_since = Some(Instant::now());
    let socket = std::fs::metadata(path)?;
    let mut check = tokio::time::interval(Duration::from_secs(5).min(linger));
    check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let check_executable = tokio::select! {
            accepted = listener.accept() => {
                if let Ok((stream, _)) = accepted {
                    tokio::spawn(connection(hub.clone(), stream));
                }
                false
            }
            _ = check.tick() => true,
        };
        if check_executable && executable.as_ref().is_some_and(Executable::replaced) {
            remove_socket(path, &socket);
            return Ok(());
        }
        if hub.sessions.lock().expect("hub lock").is_empty() {
            let since = *idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= linger {
                remove_socket(path, &socket);
                return Ok(());
            }
        } else {
            idle_since = None;
        }
    }
}

fn remove_socket(path: &Path, original: &std::fs::Metadata) {
    if std::fs::metadata(path).is_ok_and(|current| {
        (current.dev(), current.ino()) == (original.dev(), original.ino())
    }) {
        let _ = std::fs::remove_file(path);
    }
}

struct Hub {
    sessions: Mutex<HashMap<SessionId, UnboundedSender<Cmd>>>,
    epoch: AtomicU64,
    ctx: Arc<Ctx>,
    linger: Duration,
}

impl Hub {
    fn route(self: &Arc<Self>, id: SessionId) -> UnboundedSender<Cmd> {
        let mut sessions = self.sessions.lock().expect("hub lock");
        if let Some(tx) = sessions.get(&id).filter(|tx| !tx.is_closed()) {
            return tx.clone();
        }
        let (tx, rx) = unbounded_channel();
        sessions.insert(id, tx.clone());
        let actor = Actor::new(self.ctx.clone(), tx.clone(), rx, self.linger);
        let hub = self.clone();
        tokio::spawn(async move {
            actor.run().await;
            hub.sessions.lock().expect("hub lock").remove(&id);
        });
        tx
    }
}

async fn read_frame(
    reader: &mut OwnedReadHalf,
    decoder: &mut Decoder,
    buf: &mut [u8],
) -> io::Result<Frame> {
    loop {
        match decoder.next_frame() {
            Ok(Some(frame)) => return Ok(frame),
            Ok(None) => {}
            Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        }
        let n = tokio::time::timeout(READ_TIMEOUT, reader.read(buf))
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        decoder.push(&buf[..n]);
    }
}

/// 一条字节流：读到 Hello 后交给对应会话，之后把收到的帧转过去。
async fn connection(hub: Arc<Hub>, stream: UnixStream) {
    let (mut reader, writer) = stream.into_split();
    let mut decoder = Decoder::synced();
    let mut buf = vec![0; 64 * 1024];
    let hello = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut reader, &mut decoder, &mut buf)).await;
    let Ok(Ok(hello @ Frame::Hello { .. })) = hello else {
        return;
    };
    let Frame::Hello { session, .. } = &hello else {
        unreachable!("matched above")
    };
    let epoch = hub.epoch.fetch_add(1, Ordering::Relaxed);
    let tx = hub.route(*session);
    if tx.send(Cmd::Transport { epoch, writer, hello }).is_err() {
        return;
    }
    loop {
        let message = match read_frame(&mut reader, &mut decoder, &mut buf).await {
            Ok(frame) => Cmd::Frame { epoch, frame },
            Err(_) => Cmd::Lost { epoch },
        };
        let lost = matches!(message, Cmd::Lost { .. });
        if tx.send(message).is_err() || lost {
            return;
        }
    }
}

/// 会话收到的输入。
pub(crate) enum Cmd {
    /// 新字节流。
    Transport {
        epoch: u64,
        writer: OwnedWriteHalf,
        hello: Frame,
    },
    /// 字节流上的一帧。
    Frame { epoch: u64, frame: Frame },
    /// 字节流断了。
    Lost { epoch: u64 },
    /// 请求处理完。
    Reply { id: u64, priority: Priority, payload: Vec<u8> },
    /// 推送给客户端。
    Push(Push, Vec<u8>),
}

/// 一个会话：持有 [`Session`] 与当前字节流，派发请求、写出帧。
struct Actor {
    ctx: Arc<Ctx>,
    session: Session,
    writer: Option<(u64, OwnedWriteHalf)>,
    tx: UnboundedSender<Cmd>,
    rx: UnboundedReceiver<Cmd>,
    tasks: HashMap<u64, AbortHandle>,
    next_push: u64,
    tunnels: tunnel::Tunnels,
    idle_since: Option<Instant>,
    linger: Duration,
}

impl Actor {
    fn new(ctx: Arc<Ctx>, tx: UnboundedSender<Cmd>, rx: UnboundedReceiver<Cmd>, linger: Duration) -> Self {
        Self {
            ctx,
            session: Session::server(),
            writer: None,
            tx,
            rx,
            tasks: HashMap::new(),
            next_push: 1,
            tunnels: tunnel::Tunnels::default(),
            idle_since: Some(Instant::now()),
            linger,
        }
    }

    async fn run(mut self) {
        loop {
            self.flush().await;
            let session = &self.session;
            self.tunnels.backlog(|priority| session.queued_bytes(priority));
            if self.drain_events() {
                continue;
            }
            let wake = self.session.next_timeout().map(Instant::from_std);
            let expire = self.idle_since.map(|since| since + self.linger);
            tokio::select! {
                cmd = self.rx.recv() => match cmd {
                    Some(cmd) => self.on_cmd(cmd),
                    None => break,
                },
                _ = sleep_until(wake) => self.session.handle_timeout(std::time::Instant::now()),
                _ = sleep_until(expire) => break,
            }
        }
        for task in self.tasks.values() {
            task.abort();
        }
    }

    fn lost(&mut self) {
        self.writer = None;
        self.session.disconnected();
        self.idle_since = Some(Instant::now());
    }

    async fn flush(&mut self) {
        let now = std::time::Instant::now();
        while let Some(bytes) = self.session.poll_transmit(now) {
            let Some((_, writer)) = self.writer.as_mut() else {
                return;
            };
            let written = tokio::time::timeout(WRITE_TIMEOUT, writer.write_all(&bytes)).await;
            if !matches!(written, Ok(Ok(()))) {
                self.lost();
                return;
            }
        }    }

    /// 处理会话事件；返回是否有事件（可能产生了要写出的帧）。
    fn drain_events(&mut self) -> bool {
        let mut any = false;
        while let Some(event) = self.session.poll_event() {
            any = true;
            match event {
                Event::Message(message) if !message.reply => self.dispatch(message.id, &message.payload),
                Event::Cancelled { id, reply: false } => {
                    if let Some(task) = self.tasks.remove(&id) {
                        task.abort();
                    }
                }
                _ => {}
            }
        }
        any
    }

    fn reply(&mut self, id: u64, priority: Priority, result: Result<(Value, Vec<u8>), ApiError>) {
        let payload = match result {
            Ok((value, body)) => api::encode(&Reply::Ok(value), &body),
            Err(error) => api::encode(&Reply::Err(error), &[]),
        };
        self.session.send(Outgoing::reply(id, priority, payload));
    }

    fn dispatch(&mut self, id: u64, payload: &[u8]) {
        let (request, body) = match api::decode::<Request>(payload) {
            Ok(decoded) => decoded,
            Err(error) => return self.reply(id, Priority::Normal, Err(error)),
        };
        let body = body.to_vec();
        if request.tunnel() {
            let priority = request.priority();
            match request {
                Request::Connect { stream, lane } => self.tunnels.connect(stream, lane, self.tx.clone()),
                Request::Send { stream, offset, .. } => self.tunnels.send(stream, offset, body),
                Request::Shut { stream } => self.tunnels.shut(stream),
                _ => {}
            }
            return self.reply(id, priority, Ok((Value::Null, Vec::new())));
        }
        let (ctx, tx) = (self.ctx.clone(), self.tx.clone());
        let priority = request.priority();
        let task = tokio::spawn(async move {
            let payload = match handle(&ctx, request, body).await {
                Ok((value, body)) => api::encode(&Reply::Ok(value), &body),
                Err(error) => api::encode(&Reply::Err(error), &[]),
            };
            let _ = tx.send(Cmd::Reply { id, priority, payload });
        });
        self.tasks.insert(id, task.abort_handle());
    }

    fn on_cmd(&mut self, cmd: Cmd) {
        let now = std::time::Instant::now();
        let current = |epoch: u64, writer: &Option<(u64, OwnedWriteHalf)>| {
            writer.as_ref().is_some_and(|(e, _)| *e == epoch)
        };
        match cmd {
            Cmd::Transport { epoch, writer, hello } => {
                // 旧字节流（若还在）随之关闭。
                self.writer = Some((epoch, writer));
                self.idle_since = None;
                if self.session.handle(now, hello).is_err() {
                    // 版本不一致：Reject 已排队，写出后断开。
                    let (tx, epoch) = (self.tx.clone(), epoch);
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        let _ = tx.send(Cmd::Lost { epoch });
                    });
                }
            }
            Cmd::Frame { epoch, frame } if current(epoch, &self.writer) => {
                if self.session.handle(now, frame).is_err() {
                    self.lost();
                }
            }
            Cmd::Lost { epoch } if current(epoch, &self.writer) => self.lost(),
            Cmd::Frame { .. } | Cmd::Lost { .. } => {}
            Cmd::Reply { id, priority, payload } => {
                self.tasks.remove(&id);
                self.session.send(Outgoing::reply(id, priority, payload));
            }
            Cmd::Push(event, body) => self.push(event, body),
        }
    }

    fn push(&mut self, event: Push, body: Vec<u8>) {
        let priority = match &event {
            Push::Data { stream, .. } | Push::Closed { stream, .. } => self.tunnels.lane(*stream).into(),
        };
        let id = self.next_push;
        self.next_push += 1;
        let payload = api::encode(&event, &body);
        self.session.send(Outgoing::request(id, priority, payload));
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work).await.map_err(internal)?
}

fn value(result: Result<impl serde::Serialize, ApiError>) -> Result<(Value, Vec<u8>), ApiError> {
    Ok((serde_json::to_value(result?).map_err(internal)?, Vec::new()))
}

/// 请求（隧道之外）。
async fn handle(ctx: &Ctx, request: Request, body: Vec<u8>) -> Result<(Value, Vec<u8>), ApiError> {
    match request {
        Request::Device => value(views::device().await),
        Request::ProjectAdd { path } => value(blocking(move || views::project_add(&path)).await),
        Request::Dirs { path } => value(blocking(move || views::dirs(path.as_deref())).await),
        request => {
            let scope = ctx.scope().await?;
            blocking(move || file_request(&scope, request, &body)).await
        }
    }
}

fn file_request(scope: &files::Scope, request: Request, body: &[u8]) -> Result<(Value, Vec<u8>), ApiError> {
    match request {
        Request::PutBegin { path, size, sha256 } => {
            value(files::put_begin(scope, &path, size, &sha256).map(|offset| json!({ "offset": offset })))
        }
        Request::PutChunk {
            path,
            sha256,
            offset,
        } => {
            if body.len() > api::MAX_PUT_CHUNK {
                return Err(ApiError::new("invalid", "chunk too large"));
            }
            value(files::put_chunk(scope, &path, &sha256, offset, body).map(|offset| json!({ "offset": offset })))
        }
        Request::PutFinish { path, sha256 } => value(files::put_finish(scope, &path, &sha256)),
        Request::GetBegin { path } => value(files::get_begin(scope, &path)),
        Request::GetChunk { path, offset, len } => {
            let len = len.min(api::MAX_PUT_CHUNK as u64);
            Ok((Value::Null, files::get_chunk(scope, &path, offset, len)?))
        }
        other => Err(ApiError::new("invalid", format!("unexpected request {other:?}"))),
    }
}

#[cfg(test)]
mod tests;
