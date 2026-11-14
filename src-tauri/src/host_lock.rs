//! 同一数据目录同时只有一个宿主，GUI 优先：无界面宿主（`berth-gui --headless`）发现 GUI 在运行就不启动；
//! GUI 启动时让正在运行的无界面宿主退出（终端在 termd 里，接管后照常可用）。无界面宿主持有锁文件，
//! 里面写它的 pid；锁在进程退出时由系统释放，所以读到的 pid 一定还活着。

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

const LOCK: &str = "berth-host.lock";

fn open(data: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data.join(LOCK))
}

/// 无界面宿主：GUI 已在运行或已有无界面宿主时返回 `None`（调用方退出）；否则拿锁并写入 pid，
/// 锁随进程存活。
pub fn hold(data: &Path) -> Option<File> {
    let gui = std::os::unix::net::UnixStream::connect(data.join(crate::remote::DEVICE_SOCKET));
    if gui.is_ok() {
        tracing::info!("[host] a Berth GUI is serving this data directory; exiting");
        return None;
    }
    let mut file = open(data).ok()?;
    if file.try_lock().is_err() {
        tracing::info!("[host] another headless host holds this data directory; exiting");
        return None;
    }
    file.set_len(0).ok()?;
    write!(file, "{}", std::process::id()).ok()?;
    Some(file)
}

/// GUI：有无界面宿主持锁就请它退出，最多等 3 秒放锁。
pub fn take_over(data: &Path) {
    let Ok(mut file) = open(data) else {
        return;
    };
    if file.try_lock().is_ok() {
        return;
    }
    let mut pid = String::new();
    let _ = file.read_to_string(&mut pid);
    let Ok(pid) = pid.trim().parse::<i32>() else {
        return;
    };
    tracing::info!("[host] stopping headless host (pid {pid}) to take over this data directory");
    // SAFETY: 只发信号；pid 来自仍持锁（因而仍存活）的无界面宿主。
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    for _ in 0..30 {
        if file.try_lock().is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    tracing::warn!("[host] headless host (pid {pid}) did not exit in time");
}
