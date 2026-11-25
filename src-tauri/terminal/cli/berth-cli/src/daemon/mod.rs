//! 内置于 `berth`（`berth-cli`）的本地终端守护进程入口。
//!
//! 以前作为独立 sidecar `berth-termd` 分发；合并后，`berth` 既承担命令行与工具能力，
//! 也在收到 `--__internal-daemon`（或以 `berth-termd` 别名调用）时直接以长驻终端守护进程运行，
//! 便于无头服务器单文件部署并省去第二份 sidecar 维护。

mod server_runtime;

use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use berth_term_server::{DaemonConfig, ServerDaemon};

/// SDK / GUI 拉起内置终端守护进程时传入的隐藏入口参数。
pub(crate) const INTERNAL_DAEMON_FLAG: &str = "--__internal-daemon";

/// 判断本次调用是否应直接进入隐藏终端守护进程模式（跳过 CLI 数据库/参数初始化）。
pub(crate) fn should_run_as_daemon(raw_args: &[OsString]) -> bool {
    if raw_args.get(1).map(OsString::as_os_str) == Some(OsStr::new(INTERNAL_DAEMON_FLAG)) {
        return true;
    }
    raw_args
        .first()
        .and_then(|argv0| Path::new(argv0).file_stem())
        .and_then(OsStr::to_str)
        .is_some_and(|stem| stem == "berth-termd")
}

/// 以守护进程模式执行，参数为 `argv[1..]`。
pub(crate) fn run_from_args<I>(args: I) -> ExitCode
where
    I: IntoIterator<Item = OsString>,
{
    match try_main(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "{error}");
            ExitCode::FAILURE
        }
    }
}

fn try_main<I>(args: I) -> io::Result<()>
where
    I: IntoIterator<Item = OsString>,
{
    let args = parse_daemon_args(args.into_iter())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    run_hidden_daemon(args)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonArgs {
    socket_path: Option<PathBuf>,
    startup_ready_fd: Option<i32>,
    startup_ready_event: Option<OsString>,
}

fn parse_daemon_args<I>(mut args: I) -> Result<DaemonArgs, String>
where
    I: Iterator<Item = OsString>,
{
    let mut socket_path = None;
    let mut startup_ready_fd = None;
    let mut startup_ready_event = None;

    let mut first = args.next();
    if first.as_deref() == Some(OsStr::new(INTERNAL_DAEMON_FLAG)) {
        first = args.next();
    }

    if let Some(first) = first {
        if is_internal_flag_token(first.as_os_str()) {
            parse_internal_flag(
                first,
                &mut args,
                &mut startup_ready_fd,
                &mut startup_ready_event,
            )?;
        } else {
            socket_path = Some(PathBuf::from(first));
        }
    }

    while let Some(argument) = args.next() {
        if !is_internal_flag_token(argument.as_os_str()) {
            return Err("unexpected extra arguments for hidden daemon mode".to_owned());
        }
        parse_internal_flag(
            argument,
            &mut args,
            &mut startup_ready_fd,
            &mut startup_ready_event,
        )?;
    }

    Ok(DaemonArgs {
        socket_path,
        startup_ready_fd,
        startup_ready_event,
    })
}

fn parse_internal_flag<I>(
    argument: OsString,
    args: &mut I,
    startup_ready_fd: &mut Option<i32>,
    startup_ready_event: &mut Option<OsString>,
) -> Result<(), String>
where
    I: Iterator<Item = OsString>,
{
    match argument.to_str() {
        Some("--startup-ready-fd") => {
            let fd = args
                .next()
                .ok_or_else(|| "--startup-ready-fd requires a file descriptor".to_owned())?;
            let fd = fd
                .to_str()
                .ok_or_else(|| "invalid UTF-8 in --startup-ready-fd".to_owned())?
                .parse::<i32>()
                .map_err(|_| "--startup-ready-fd requires an integer file descriptor".to_owned())?;
            if fd < 0 {
                return Err("--startup-ready-fd requires a non-negative file descriptor".to_owned());
            }
            *startup_ready_fd = Some(fd);
        }
        Some("--startup-ready-event") => {
            let event = args
                .next()
                .ok_or_else(|| "--startup-ready-event requires an event name".to_owned())?;
            *startup_ready_event = Some(event);
        }
        Some(other) => return Err(format!("unexpected hidden daemon argument '{other}'")),
        None => return Err("invalid UTF-8 in hidden daemon flag".to_owned()),
    }

    Ok(())
}

fn run_hidden_daemon(args: DaemonArgs) -> io::Result<()> {
    // macOS 没有就绪通知参数，config 不会再被改写
    #[cfg_attr(not(any(target_os = "linux", windows)), allow(unused_mut))]
    let mut config = match args.socket_path {
        Some(socket_path) => DaemonConfig::new(socket_path),
        None => DaemonConfig::with_default_socket_path()?,
    };
    #[cfg(target_os = "linux")]
    if let Some(ready_fd) = args.startup_ready_fd {
        config = config.with_startup_ready_fd(ready_fd);
    }
    #[cfg(windows)]
    if let Some(ready_event) = args.startup_ready_event {
        config = config.with_startup_ready_event(ready_event);
    }
    set_daemon_process_name();
    berth_term_os::memory::configure_daemon_allocator();
    berth_term_os::scope::move_to_own_scope("berth-termd", std::process::id());
    let runtime = server_runtime::build_daemon_runtime()?;

    runtime.block_on(async move {
        let server = ServerDaemon::new(config).bind().await?;
        server.wait().await
    })
}

/// Linux 下将线程/进程 comm 设为 `berth-termd`，便于 `ps`/`htop` 与普通 CLI 进程区分。
#[cfg(target_os = "linux")]
fn set_daemon_process_name() {
    // SAFETY: `PR_SET_NAME` 读取以 NUL 结尾且不超过 16 字节的字符串，不持有指针。
    unsafe {
        libc::prctl(libc::PR_SET_NAME, c"berth-termd".as_ptr(), 0, 0, 0);
    }
}

#[cfg(not(target_os = "linux"))]
fn set_daemon_process_name() {}

fn is_internal_flag_token(value: &OsStr) -> bool {
    value.to_str().is_some_and(|value| value.starts_with("--"))
}

#[cfg(test)]
mod tests {
    use super::{parse_daemon_args, should_run_as_daemon, INTERNAL_DAEMON_FLAG};
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn daemon_mode_triggers_on_internal_flag_or_legacy_argv0() {
        assert!(should_run_as_daemon(&[
            OsString::from("/usr/bin/berth"),
            OsString::from(INTERNAL_DAEMON_FLAG),
            OsString::from("/tmp/berth.sock"),
        ]));
        assert!(should_run_as_daemon(&[OsString::from(
            "/usr/bin/berth-termd"
        )]));
        assert!(!should_run_as_daemon(&[
            OsString::from("/usr/bin/berth"),
            OsString::from("terminal"),
            OsString::from("ls"),
        ]));
        assert!(!should_run_as_daemon(&[
            OsString::from("/usr/bin/berth"),
            OsString::from("group"),
            OsString::from("watch"),
        ]));
    }

    #[test]
    fn daemon_parser_accepts_direct_start() {
        let args = parse_daemon_args(std::iter::empty()).expect("direct start should work");

        assert_eq!(args.socket_path, None);
    }

    #[test]
    fn daemon_parser_accepts_socket_and_startup_ready_flags() {
        let args = parse_daemon_args(
            [
                OsString::from(INTERNAL_DAEMON_FLAG),
                OsString::from("/tmp/berth.sock"),
                OsString::from("--startup-ready-fd"),
                OsString::from("3"),
            ]
            .into_iter(),
        )
        .expect("valid daemon args");

        assert_eq!(args.socket_path, Some(PathBuf::from("/tmp/berth.sock")));
        assert_eq!(args.startup_ready_fd, Some(3));
    }

    /// 配置文件加载已移除（SDK 启动 termd 从不传这些参数），旧参数按未知参数拒绝。
    #[test]
    fn daemon_parser_rejects_removed_config_flags() {
        let error = parse_daemon_args(
            [
                OsString::from(INTERNAL_DAEMON_FLAG),
                OsString::from("/tmp/berth.sock"),
                OsString::from("--config-file"),
                OsString::from("berth.conf"),
            ]
            .into_iter(),
        )
        .expect_err("config flags are no longer accepted");

        assert!(error.contains("--config-file"));
    }
}
