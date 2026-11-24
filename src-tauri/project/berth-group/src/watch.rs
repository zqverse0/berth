//! 每个主项目一个的后台进程 `berth group watch`：群组运行时。
//!
//! ACP 成员：起适配器进程、发消息、收回答（[`crate::acp`]）。
//!
//! 由 join / post / spawn / GUI 按需拉起，单实例（文件锁），经 [`kick_now`] 叫醒；10 分钟没有成员在忙就退出。

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use berth_project_core::tasks::{self, group};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use sha2::{Digest, Sha256};

use crate::Ctx;

/// 兜底周期：叫醒是主路径，周期只防漏叫醒。
#[cfg(unix)]
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
    /// 会话开在哪个目录：群目录改了就不再恢复它。旧记录没有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<String>,
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

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn inside(path: &Path, root: &Path) -> bool {
    canonical(path).starts_with(canonical(root))
}

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
    let mut last_busy = Instant::now();
    let wake = Wake::bind(ctx);
    let mut acp = crate::acp::Acp::new(crate::acp::cli_launcher());
    while berth_project_core::tasks::berth_dir(&ctx.main).is_ok_and(|dir| dir.is_dir()) {
        // ACP 成员一轮进行中不换进程，免得打断它。
        if built.is_some() && exe.and_then(modified) != built && !acp.busy() {
            drop(acp);
            drop(lock);
            ensure_running(ctx);
            return;
        }
        let acp_busy = acp.tick(ctx);
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
    let here = crate::group_at(&main, Path::new(&env.worktree)).ok().flatten().unwrap_or_else(|| group::MAIN_GROUP.to_owned());
    Some(format!(
        "{role}- 项目 `{project}` 可以有多个群，各有自己的目录；目录是这里的群是 `{here}`（`berth group ls` 看全部），你的目录 {}\n",
        env.worktree
    ))
}
