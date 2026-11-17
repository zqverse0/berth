//! 每个主项目一个的后台进程 `berth group watch`：群组运行时。
//!
//! - **ACP 成员**：起适配器进程、发消息、收回答（[`crate::acp`]）；
//! - **git 动作**：各 checkout 的提交、合并、回退记成项目群的群级事件。
//!
//! 由 join / post / spawn / GUI 按需拉起，单实例（文件锁），经 [`kick_now`] 叫醒；10 分钟没有成员在忙就退出。

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use berth_project_core::tasks::{self, group};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(unix)]
use sha2::{Digest, Sha256};

use crate::{text, Ctx};

/// 兜底周期：叫醒是主路径，周期只用来记提交。
const IDLE_TICK: Duration = Duration::from_secs(30);
/// 没有叫醒通道（非 Unix 或 socket 绑不上）时只能靠周期，退回短周期。
const TICK: Duration = Duration::from_secs(2);
const IDLE_EXIT: Duration = Duration::from_secs(600);

fn lock_path(ctx: &Ctx) -> Option<PathBuf> {
    Some(group::watch_lock_path(&ctx.main, ctx.socket.as_ref()?))
}

/// 叫醒后台进程的 socket：放在临时目录（Unix socket 路径有长度上限，项目路径可能很深）。
#[cfg(unix)]
fn kick_path(ctx: &Ctx) -> Option<PathBuf> {
    let socket = ctx.socket.as_ref()?;
    let digest = Sha256::digest(format!("{}\0{}", ctx.main.display(), socket.display()).as_bytes());
    let key: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    Some(std::env::temp_dir().join(format!("berth-watch-{key}.sock")))
}

/// 拉起并叫醒后台进程马上跑一轮（ACP 成员的消息、审批应答、成员操作）。
pub(crate) fn kick_now(ctx: &Ctx) {
    ensure_running(ctx);
    #[cfg(unix)]
    if let Some(path) = kick_path(ctx) {
        if let Ok(socket) = std::os::unix::net::UnixDatagram::unbound() {
            let _ = socket.send_to(b"a", path);
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

/// ACP 成员的运行态，按 (群, 成员, 身体) 持久化：它的 Agent 会话 id（下次起进程时恢复）。
/// 旧版终端成员的记录有更多字段，读时忽略。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemberState {
    pub(crate) session_id: Option<String>,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
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

/// 记过的 checkout → (HEAD, 分支)。
pub(crate) type Heads = HashMap<String, (String, String)>;

/// 后台循环；拿不到单实例锁就直接返回。
pub(crate) fn run(ctx: &Ctx) {
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
    let mut heads = Heads::new();
    let mut last_busy = Instant::now();
    let wake = Wake::bind(ctx);
    let mut acp = crate::acp::Acp::new(crate::acp::cli_launcher());
    while ctx.main.join(".berth").is_dir() {
        // ACP 成员一轮进行中不换进程，免得打断它。
        if built.is_some() && exe.and_then(modified) != built && !acp.busy() {
            drop(acp);
            drop(lock);
            ensure_running(ctx);
            return;
        }
        let acp_busy = group::events_shared(&ctx.main, group::MAIN_GROUP)
            .map(|events| acp.tick(ctx, &events))
            .unwrap_or(false);
        record_commits(ctx, &mut heads);
        if acp_busy {
            last_busy = Instant::now();
        } else if last_busy.elapsed() > IDLE_EXIT {
            break;
        }
        wake.wait(wake.fallback());
    }
}

/// 等下一轮：叫醒（[`kick_now`]）或到兜底周期。
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

    /// 能被叫醒就用长周期，否则只能短周期轮询。
    fn fallback(&self) -> Duration {
        #[cfg(unix)]
        if self.socket.is_some() {
            return IDLE_TICK;
        }
        TICK
    }

    fn wait(&self, timeout: Duration) {
        #[cfg(unix)]
        if let Some((socket, _)) = &self.socket {
            let _ = socket.set_read_timeout(Some(timeout));
            let mut buf = [0u8; 16];
            if socket.recv(&mut buf).is_ok() {
                // 可能连发几下：合并成这一轮。
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

/// 各 checkout 的 git 动作记进项目群；只在有成员在群时记（没人在时的提交等有人入群再一并记）。
pub(crate) fn record_commits(ctx: &Ctx, heads: &mut Heads) {
    let main = &ctx.main;
    let Ok(envs) = group::checkout_groups(main) else {
        return;
    };
    let Ok(events) = group::events_shared(main, group::MAIN_GROUP) else {
        return;
    };
    if group::members(&events).iter().all(|member| member.bodies.is_empty()) {
        return;
    }
    let branches: Vec<(String, String)> = envs.iter().map(|(name, env)| (name.clone(), env.branch.clone())).collect();
    // 旧版并发登记会给同一目录留下多个群键：每个目录只记一次，否则一个提交按键数重复记。
    let mut recorded = HashSet::new();
    for (checkout, env) in &envs {
        let dir = PathBuf::from(&env.worktree);
        if recorded.insert(canonical(&dir)) {
            record_git(main, checkout, &dir, &events, &branches, heads);
        }
    }
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

/// 启动提示按群环境定位，不再把群组描述为单个任务或分支。
pub fn brief_lines(cwd: &Path) -> Option<String> {
    let main = tasks::resolve(cwd).ok()?.main;
    let (name, env) = group::checkout_groups(&main)
        .ok()?
        .into_iter()
        .find(|(_, env)| inside(cwd, Path::new(&env.worktree)))?;
    let project = main.file_name()?.to_string_lossy();
    let role = if name == group::MAIN_GROUP {
        // 主目录不引导建任务、分 worktree：默认就在当前目录做（想法 2026-10-13-223110-4）。
        String::new()
    } else {
        let display_name = Path::new(&env.worktree).file_name()?.to_string_lossy();
        let assigned = tasks::open_tasks_in_group(&main, &name, None).unwrap_or_default();
        let assigned = if assigned.is_empty() {
            "本 worktree 还没有分配任务".to_owned()
        } else {
            format!("分配到本 worktree 的任务：{}（`berth project . task --json show <任务>` 看详情）", assigned.join("、"))
        };
        format!("- 你在 worktree `{display_name}`：负责实现与测试。{assigned}；任务内容在主目录 {}\n", main.display())
    };
    Some(format!("{role}- 当前群是项目群 `{project}`（标识 `{}`，主目录和各 worktree 共用一个群），你的目录 {}\n", group::MAIN_GROUP, env.worktree))
}
