//! 把分配器留着的空闲内存还给系统。
//!
//! glibc 释放后的页留在各线程的分配区里，进程常驻只涨不降：正式版跑 10 小时后
//! 一次 `malloc_trim` 收回 136 MB（匿名 250 → 145 MB，swap 72 → 41 MB）。
//! 其他平台 / libc 不需要，空实现。

/// 立即归还空闲页。
pub fn trim() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}

/// 起一个后台线程，每分钟归还一次；进程退出时随之结束。
pub fn spawn_periodic_trim() {
    // 一次耗时 1–10 ms，按分钟级做足够
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    let _ = std::thread::Builder::new()
        .name("berth-mem-trim".into())
        .spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            trim();
        });
}

/// 进程当前常驻与峰值（KB），读 `/proc/self/status` 的 VmRSS / VmHWM；只供调试日志用。
pub fn rss_and_peak_kb() -> Option<(u64, u64)> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let field = |key: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok())
    };
    Some((field("VmRSS:")?, field("VmHWM:")?))
}

/// 把峰值 VmHWM 重置为当前常驻，之后读到的峰值即这段时间内的最高点（整进程口径）。
pub fn reset_peak() {
    #[cfg(target_os = "linux")]
    let _ = std::fs::write("/proc/self/clear_refs", "5");
}
