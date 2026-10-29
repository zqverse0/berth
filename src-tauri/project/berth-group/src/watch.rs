//! 每个主项目（+ termd）一个的后台进程 `berth group watch`：
//!
//! - **成员派生**：一个项目一个群，主目录与各 worktree 里选了专家的 Agent 终端都进项目群（`main`），改变 cwd 不换群；
//! - **排队送达**：成员一轮结束（hook 报告）时，把还没送到的消息投进它的 pane（GUI 发的消息也靠这里送）。
//!
//! 一轮结束的回复由 Agent 的 hook 直接贴回群（[`crate::hook`]），这里不读会话、不看屏幕。
//! 由 join / post / spawn / hook / `guide --brief` 按需拉起，单实例（文件锁），10 分钟没有在群的 live pane 就退出；
//! hook 经 [`kick`] 叫醒它，不用等下一个周期。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use berth_project_core::tasks::{self, group, group::{Body, Member}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::term::{self, Fail, Terminals};
use crate::{deliver, identity, text, Ctx};
use crate::term::PaneProbe;

/// 兜底周期：hook 叫醒是主路径，周期只用来发现新终端、离群和重试。
const TICK: Duration = Duration::from_secs(2);
const IDLE_EXIT: Duration = Duration::from_secs(600);
/// 被 hook 叫醒后稍等：一轮结束的 hook 还没返回，Agent 回到输入框还要一瞬。
const KICK_SETTLE: Duration = Duration::from_millis(300);

fn lock_path(ctx: &Ctx) -> Option<PathBuf> {
    Some(group::watch_lock_path(&ctx.main, ctx.socket.as_ref()?))
}

/// 叫醒后台进程的 socket：放在临时目录（Unix socket 路径有长度上限，项目路径可能很深）。
fn kick_path(ctx: &Ctx) -> Option<PathBuf> {
    let socket = ctx.socket.as_ref()?;
    let digest = Sha256::digest(format!("{}\0{}", ctx.main.display(), socket.display()).as_bytes());
    let key: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    Some(std::env::temp_dir().join(format!("berth-watch-{key}.sock")))
}

/// 叫醒后台进程马上跑一轮（hook 报告一轮开始 / 结束、会话开始之后）；没在跑就拉起。
pub(crate) fn kick(ctx: &Ctx) {
    ensure_running(ctx);
    nudge(ctx);
}

/// 只叫醒已在跑的后台进程，不负责拉起（GUI 带自己的启动环境另行拉起）。
pub(crate) fn nudge(ctx: &Ctx) {
    #[cfg(unix)]
    if let Some(path) = kick_path(ctx) {
        if let Ok(socket) = std::os::unix::net::UnixDatagram::unbound() {
            let _ = socket.send_to(b"k", path);
        }
    }
}

fn try_lock(path: &Path) -> Option<File> {
    std::fs::create_dir_all(path.parent()?).ok()?;
    let handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    handle.try_lock().ok()?;
    Some(handle)
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}

/// 没在跑就拉起（脱离当前进程组，输出进 `local/runtime/watch.log`）。
pub(crate) fn ensure_running(ctx: &Ctx) {
    let (Some(socket), Some(lock)) = (ctx.socket.as_ref(), lock_path(ctx)) else {
        return;
    };
    if try_lock(&lock).is_none() {
        return;
    }
    let exe = &ctx.cli;
    let log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(group::runtime_dir(&ctx.main).join("watch.log"))
        .ok();
    let mut command = Command::new(exe);
    command.arg("-S").arg(socket);
    if let Some(gui) = &ctx.gui {
        command.arg("--gui").arg(gui);
    }
    command
        .args(["group", "--workspace"])
        .arg(&ctx.main)
        .arg("watch")
        .stdin(Stdio::null());
    match log.and_then(|log| Some((log.try_clone().ok()?, log))) {
        Some((out, err)) => command.stdout(out).stderr(err),
        None => command.stdout(Stdio::null()).stderr(Stdio::null()),
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let _ = command.spawn();
}

/// 终端的 hook 记录，按 (群, 成员, pane) 持久化：会话开始时 hook 写下会话 id 与会话文件，
/// 一轮结束贴回结果后记下回答到哪条委托。有记录才算这个终端的 hook 在工作（才入群、才投递）。
/// GUI 与 `who` 读其中的会话 id（持久化键沿用旧格式）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberState {
    pub(crate) session_id: Option<String>,
    pub(crate) session_path: Option<PathBuf>,
    /// 已为哪条消息（seq）汇报过。
    #[serde(default)]
    pub(crate) reported_for: u64,
    /// 最近一轮开始时工作目录的改动快照：一轮结束时比出这一轮改了哪些文件。
    #[serde(default)]
    pub(crate) before: Option<Snapshot>,
}

/// 一轮开始时的工作目录：拍下的时间；在 git 仓库里时还有仓库根与各改动条目（`XY 路径`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) cwd: PathBuf,
    #[serde(default)]
    pub(crate) root: Option<PathBuf>,
    #[serde(default)]
    pub(crate) entries: Vec<String>,
    pub(crate) at_ms: u64,
}

/// 一条回复最多列这么多个改动文件。
const MAX_FILES: usize = 30;
/// 新文件按行数算「+N」；超过这个大小的不读。
const COUNT_MAX_BYTES: u64 = 1 << 20;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn ms(at: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    Some(at.ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// `-z`：路径不转义；不跟踪重命名，删 + 增各一条。
fn git_status(root: &Path) -> Option<Vec<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain", "-z", "-uall", "--no-renames"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|entry| entry.len() > 3)
            .map(str::to_owned)
            .collect()
    })
}

/// 一轮开始时拍下 `cwd`（在 git 仓库里时连同改动条目）。
pub(crate) fn snapshot(cwd: &Path) -> Snapshot {
    let root = git(cwd, &["rev-parse", "--show-toplevel"]).map(PathBuf::from);
    let entries = root.as_deref().and_then(git_status).unwrap_or_default();
    Snapshot { cwd: cwd.to_path_buf(), root, entries, at_ms: now_ms() }
}

/// 文本文件的行数（新文件的「+N」）；太大或不是 UTF-8 时 None。
fn line_count(path: &Path) -> Option<u64> {
    if std::fs::metadata(path).ok()?.len() > COUNT_MAX_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(text.lines().count() as u64)
}

/// 这一轮改了的文件，路径相对返回的根目录（仓库根，不在仓库里时是 `cwd`；根外的写绝对路径）。
/// - git 仓库：快照里没有（或状态变了）的条目，加上状态没变、但快照后又写过的文件；行数取 `git diff --numstat HEAD`。
/// - 不在仓库里：这一轮工具调用的目标里，快照后写过的文件（快照后才创建的算新增）；删除看不出来。
///
/// 新增文件按行数记 `+N`；不在仓库里改过的旧文件没有改前内容，不给行数。
// ponytail: 同一目录里另一个 Agent 同时改的文件也会算进来；git 行数是相对 HEAD 的累计（改前已脏的文件会偏大）。
pub(crate) fn turn_files(before: &Snapshot, targets: &[String]) -> (PathBuf, Vec<Value>) {
    let written_since = |path: &Path| {
        ms(std::fs::metadata(path).and_then(|meta| meta.modified())).is_some_and(|at| at >= before.at_ms)
    };
    if let Some(root) = &before.root {
        let now = git_status(root).unwrap_or_default();
        let changed: Vec<(&str, &str)> = now
            .iter()
            .filter(|entry| !before.entries.contains(entry) || written_since(&root.join(&entry[3..])))
            .take(MAX_FILES)
            .map(|entry| {
                let status = match entry[..2].trim() {
                    "??" | "A" | "AM" => "added",
                    code if code.contains('D') => "deleted",
                    _ => "modified",
                };
                (&entry[3..], status)
            })
            .collect();
        let mut numstat = HashMap::new();
        if !changed.is_empty() {
            let mut args = vec!["diff", "--numstat", "HEAD", "--"];
            args.extend(changed.iter().map(|(path, _)| *path));
            for line in git(root, &args).unwrap_or_default().lines() {
                let mut parts = line.splitn(3, '\t');
                if let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) {
                    numstat.insert(path.to_owned(), (added.parse::<u64>().ok(), removed.parse::<u64>().ok()));
                }
            }
        }
        let files = changed
            .into_iter()
            .map(|(path, status)| {
                let (added, removed) = numstat.get(path).copied().unwrap_or_else(|| match status {
                    "added" => (line_count(&root.join(path)), Some(0)),
                    _ => (None, None),
                });
                json!({ "path": path, "status": status, "added": added, "removed": removed })
            })
            .collect();
        return (root.clone(), files);
    }
    let base = &before.cwd;
    let mut seen = HashSet::new();
    let files = targets
        .iter()
        .map(|target| base.join(target))
        .filter(|path| path.is_file() && written_since(path))
        .filter(|path| seen.insert(path.clone()))
        .take(MAX_FILES)
        .map(|path| {
            let created = ms(std::fs::metadata(&path).and_then(|meta| meta.created())).is_some_and(|at| at >= before.at_ms);
            let shown = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().into_owned();
            if created {
                json!({ "path": shown, "status": "added", "added": line_count(&path), "removed": 0 })
            } else {
                json!({ "path": shown, "status": "modified" })
            }
        })
        .collect();
    (base.clone(), files)
}

pub(crate) fn member_state(main: &Path, name: &str, member: &str, target_ref: &str) -> Option<MemberState> {
    let path = group::member_state_path(main, name, member, target_ref);
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub(crate) fn save_state(main: &Path, name: &str, member: &str, target_ref: &str, state: &MemberState) {
    let path = group::member_state_path(main, name, member, target_ref);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(encoded) = serde_json::to_vec(state) {
        let _ = std::fs::write(path, encoded);
    }
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn git_ok(cwd: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn inside(path: &Path, root: &Path) -> bool {
    canonical(path).starts_with(canonical(root))
}

type Key = (String, String, String);

/// 未能送达（Agent 不在输入框）后，过这么久再试。
const RETRY_AFTER: Duration = Duration::from_secs(10);

/// 这个终端现在能投：hook 报告过会话、不在一轮里、进程还在。一轮中等授权或选择（attention + busy）不投，
/// 一轮结束后的提醒（attention、不 busy）照投。
pub(crate) fn deliverable(main: &Path, name: &str, member: &str, target_ref: &str, probe: &PaneProbe) -> bool {
    !probe.busy && probe.agent_state != Some("exited") && hooked(main, name, member, target_ref)
}

/// 终端的 hook 报告过会话开始。
fn hooked(main: &Path, name: &str, member: &str, target_ref: &str) -> bool {
    member_state(main, name, member, target_ref).is_some_and(|state| state.session_id.is_some())
}

/// 后台进程跨轮次的内存状态。
#[derive(Default)]
pub(crate) struct WatchState {
    retry: HashMap<Key, Instant>,
    /// 群 → 已记录的群目录 (HEAD, 分支)。
    heads: HashMap<String, (String, String)>,
}

/// 后台循环；拿不到单实例锁就直接返回。
pub(crate) fn run(ctx: &Ctx, term: &dyn Terminals) {
    // 别处（GUI、另一个 CLI）检查「在不在跑」会瞬间持锁：拿不到时稍等再试，免得两边都以为对方在跑。
    let Some(lock) = lock_path(ctx).and_then(|path| {
        (0..5).find_map(|attempt| {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(100));
            }
            try_lock(&path)
        })
    }) else {
        return;
    };
    // CLI 升级后（可执行文件被替换）换新进程接着跑，长驻进程不一直用旧代码。
    let exe = Some(ctx.cli.as_path());
    let built = exe.and_then(modified);
    let mut state = WatchState::default();
    let mut last_busy = Instant::now();
    let wake = Wake::bind(ctx);
    while ctx.main.join(".berth").is_dir() {
        if built.is_some() && exe.and_then(modified) != built {
            drop(lock);
            ensure_running(ctx);
            return;
        }
        if tick(ctx, term, &mut state) {
            last_busy = Instant::now();
        } else if last_busy.elapsed() > IDLE_EXIT {
            break;
        }
        wake.wait(TICK);
    }
}

/// 等下一轮：hook 叫醒（[`kick`]）或到兜底周期。
struct Wake {
    #[cfg(unix)]
    socket: Option<(std::os::unix::net::UnixDatagram, PathBuf)>,
}

impl Wake {
    fn bind(ctx: &Ctx) -> Self {
        #[cfg(unix)]
        {
            // 持有单实例锁才走到这里：旧 socket 文件是上一个进程留下的，直接替换。
            let socket = kick_path(ctx).and_then(|path| {
                let _ = std::fs::remove_file(&path);
                let socket = std::os::unix::net::UnixDatagram::bind(&path).ok()?;
                Some((socket, path))
            });
            Self { socket }
        }
        #[cfg(not(unix))]
        {
            let _ = ctx;
            Self {}
        }
    }

    fn wait(&self, timeout: Duration) {
        #[cfg(unix)]
        if let Some((socket, _)) = &self.socket {
            let _ = socket.set_read_timeout(Some(timeout));
            let mut buf = [0u8; 16];
            if socket.recv(&mut buf).is_ok() {
                std::thread::sleep(KICK_SETTLE);
                // 一次 hook 可能连发几下：合并成这一轮。
                let _ = socket.set_nonblocking(true);
                while socket.recv(&mut buf).is_ok() {}
                let _ = socket.set_nonblocking(false);
            }
            return;
        }
        std::thread::sleep(timeout);
    }
}

#[cfg(unix)]
impl Drop for Wake {
    fn drop(&mut self) {
        if let Some((_, path)) = &self.socket {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 一轮：派生成员 → 逐个在群的 pane 判离群、送达。返回是否还有在群的 live pane。
pub(crate) fn tick(ctx: &Ctx, term: &dyn Terminals, watch: &mut WatchState) -> bool {
    let main = &ctx.main;
    let Ok(envs) = group::checkout_groups(main) else {
        return false;
    };
    let branches: Vec<(String, String)> = envs
        .iter()
        .map(|(name, env)| (name.clone(), env.branch.clone()))
        .collect();
    let worktrees: Vec<(String, PathBuf)> = envs
        .into_iter()
        .map(|(name, env)| (name, PathBuf::from(env.worktree)))
        .collect();
    let mut roots = vec![main.clone()];
    roots.extend(worktrees.iter().map(|(_, path)| path.clone()));
    let panes: BTreeMap<String, PaneProbe> = match term.panes_under(&roots) {
        Ok(panes) => panes.into_iter().collect(),
        Err(error) => {
            eprintln!("berth group watch: {error:?}");
            return false;
        }
    };
    derive_members(main, term, &worktrees, &panes);

    // 一个项目一个群：各 checkout 的成员、提交都在 `main` 群；worktree 只是成员终端的工作目录。
    let name = group::MAIN_GROUP.to_owned();
    let mut busy = false;
    let Ok(events) = group::events(main, &name) else {
        return false;
    };
    let members = group::members(&events);
    // 只在有成员在群时记：没人在时的提交等有人入群再一并记。
    if members.iter().any(|member| !member.bodies.is_empty()) {
        for (checkout, dir) in &worktrees {
            record_git(main, checkout, dir, &events, &branches, &mut watch.heads);
        }
    }
    for member in &members {
        for body in &member.bodies {
            // 另一个实例（正式版 / dev）的终端由那边的后台进程负责，否则两边互相踢出、拉回。
            if term.foreign(&body.target_ref) {
                continue;
            }
            let probe = match panes.get(&body.target_ref) {
                Some(probe) => Ok(probe.clone()),
                None => term.probe(&body.target_ref),
            };
            busy |= tick_body(ctx, term, watch, &name, member, body, probe);
        }
    }
    busy
}

/// 成员的一个终端：确认还在 → 可投时投该它接的消息。返回终端是否还在群。
fn tick_body(
    ctx: &Ctx,
    term: &dyn Terminals,
    watch: &mut WatchState,
    name: &str,
    member: &Member,
    body: &Body,
    probe: Result<PaneProbe, Fail>,
) -> bool {
    let main = &ctx.main;
    let target_ref = &body.target_ref;
    let key: Key = (name.to_owned(), member.name.clone(), target_ref.clone());
    let probe = match probe {
        Ok(probe) if probe.agent_state != Some("exited") => probe,
        Ok(_) | Err(Fail::Stale) => {
            // 已确认退出才离群；连接失败不等于退出。
            leave(main, name, &member.name, target_ref, "agent_exited");
            return false;
        }
        Err(Fail::Unavailable(_)) => return false,
    };
    // Agent 进程退出才离群；改变工作目录不改变 session 的群组归属。
    if body.derived && term::agent_of(&probe).is_none() {
        leave(main, name, &member.name, target_ref, "agent_exited");
        return false;
    }
    let due = watch.retry.get(&key).is_none_or(|at| Instant::now() >= *at);
    if due && deliverable(main, name, &member.name, target_ref, &probe) {
        if let Some(_slot) = deliver::slot(main, name, &member.name) {
            let rung = deliver::ring(ctx, term, name, &member.name, target_ref);
            if rung["status"] == "waiting" {
                watch.retry.insert(key, Instant::now() + RETRY_AFTER);
            } else {
                watch.retry.remove(&key);
            }
        }
    }
    true
}

/// 一个 checkout 的 git 动作记成项目群的群级事件（带 `checkout`）；是谁做的不猜，不挂到某个成员的汇报上。
/// - 有新提交：`commits`；合并（合并提交或快进到别的 checkout 的分支）带 `merged`；
///   旧 HEAD 不在新历史里（rebase / amend）带 `rewritten`。
/// - 没有新提交：`head`，换了分支带 `from_branch`，否则是回退。
///
/// 后台进程重启后从账本里最后一条 git 事件接着比；从没记过就以当前 HEAD 为起点。
fn record_git(
    main: &Path,
    checkout: &str,
    dir: &Path,
    events: &[Value],
    branches: &[(String, String)],
    heads: &mut HashMap<String, (String, String)>,
) {
    let Some(now) = git(dir, &["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]) else {
        return;
    };
    let mut lines = now.lines().map(str::to_owned);
    let (Some(head), Some(branch)) = (lines.next(), lines.next()) else {
        return;
    };
    let before = heads.get(checkout).cloned().or_else(|| {
        // 旧事件没有 `checkout`：那时每个 checkout 一个群，`main` 群里的就是主目录的。
        let last = events.iter().rev().find(|event| {
            matches!(text(event, "event"), Some("commits" | "head"))
                && text(event, "checkout").unwrap_or(group::MAIN_GROUP) == checkout
        })?;
        Some((
            text(last, "head")?.to_owned(),
            text(last, "branch").unwrap_or(&branch).to_owned(),
        ))
    });
    heads.insert(checkout.to_owned(), (head.clone(), branch.clone()));
    let Some((before, before_branch)) = before.filter(|(before, _)| *before != head) else {
        return;
    };
    let range = format!("{before}..{head}");
    // ponytail: 大跳变只列最近 20 条。
    let commits = git(dir, &["log", "--oneline", "-n", "20", &range]).unwrap_or_default();
    if commits.is_empty() {
        let switched = before_branch != branch;
        let _ = group::append(
            main,
            group::MAIN_GROUP,
            json!({
                "kind": "system", "event": "head", "checkout": checkout, "head": head, "branch": branch,
                "from_branch": switched.then_some(before_branch),
                "idempotency_key": format!("head:{checkout}:{before}:{head}"),
            }),
        );
        return;
    }
    // 合并来源：合并提交的第二个父提交，或快进后的 HEAD，正好是别的群分支的末端。
    let parents = git(dir, &["rev-list", "--parents", "-n", "1", &head]).unwrap_or_default();
    let tip = parents.split_whitespace().nth(2).unwrap_or(&head).to_owned();
    let source = branches.iter().find(|(group, other)| {
        group != checkout && *other != branch && git(main, &["rev-parse", other]).as_deref() == Some(tip.as_str())
    });
    let rewritten = !git_ok(dir, &["merge-base", "--is-ancestor", &before, &head]);
    let diffstat = git(dir, &["diff", "--shortstat", &range]).unwrap_or_default();
    let _ = group::append(
        main,
        group::MAIN_GROUP,
        json!({
            "kind": "system", "event": "commits", "checkout": checkout, "head": head, "branch": branch,
            "commits": commits.lines().collect::<Vec<_>>(), "diffstat": diffstat,
            "merged": source.map(|(_, other)| other), "rewritten": rewritten,
            "idempotency_key": format!("commits:{checkout}:{head}"),
        }),
    );
}

/// 成员的一个终端离群（最后一个终端走了成员才离群）。
fn leave(main: &Path, name: &str, member: &str, target_ref: &str, reason: &str) {
    let _ = group::append(
        main,
        name,
        json!({"kind": "left", "author": member, "target_ref": target_ref, "reason": reason}),
    );
}

/// 本项目（主目录或任何 worktree）里选了专家、且 hook 报告过会话的 Agent 终端自动进项目群。
/// 没有 hook 的 Agent 不入群：Berth 不知道它何时一轮结束，既没法送达也没法收结果。
/// 旧版每个 worktree 一个群：那些群里还在的终端各离群一次（账本留着只读），随后进项目群。
fn derive_members(
    main: &Path,
    term: &dyn Terminals,
    worktrees: &[(String, PathBuf)],
    panes: &BTreeMap<String, PaneProbe>,
) {
    for (name, _) in worktrees.iter().filter(|(name, _)| name != group::MAIN_GROUP) {
        for member in group::events(main, name).map(|events| group::members(&events)).unwrap_or_default() {
            for body in member.bodies.iter().filter(|body| !term.foreign(&body.target_ref)) {
                leave(main, name, &member.name, &body.target_ref, "project_group");
            }
        }
    }
    let mut claimed: HashSet<String> = group::events(main, group::MAIN_GROUP)
        .map(|events| group::members(&events))
        .unwrap_or_default()
        .into_iter()
        .flat_map(|member| member.bodies)
        .map(|body| body.target_ref)
        .collect();
    let dirs: Vec<PathBuf> = worktrees.iter().map(|(_, path)| canonical(path)).collect();
    for (target_ref, probe) in panes {
        if claimed.contains(target_ref) || probe.agent_state == Some("exited") {
            continue;
        }
        // 成员是专家：没选专家的 Agent 不入群；同一专家的几个终端都是这个成员的。
        let (Some(agent), Some(owner), Some(author)) = (
            term::agent_of(probe),
            probe.session_project_path.as_deref(),
            identity::member_name(probe),
        ) else {
            continue;
        };
        if !dirs.contains(&canonical(Path::new(owner)))
            || !hooked(main, group::MAIN_GROUP, &author, target_ref)
        {
            continue;
        }
        if group::append(
            main,
            group::MAIN_GROUP,
            json!({
                "kind": "joined", "author": author, "target_ref": target_ref,
                "agent": agent, "cwd": owner, "collect": true, "derived": true,
                "session_id": member_state(main, group::MAIN_GROUP, &author, target_ref).and_then(|state| state.session_id),
            }),
        )
        .is_ok()
        {
            claimed.insert(target_ref.clone());
        }
    }
}

/// 启动提示按群环境定位，不再把群组描述为单个任务或分支。
/// `socket`：可信的 termd 端点（只在 Berth 终端里才有）；`cli`：berth CLI，用来拉起后台进程。
pub fn brief_lines(cwd: &Path, socket: Option<PathBuf>, cli: PathBuf) -> Option<String> {
    let main = tasks::resolve(cwd).ok()?.main;
    let (name, env) = group::checkout_groups(&main)
        .ok()?
        .into_iter()
        .find(|(_, env)| inside(cwd, Path::new(&env.worktree)))?;
    let ctx = Ctx {
        main,
        socket,
        gui: None,
        cli,
        caller: None,
    };
    ensure_running(&ctx);
    let project = ctx.main.file_name()?.to_string_lossy();
    let role = if name == group::MAIN_GROUP {
        // 主目录不引导建任务、分 worktree：默认就在当前目录做（想法 2026-10-13-223110-4）。
        String::new()
    } else {
        let display_name = Path::new(&env.worktree).file_name()?.to_string_lossy();
        let assigned = tasks::open_tasks_in_group(&ctx.main, &name, None).unwrap_or_default();
        let assigned = if assigned.is_empty() {
            "本 worktree 还没有分配任务".to_owned()
        } else {
            format!("分配到本 worktree 的任务：{}（`berth project . task --json show <任务>` 看详情）", assigned.join("、"))
        };
        format!("- 你在 worktree `{display_name}`：负责实现与测试。{assigned}；任务内容在主目录 {}\n", ctx.main.display())
    };
    Some(format!("{role}- 当前群是项目群 `{project}`（标识 `{}`，主目录和各 worktree 共用一个群），你的目录 {}；群成员是专家：启动时选了专家的 Agent 每轮结束 Berth 自动把回复贴回群，无需手动 post，没选专家的不在群里\n", group::MAIN_GROUP, env.worktree))
}
