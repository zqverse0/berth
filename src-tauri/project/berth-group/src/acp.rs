//! 群成员的 ACP 进程（任务 11-16-acp-group）：群组运行时（`berth group watch`）用官方 crate
//! `agent-client-protocol` 起插件给的适配器，发消息、收流式回答，答完写回群账本。
//!
//! - ACP 成员在账本里是 `joined`，`target_ref` 为 `acp:<成员>`，不占终端；
//! - 每个成员一个线程 + 一个适配器进程（独立进程组，crate 负责整组回收）；
//! - 会话 id 在第一次发出 prompt 时才记下：从没发过 prompt 的会话不恢复；
//! - 恢复优先 `session/resume`，否则 `session/load`（重放的 update 丢弃，不入账）；只有 -32002 才新建并在群里写明；
//! - 审批：`session/request_permission` 写成账本里的 `permission` 事件，等 `permission_reply`（不超时，规则 Q-3）。

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    CancelNotification, ContentBlock, InitializeRequest, LoadSessionRequest, NewSessionRequest,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate,
    StopReason, TextContent,
};
use agent_client_protocol::v1::ConnectionTo;
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, Client, ErrorCode};
use berth_project_core::tasks::group::{self, Member};
use futures::channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures::{FutureExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::watch::{member_state, save_state, MemberState};
use crate::{deliver, text, Ctx};

/// ACP 成员的 `target_ref` 前缀。
pub(crate) const PREFIX: &str = "acp:";

pub fn is_acp(target_ref: &str) -> bool {
    target_ref.starts_with(PREFIX)
}

/// 插件 `acp(ctx)` 返回的启动规格（`berth tools launch <launch.js> --acp`）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub session_meta: Option<Map<String, Value>>,
    /// 插件的临时目录：适配器退出后删除。
    #[serde(default)]
    pub tmp: Option<PathBuf>,
}

/// 一个 ACP 成员：名字、所用插件、工作目录，入群时在启动栏选的值（含专家）与服务商。
#[derive(Debug, Clone)]
pub struct Joined {
    pub name: String,
    pub agent: String,
    pub cwd: PathBuf,
    /// 原样交给插件 `acp(ctx)` 的 `ctx.inputs`。
    pub inputs: Value,
    /// 服务商档案 id 与模型：群记录只存 id，Key 由 CLI 在每次启动时写成一次性启动档案。
    pub provider: Option<(i64, Option<String>)>,
}

/// `berth tools launch` 的参数（脚本之后）。
fn launch_args(member: &Joined) -> Vec<String> {
    let inputs = if member.inputs.is_object() { member.inputs.clone() } else { json!({}) };
    let mut args = vec!["--acp".to_owned(), "--berth-launch-inputs".to_owned(), inputs.to_string()];
    if let Some((id, model)) = &member.provider {
        args.extend(["--berth-provider-id".to_owned(), id.to_string()]);
        if let Some(model) = model {
            args.extend(["--berth-provider-model".to_owned(), model.clone()]);
        }
    }
    args
}

/// 求成员的启动规格；测试注入假 Agent。
pub type Launcher = Box<dyn Fn(&Ctx, &Joined) -> Result<Spec, String>>;

/// 经 berth CLI 运行插件的 `acp(ctx)`。
pub fn cli_launcher() -> Launcher {
    Box::new(|ctx, member| {
        let script = berth_tool_core::paths::tools_root().join(&member.agent).join("launch.js");
        let output = Command::new(&ctx.cli)
            .args(["tools", "launch"])
            .arg(&script)
            .args(launch_args(member))
            .current_dir(&member.cwd)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("{}: {error}", ctx.cli.display()))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(stderr.trim().to_owned());
        }
        let last = stdout.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or_default();
        serde_json::from_str(last).map_err(|error| format!("acp spec: {error}"))
    })
}

enum Cmd {
    Prompt { seq: u64, from: String, text: String },
    Cancel,
    Answer { request: u64, option: Option<String> },
}

struct Worker {
    tx: UnboundedSender<Cmd>,
    busy: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

/// 运行时里全部 ACP 成员。
pub struct Acp {
    launcher: Launcher,
    workers: HashMap<String, Worker>,
    /// 已转交的审批应答、已执行的停止 / 新会话（账本 seq）。
    answered: HashSet<u64>,
    /// 运行时启动时账本已到哪条：之前的停止 / 新会话已经过时，不再执行。
    since: Option<u64>,
}

impl Acp {
    pub fn new(launcher: Launcher) -> Self {
        Self { launcher, workers: HashMap::new(), answered: HashSet::new(), since: None }
    }

    /// 有成员正在一轮里（或刚收到还没处理完的消息）。
    pub fn busy(&self) -> bool {
        self.workers.values().any(|worker| worker.busy.load(Ordering::SeqCst))
    }

    /// 取消成员当前这一轮。
    pub fn cancel(&self, member: &str) {
        if let Some(worker) = self.workers.get(member) {
            let _ = worker.tx.unbounded_send(Cmd::Cancel);
        }
    }

    /// 一轮：结束了的线程收掉；给 ACP 成员发它还没收到的消息；转交审批应答。返回是否有成员在忙。
    pub fn tick(&mut self, ctx: &Ctx, events: &[Value]) -> bool {
        self.workers.retain(|_, worker| !worker.handle.as_ref().is_some_and(JoinHandle::is_finished));
        if self.since.is_none() {
            self.since = Some(events.last().map_or(0, group::seq));
            recover_interrupted(&ctx.main);
        }
        let since = self.since.unwrap_or_default();
        let present = group::members(events);
        // 移出群的：断开连接即停掉进程（crate 杀整个进程组），正在答的那轮标为中断。
        self.workers.retain(|name, _| present.iter().any(|member| &member.name == name));
        let settings = group::settings(&ctx.main, group::MAIN_GROUP).ok();
        for event in events.iter().filter(|event| group::seq(event) > since) {
            let action = text(event, "event");
            if !matches!(action, Some("acp_stop" | "acp_new" | "acp_handoff")) || !self.answered.insert(group::seq(event)) {
                continue;
            }
            let Some(member) = text(event, "to") else { continue };
            if action == Some("acp_stop") {
                self.cancel(member);
            } else {
                // 新会话：停掉进程，下一条消息起新进程时没有可恢复的会话（`control` 已清掉）。
                // 交给终端：停掉进程，会话由终端打开；交回后下一条消息起新进程 load 同一会话。
                self.workers.remove(member);
            }
        }
        for member in present {
            let Some(body) = member.bodies.iter().find(|body| is_acp(&body.target_ref)) else {
                continue;
            };
            // 会话在终端里：消息留着，交回后再投。
            if handed(events, &member.name).is_some() {
                continue;
            }
            let (mut since, pending) = deliver::pending(&ctx.main, group::MAIN_GROUP, events, &member);
            let Some(last) = pending.last().map(|event| group::seq(event)) else {
                continue;
            };
            let Some(joined) = joined(events, &member) else {
                continue;
            };
            if !self.workers.contains_key(&member.name) {
                match (self.launcher)(ctx, &joined) {
                    Ok(spec) => {
                        self.workers.insert(member.name.clone(), spawn(ctx.main.clone(), joined, spec));
                    }
                    Err(error) => {
                        // 起不来：这些消息记一条「不可用」，不反复重试。
                        let _ = group::set_delivered(&ctx.main, group::MAIN_GROUP, &member.name, &body.target_ref, last);
                        let _ = group::append(
                            &ctx.main,
                            group::MAIN_GROUP,
                            notice(&member.name, "acp_unavailable", Some(last), &format!("起不来：{error}")),
                        );
                        continue;
                    }
                }
            }
            let worker = &self.workers[&member.name];
            for event in &pending {
                worker.busy.store(true, Ordering::SeqCst);
                let seq = group::seq(event);
                // 群上下文：上次投递之后群里其他人的话，只补增量，不因群事件重开会话。
                let room = settings
                    .as_ref()
                    .and_then(|settings| {
                        deliver::room_window(events, &member.name, since, seq, settings.context_items, settings.context_chars)
                    })
                    .unwrap_or_default();
                since = seq;
                let _ = worker.tx.unbounded_send(Cmd::Prompt {
                    seq,
                    from: text(event, "author").unwrap_or(group::USER).to_owned(),
                    text: format!("{room}{}", text(event, "text").unwrap_or_default()),
                });
            }
            let _ = group::set_delivered(&ctx.main, group::MAIN_GROUP, &member.name, &body.target_ref, last);
        }
        for event in events {
            if text(event, "event") != Some("permission_reply") || !self.answered.insert(group::seq(event)) {
                continue;
            }
            let Some(request) = event.get("reply_to").and_then(Value::as_u64) else {
                continue;
            };
            let owner = events
                .iter()
                .find(|other| group::seq(other) == request)
                .and_then(|other| text(other, "author"));
            if let Some(worker) = owner.and_then(|owner| self.workers.get(owner)) {
                let option = text(event, "option").map(str::to_owned);
                let _ = worker.tx.unbounded_send(Cmd::Answer { request, option });
            }
        }
        self.busy()
    }
}

impl Drop for Acp {
    /// 运行时退出：关掉命令通道，各线程结束会话，crate 关 stdin、等退出、必要时杀整个进程组。
    fn drop(&mut self) {
        let workers: Vec<Worker> = self.workers.drain().map(|(_, worker)| worker).collect();
        let handles: Vec<JoinHandle<()>> = workers.into_iter().filter_map(|mut worker| worker.handle.take()).collect();
        let deadline = Instant::now() + Duration::from_secs(5);
        for handle in handles {
            while !handle.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
    }
}

/// 成员最近一次入群事件里的插件、目录与专家。
pub(crate) fn joined(events: &[Value], member: &Member) -> Option<Joined> {
    let event = events.iter().rev().find(|event| {
        text(event, "kind") == Some("joined")
            && text(event, "author") == Some(member.name.as_str())
            && text(event, "target_ref").is_some_and(is_acp)
    })?;
    Some(Joined {
        name: member.name.clone(),
        agent: text(event, "agent")?.to_owned(),
        cwd: PathBuf::from(text(event, "cwd")?),
        // 旧记录只有 `expert`。
        inputs: event.get("inputs").cloned().unwrap_or_else(|| match text(event, "expert") {
            Some(expert) => json!({ "expert": expert }),
            None => json!({}),
        }),
        provider: event.get("provider").and_then(Value::as_i64).map(|id| (id, text(event, "model").map(str::to_owned))),
    })
}

fn spawn(main: PathBuf, member: Joined, spec: Spec) -> Worker {
    let (tx, rx) = unbounded();
    let busy = Arc::new(AtomicBool::new(false));
    let flag = busy.clone();
    let handle = std::thread::spawn(move || {
        let tmp = spec.tmp.clone();
        let session = Session { main, member, meta: spec.session_meta.clone(), busy: flag.clone(), turn: Default::default() };
        let result = futures::executor::block_on(run(&session, spec, rx));
        // 适配器崩溃时 crate 直接结束连接：进行中的一轮在这里标为中断，下一条消息再按会话恢复。
        if let Some(seq) = session.turn.lock().ok().and_then(|mut turn| turn.take()) {
            let reason = result.as_ref().err().map_or("适配器已退出", String::as_str);
            session.system("turn_interrupted", Some(seq), &format!("这一轮中断：{reason}"));
        }
        session.live(None);
        if let Err(error) = result {
            eprintln!("berth group acp {}: {error}", session.member.name);
        }
        flag.store(false, Ordering::SeqCst);
        if let Some(tmp) = tmp {
            let _ = std::fs::remove_dir_all(tmp);
        }
    });
    Worker { tx, busy, handle: Some(handle) }
}

struct Session {
    main: PathBuf,
    member: Joined,
    meta: Option<Map<String, Value>>,
    busy: Arc<AtomicBool>,
    /// 进行中的一轮回答的是哪条消息。
    turn: std::sync::Mutex<Option<u64>>,
}

impl Session {
    fn target_ref(&self) -> String {
        format!("{PREFIX}{}", self.member.name)
    }

    fn state(&self) -> MemberState {
        member_state(&self.main, group::MAIN_GROUP, &self.member.name, &self.target_ref()).unwrap_or_default()
    }

    fn save(&self, session: &SessionId) {
        let mut state = self.state();
        state.session_id = Some(session.0.to_string());
        save_state(&self.main, group::MAIN_GROUP, &self.member.name, &self.target_ref(), &state);
    }

    fn append(&self, event: Value) -> Option<u64> {
        group::append(&self.main, group::MAIN_GROUP, event).ok().map(|written| group::seq(&written))
    }

    /// 进行中这一轮到目前的过程（群页流式显示）；`None` 时删掉。
    fn live(&self, turn: Option<&Turn>) {
        let path = live_path(&self.main, &self.member.name);
        let Some(turn) = turn else {
            let _ = std::fs::remove_file(path);
            return;
        };
        let mut lines = turn.steps.clone();
        if !turn.text.trim().is_empty() {
            lines.push(json!({ "text": turn.text.trim() }));
        }
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&self.main));
        let _ = std::fs::write(path, json!({ "ask": turn.seq, "lines": lines }).to_string());
    }

    /// 运行时代成员说明一件事（中断、失败、上下文丢失）：记成它发给用户的回答，`event` 标明是哪种，
    /// 群页按回答挂在那条提问下。
    fn system(&self, event: &str, reply_to: Option<u64>, text: &str) {
        self.append(notice(&self.member.name, event, reply_to, text));
    }
}

fn notice(member: &str, event: &str, reply_to: Option<u64>, text: &str) -> Value {
    json!({
        "kind": "message", "source": "transcript", "event": event, "author": member, "to": group::USER,
        "reply_to": reply_to, "text": text,
    })
}

/// 运行时刚起来：上一个运行时没正常退出（被杀、崩溃）时留下的 live 文件说明那一轮没答完，
/// 补记中断并清掉，群页不会一直显示「正在回答」。
fn recover_interrupted(main: &Path) {
    let Ok(entries) = std::fs::read_dir(group::runtime_dir(main).join("acp")) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(member) = path.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_suffix(".live.json"))
        else {
            continue;
        };
        let ask = live(main, member).and_then(|live| live["ask"].as_u64());
        let _ = group::append(main, group::MAIN_GROUP, notice(member, "turn_interrupted", ask, "这一轮中断：群组运行时意外退出"));
        let _ = std::fs::remove_file(&path);
    }
}

/// 会话交给了终端（最近一次 `acp_handoff` 之后没有交回、也没有重新入群）：交接事件；否则 None。
pub fn handed<'a>(events: &'a [Value], member: &str) -> Option<&'a Value> {
    events
        .iter()
        .rev()
        .find(|event| match (text(event, "kind"), text(event, "event")) {
            (Some("joined"), _) => text(event, "author") == Some(member),
            (Some("system"), Some("acp_handoff" | "acp_return")) => text(event, "to") == Some(member),
            _ => false,
        })
        .filter(|event| text(event, "event") == Some("acp_handoff"))
}

/// 忘掉成员记下的会话：下次起进程时开新会话。
pub(crate) fn forget_session(main: &Path, member: &str) {
    let target_ref = format!("{PREFIX}{member}");
    if let Some(mut state) = member_state(main, group::MAIN_GROUP, member, &target_ref) {
        state.session_id = None;
        save_state(main, group::MAIN_GROUP, member, &target_ref, &state);
    }
}

fn live_path(main: &Path, member: &str) -> PathBuf {
    group::runtime_dir(main).join("acp").join(format!("{member}.live.json"))
}

/// 成员正在回答的提问与到目前的过程（与内置 Berth 的 `log` 同形）；没在答为 `None`。
pub fn live(main: &Path, member: &str) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(live_path(main, member)).ok()?).ok()
}

/// 适配器推来的东西：会话更新，或一个审批请求（附上应答它的函数）。
enum Incoming {
    Update(SessionNotification),
    Permission(RequestPermissionRequest, Box<dyn FnOnce(RequestPermissionResponse) + Send>),
}

async fn run(session: &Session, spec: Spec, rx: UnboundedReceiver<Cmd>) -> Result<(), String> {
    let program = spec.argv.first().ok_or("acp spec: empty argv")?;
    // 运行时可能继承了拉起它的终端的身份：适配器（及其 Agent 的 hook）不能冒充那个终端。
    let config = AcpAgentConfig::new(program)
        .args(spec.argv.iter().skip(1).cloned())
        .envs(spec.env)
        .env("BERTH_TARGET_REF", "")
        .env("BERTH_AGENT_TTY", "");
    let (in_tx, in_rx) = unbounded::<Incoming>();
    let updates = in_tx.clone();
    let permissions = in_tx;
    Client
        .v1()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                let _ = updates.unbounded_send(Incoming::Update(notification));
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let reply = Box::new(move |response| {
                    let _ = responder.respond(response);
                });
                let _ = permissions.unbounded_send(Incoming::Permission(request, reply));
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(AcpAgent::new(config), async |cx: ConnectionTo<Agent>| {
            converse(session, &cx, rx, in_rx).await.map_err(|error| agent_client_protocol::Error::internal_error().data(error))
        })
        .await
        .map_err(|error| error.to_string())
}

/// 正在进行的一轮。
struct Turn {
    seq: u64,
    from: String,
    text: String,
    steps: Vec<Value>,
    /// 审批事件 seq → 应答函数。
    asks: HashMap<u64, Box<dyn FnOnce(RequestPermissionResponse) + Send>>,
}

async fn converse(
    session: &Session,
    cx: &ConnectionTo<Agent>,
    mut rx: UnboundedReceiver<Cmd>,
    mut incoming: UnboundedReceiver<Incoming>,
) -> Result<(), String> {
    let init = cx
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
        .map_err(|error| format!("initialize: {error}"))?;
    let meta = session.meta.clone();
    let cwd = session.member.cwd.clone();
    let mut fresh = true;
    let id = match session.state().session_id {
        Some(id) => {
            let id = SessionId::new(id);
            let restored = if init.agent_capabilities.session_capabilities.resume.is_some() {
                cx.send_request(ResumeSessionRequest::new(id.clone(), cwd.clone()).meta(meta.clone()))
                    .block_task()
                    .await
                    .map(drop)
            } else if init.agent_capabilities.load_session {
                cx.send_request(LoadSessionRequest::new(id.clone(), cwd.clone()).meta(meta.clone()))
                    .block_task()
                    .await
                    .map(drop)
            } else {
                Err(agent_client_protocol::Error::from(ErrorCode::RESOURCE_NOT_FOUND))
            };
            match restored {
                Ok(()) => {
                    // load 期间重放的是旧对话，不入账（下一轮开始前清掉）。
                    fresh = false;
                    id
                }
                Err(error) if error.code == ErrorCode::RESOURCE_NOT_FOUND => {
                    session.system("context_lost", None, "上一次的会话已不存在，已开新会话：之前的上下文丢失了");
                    new_session(cx, &cwd, &meta).await?
                }
                Err(error) => {
                    // 其他错误原样报给用户，不悄悄开新会话（规则 4）；未处理的消息照样收下并标为失败。
                    let message = format!("恢复会话失败：{error}");
                    session.busy.store(false, Ordering::SeqCst);
                    while let Some(Cmd::Prompt { seq, .. }) = rx.next().await {
                        session.system("turn_failed", Some(seq), &message);
                    }
                    return Err(message);
                }
            }
        }
        None => new_session(cx, &cwd, &meta).await?,
    };
    // 一轮中又到的消息排在这里，本轮结束后按顺序发。
    let mut queue: VecDeque<Cmd> = VecDeque::new();
    loop {
        // 一轮之外：等下一条消息；这期间适配器推来的更新丢弃（不属于任何一轮），审批一律拒绝。
        let cmd = if let Some(cmd) = queue.pop_front() { cmd } else { futures::select! {
            cmd = rx.next() => match cmd {
                Some(cmd) => cmd,
                None => return Ok(()),
            },
            item = incoming.next() => {
                match item {
                    Some(Incoming::Permission(_, reply)) => reply(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)),
                    Some(Incoming::Update(_)) => {}
                    None => return Err("adapter closed".into()),
                }
                continue;
            }
        } };
        let Cmd::Prompt { seq, from, text } = cmd else {
            continue;
        };
        session.busy.store(true, Ordering::SeqCst);
        // 这一轮之前推来的（load 重放、启动横幅等）不属于这一轮。
        while let Some(Some(item)) = incoming.next().now_or_never() {
            if let Incoming::Permission(_, reply) = item {
                reply(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
            }
        }
        if fresh {
            session.save(&id);
            fresh = false;
        }
        *session.turn.lock().map_err(|error| error.to_string())? = Some(seq);
        let mut turn = Turn { seq, from, text: String::new(), steps: Vec::new(), asks: HashMap::new() };
        session.live(Some(&turn));
        let request = PromptRequest::new(id.clone(), vec![ContentBlock::Text(TextContent::new(text))]).meta(meta.clone());
        // 与账本里这条消息的 timestamp_ms 相减即运行时自身开销。
        eprintln!("berth group acp {}: prompt #{seq} at {}", session.member.name, crate::watch::now_ms());
        let mut reply = std::pin::pin!(cx.send_request(request).block_task().fuse());
        let outcome = loop {
            futures::select! {
                result = reply => break result,
                item = incoming.next() => match item {
                    Some(Incoming::Update(notification)) => {
                        absorb(&mut turn, notification.update);
                        session.live(Some(&turn));
                    }
                    Some(Incoming::Permission(request, answer)) => ask(session, &mut turn, request, answer),
                    None => break Err(agent_client_protocol::Error::internal_error()),
                },
                cmd = rx.next() => match cmd {
                    Some(Cmd::Cancel) => {
                        let _ = cx.send_notification(CancelNotification::new(id.clone()));
                        // 取消后挂着的审批要回 cancelled（协议要求）。
                        for (_, answer) in turn.asks.drain() {
                            answer(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
                        }
                    }
                    Some(Cmd::Answer { request, option }) => {
                        if let Some(answer) = turn.asks.remove(&request) {
                            answer(RequestPermissionResponse::new(match option {
                                Some(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option)),
                                None => RequestPermissionOutcome::Cancelled,
                            }));
                        }
                    }
                    Some(prompt @ Cmd::Prompt { .. }) => queue.push_back(prompt),
                    None => return Ok(()),
                },
            }
        };
        // 一轮结束后才到的流式片段（同一批次里先于响应发出的）一并收下。
        while let Some(Some(Incoming::Update(notification))) = incoming.next().now_or_never() {
            absorb(&mut turn, notification.update);
        }
        if outcome.is_ok() {
            *session.turn.lock().map_err(|error| error.to_string())? = None;
        }
        session.live(None);
        match outcome {
            Ok(response) => {
                let mut answer = turn.text.trim().to_owned();
                if response.stop_reason == StopReason::Cancelled {
                    answer = if answer.is_empty() { "（已取消）".to_owned() } else { format!("{answer}\n\n（已取消）") };
                } else if answer.is_empty() {
                    // 一轮正常结束却一个字没说：不沉默，与中断 / 起不来同形的通知，带最后几步。
                    let mut event = notice(&session.member.name, "turn_empty", Some(turn.seq), "这一轮没有回答");
                    event["to"] = json!(turn.from);
                    event["steps"] = json!(turn.steps[turn.steps.len().saturating_sub(5)..]);
                    session.append(event);
                    session.busy.store(!queue.is_empty(), Ordering::SeqCst);
                    continue;
                }
                session.append(json!({
                    "kind": "message", "source": "transcript", "author": session.member.name, "to": turn.from,
                    "reply_to": turn.seq, "text": answer, "steps": turn.steps,
                }));
            }
            Err(error) => {
                session.busy.store(false, Ordering::SeqCst);
                return Err(error.to_string());
            }
        }
        session.busy.store(!queue.is_empty(), Ordering::SeqCst);
    }
}

async fn new_session(cx: &ConnectionTo<Agent>, cwd: &Path, meta: &Option<Map<String, Value>>) -> Result<SessionId, String> {
    cx.send_request(NewSessionRequest::new(cwd.to_path_buf()).meta(meta.clone()))
        .block_task()
        .await
        .map(|response| response.session_id)
        .map_err(|error| format!("session/new: {error}"))
}

/// 一轮里的更新：回答文字拼起来，工具调用记成步骤；其余（思考、计划、用量、命令列表）S2 再显示。
fn absorb(turn: &mut Turn, update: SessionUpdate) {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            if let ContentBlock::Text(text) = chunk.content {
                turn.text.push_str(&text.text);
            }
        }
        SessionUpdate::ToolCall(call) => turn.steps.push(json!({ "text": call.title })),
        _ => {}
    }
}

/// 审批请求写进账本，等用户应答（`berth group approve`）。
fn ask(
    session: &Session,
    turn: &mut Turn,
    request: RequestPermissionRequest,
    answer: Box<dyn FnOnce(RequestPermissionResponse) + Send>,
) {
    let options: Vec<Value> = request
        .options
        .iter()
        .map(|option| json!({ "id": option.option_id.0.to_string(), "name": option.name, "kind": option.kind }))
        .collect();
    let title = request.tool_call.fields.title.clone().unwrap_or_default();
    let detail = request.tool_call.fields.raw_input.clone();
    match session.append(json!({
        "kind": "system", "event": "permission", "author": session.member.name, "to": group::USER,
        "reply_to": turn.seq, "text": title, "input": detail, "options": options,
    })) {
        Some(seq) => {
            turn.asks.insert(seq, answer);
        }
        None => answer(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)),
    }
}

#[cfg(test)]
#[path = "acp_tests.rs"]
mod tests;
