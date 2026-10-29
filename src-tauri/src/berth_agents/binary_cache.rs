//! 启动时清扫旧 ACP 二进制缓存的 rename-aside 垃圾。
//!
//! 代装路径已删除；只保留历史残留目录的清理，避免上次失败卸载留下的
//! `.trash` 一直占磁盘。

use std::path::PathBuf;

fn cache_dir() -> Option<PathBuf> {
    Some(dirs::cache_dir()?.join("app.berth").join("acp-binaries"))
}

/// 清扫 `clear_agent_cache` 历史 rename-aside 留下的 `.trash` 目录。
/// 设计为启动时在分离 OS 线程调用：错误全部吞掉，不打日志、不 panic。
pub fn sweep_trash() {
    let Some(base) = cache_dir() else { return };
    let trash = base.join(".trash");
    let Ok(entries) = std::fs::read_dir(&trash) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = std::fs::remove_dir_all(entry.path());
    }
}
