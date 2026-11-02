//! systemd scope 隔离。
//!
//! systemd-oomd 按 cgroup 整体击杀：termd 和 pane 若都留在 GUI 的 app scope，
//! 一个 pane 吃满内存就会连 GUI、termd、全部终端一起被杀。参照 tmux 3.4，
//! 每个 pane（以及 termd 自己）各进一个 transient scope，只杀出事的那个。

/// 把 `pid` 移进独立的 systemd 用户 scope（`<prefix>-<pid>.scope`，进程退出后自动回收）。
///
/// 在后台线程里调 systemd 自带的 `busctl`，不阻塞调用方；没有 systemd、没有
/// `busctl` 或超时都静默保持原 cgroup。
// ponytail: spawn 之后才移入，shell 启动头几 ms 内 fork 的子进程会留在原 scope；
// 要完全无竞态得在 fork 后的子进程里调 D-Bus（需要 unsafe）。
#[cfg(target_os = "linux")]
pub fn move_to_own_scope(prefix: &'static str, pid: u32) {
    use std::process::{Command, Stdio};

    let _ = std::thread::Builder::new()
        .name("berth-scope".into())
        .spawn(move || {
            let pid = pid.to_string();
            let _ = Command::new("busctl")
                .args([
                    "--user",
                    "--timeout=2",
                    "call",
                    "org.freedesktop.systemd1",
                    "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager",
                    "StartTransientUnit",
                    "ssa(sv)a(sa(sv))",
                ])
                .arg(format!("{prefix}-{pid}.scope"))
                .args(["fail", "2", "PIDs", "au", "1", &pid])
                .args(["CollectMode", "s", "inactive-or-failed", "0"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        });
}

/// 非 Linux 没有 systemd scope，什么都不做。
#[cfg(not(target_os = "linux"))]
pub fn move_to_own_scope(_prefix: &'static str, _pid: u32) {}
