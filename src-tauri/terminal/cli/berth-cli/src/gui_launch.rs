//! Locate and launch the desktop GUI binary when the control socket is down.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use berth_term_ipc::{connect_blocking, endpoint_for_label, LocalEndpoint};

const GUI_BINARY_ENV: &str = "BERTH_GUI_BINARY";
const LAUNCH_TIMEOUT_ENV: &str = "BERTH_GUI_LAUNCH_TIMEOUT_MS";
const DEFAULT_LAUNCH_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);

/// Attempts to start the GUI and wait until its control socket answers.
///
/// `deadline` 让 `open --wait` 的总预算覆盖拉起阶段；`None` 时沿用
/// `BERTH_GUI_LAUNCH_TIMEOUT_MS`（父契约 §5：无命令行覆盖时继续生效）。
/// Returns `Ok(true)` when the GUI is up (either newly launched or racing
/// with another launcher), `Ok(false)` only when the socket never became
/// reachable. Failures to even try (no binary, no display) are `Err` with a
/// user-facing message.
pub(crate) fn try_launch_gui(deadline: Option<Instant>) -> Result<bool, String> {
    let Some(binary) = locate_gui_binary() else {
        return Err(
            "cannot find the berth-gui binary; set BERTH_GUI_BINARY or install the GUI".to_owned(),
        );
    };
    if !display_available() {
        return Err("no display available; the GUI cannot start in this environment".to_owned());
    }
    spawn_detached(&binary)?;

    let endpoint = match endpoint_for_label("gui") {
        Ok(endpoint) => endpoint,
        Err(error) => return Err(format!("cannot resolve GUI endpoint: {error}")),
    };
    let deadline = deadline.unwrap_or_else(|| Instant::now() + launch_timeout());
    while Instant::now() < deadline {
        if connect_blocking(&endpoint, PROBE_TIMEOUT).is_ok() {
            return Ok(true);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    Ok(false)
}

/// BERTH_GUI_BINARY → CLI 同目录 sibling → APPIMAGE。
fn locate_gui_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(GUI_BINARY_ENV).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    if let Some(sibling) = std::env::current_exe()
        .ok()
        .map(|exe| sibling_gui(&exe))
        .filter(|path| path.is_file())
    {
        return Some(sibling);
    }
    std::env::var_os("APPIMAGE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn sibling_gui(cli: &std::path::Path) -> PathBuf {
    let name = if cfg!(windows) {
        "berth-gui.exe"
    } else {
        "berth-gui"
    };
    cli.with_file_name(name)
}

/// Linux 无 X11/Wayland 时不可能启动桌面进程；macOS/Windows 桌面会话由
/// 系统显示服务保证，不依赖 DISPLAY（父契约 A6）。
fn display_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux_has_display(
            std::env::var_os("DISPLAY").as_deref(),
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// 空/缺失的 DISPLAY 与 WAYLAND_DISPLAY 都视作无显示。
#[cfg(target_os = "linux")]
fn linux_has_display(display: Option<&std::ffi::OsStr>, wayland: Option<&std::ffi::OsStr>) -> bool {
    let present = |value: Option<&std::ffi::OsStr>| value.is_some_and(|v| !v.is_empty());
    present(display) || present(wayland)
}

fn spawn_detached(binary: &std::path::Path) -> Result<(), String> {
    let mut command = Command::new(binary);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 脱离父进程组，CLI 退出不能带走 GUI。
        command.process_group(0);
    }
    command
        .spawn()
        .map(|child| {
            // 让 GUI 成为孤儿，由 init 接管。
            std::mem::forget(child)
        })
        .map_err(|error| format!("failed to start '{}': {error}", binary.display()))
}

fn launch_timeout() -> Duration {
    parse_launch_timeout(std::env::var(LAUNCH_TIMEOUT_ENV).ok().as_deref())
}

/// 解析 `BERTH_GUI_LAUNCH_TIMEOUT_MS`；无效值回退默认 15 s。
fn parse_launch_timeout(raw: Option<&str>) -> Duration {
    raw.and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_LAUNCH_TIMEOUT)
}

/// doctor 用的 GUI socket 探测（只探测，不拉起）。
pub(crate) fn probe_gui_socket(cli_override: Option<&OsString>) -> String {
    let endpoint: LocalEndpoint = match crate::gui_client::resolve_gui_endpoint(cli_override) {
        Ok(endpoint) => endpoint,
        Err(error) => return format!("invalid: {error}"),
    };
    let display = {
        #[cfg(windows)]
        {
            endpoint.as_pipe_name().to_string_lossy().into_owned()
        }
        #[cfg(not(windows))]
        {
            endpoint.as_path().display().to_string()
        }
    };
    match connect_blocking(&endpoint, PROBE_TIMEOUT) {
        Ok(_) => format!("gui socket: {display} (reachable)"),
        Err(error) => format!("gui socket: {display} (unreachable: {error})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_timeout_parsing_covers_default_invalid_and_override() {
        assert_eq!(parse_launch_timeout(None), Duration::from_secs(15));
        assert_eq!(
            parse_launch_timeout(Some("250")),
            Duration::from_millis(250)
        );
        // 无效值回退默认，而不是失败。
        assert_eq!(parse_launch_timeout(Some("soon")), Duration::from_secs(15));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_display_detection_treats_empty_as_missing() {
        use std::ffi::OsStr;
        assert!(linux_has_display(Some(OsStr::new(":0")), None));
        assert!(linux_has_display(None, Some(OsStr::new("wayland-0"))));
        assert!(!linux_has_display(
            Some(OsStr::new("")),
            Some(OsStr::new(""))
        ));
        assert!(!linux_has_display(None, None));
    }

    #[test]
    fn sibling_gui_matches_platform_name() {
        let cli = PathBuf::from("/opt/berth/bin/berth");
        let gui = sibling_gui(&cli);
        if cfg!(windows) {
            assert_eq!(gui, PathBuf::from("/opt/berth/bin/berth-gui.exe"));
        } else {
            assert_eq!(gui, PathBuf::from("/opt/berth/bin/berth-gui"));
        }
    }
}
