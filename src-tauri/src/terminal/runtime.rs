//! Berth terminal executor and daemon connection boundary.

use std::any::Any;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{mpsc, Arc};
use std::thread;

use berth_term_sdk::berth::Terminal;
use tokio::sync::mpsc as tokio_mpsc;

use super::terminal_manager::{terminal_error_from_sdk, TerminalSessionManager};
use crate::terminal::error::TerminalError;

const BERTH_TERM_EXECUTOR_QUEUE_CAPACITY: usize = 64;

pub(super) type TerminalOperationResult = Result<Box<dyn Any + Send>, TerminalError>;
pub(super) type TerminalOperationFuture =
    Pin<Box<dyn Future<Output = TerminalOperationResult> + 'static>>;
pub(super) type TerminalOperation =
    Box<dyn FnOnce(Arc<Terminal>) -> TerminalOperationFuture + Send + 'static>;
pub(super) type TerminalOperationErrorCallback = Box<dyn FnOnce(String) + Send + 'static>;

pub(super) struct TerminalOperationJob {
    pub(super) start_daemon: bool,
    pub(super) operation: TerminalOperation,
    pub(super) reply: mpsc::SyncSender<TerminalOperationResult>,
    pub(super) on_error: Option<TerminalOperationErrorCallback>,
}

/// Owns one Tokio runtime and one long-lived Berth terminal transport for synchronous
/// Berth callers. The public terminal API is intentionally synchronous at the
/// adapter edge, so keeping this executor private avoids creating a thread,
/// runtime, and IPC connection for every keystroke or resize. The async job
/// queue also keeps the Berth terminal SDK transport actor schedulable while idle.
pub(super) struct TerminalExecutor {
    jobs: tokio_mpsc::Sender<TerminalOperationJob>,
}

impl TerminalExecutor {
    fn new(endpoint: PathBuf, daemon_binary: Option<PathBuf>) -> Self {
        let (jobs, receiver) =
            tokio_mpsc::channel::<TerminalOperationJob>(BERTH_TERM_EXECUTOR_QUEUE_CAPACITY);
        let _ = thread::Builder::new()
            .name("berth-term-executor".to_string())
            .spawn(move || {
                let mut receiver = receiver;
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let failure = TerminalError::SpawnFailed(error.to_string());
                        while let Some(mut job) = receiver.blocking_recv() {
                            if let Some(on_error) = job.on_error.take() {
                                on_error(failure.to_string());
                            }
                            let _ = job
                                .reply
                                .send(Err(TerminalError::SpawnFailed(failure.to_string())));
                        }
                        return;
                    }
                };

                runtime.block_on(run_terminal_executor(receiver, endpoint, daemon_binary));
            });
        Self { jobs }
    }

    fn submit(&self, job: TerminalOperationJob) -> Result<(), TerminalError> {
        self.jobs.try_send(job).map_err(|error| match error {
            tokio_mpsc::error::TrySendError::Full(_) => TerminalError::InputBackpressure,
            tokio_mpsc::error::TrySendError::Closed(_) => {
                TerminalError::RuntimeUnavailable("Berth terminal executor stopped".to_string())
            }
        })
    }
}

impl TerminalSessionManager {
    fn executor(&self) -> Arc<TerminalExecutor> {
        self.inner
            .executor
            .get_or_init(|| {
                Arc::new(TerminalExecutor::new(
                    self.inner.endpoint.clone(),
                    self.inner.daemon_binary.clone(),
                ))
            })
            .clone()
    }

    pub(super) fn execute<T, F, Fut>(
        &self,
        start_daemon: bool,
        terminal_id: Option<String>,
        operation: F,
    ) -> Result<T, TerminalError>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Terminal>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, berth_term_sdk::berth::TerminalError>> + 'static,
    {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let error_terminal_id = terminal_id.clone();
        let operation: TerminalOperation = Box::new(move |terminal| {
            Box::pin(async move {
                operation(terminal)
                    .await
                    .map(|value| Box::new(value) as Box<dyn Any + Send>)
                    .map_err(|error| terminal_error_from_sdk(error, error_terminal_id.as_deref()))
            })
        });
        let executor = self.executor();
        executor.submit(TerminalOperationJob {
            start_daemon,
            operation,
            reply: reply_tx,
            on_error: None,
        })?;

        let value = reply_rx.recv().map_err(|_| {
            TerminalError::RuntimeUnavailable("Berth terminal executor stopped".to_string())
        })??;
        value.downcast::<T>().map(|value| *value).map_err(|_| {
            TerminalError::SpawnFailed(
                "Berth terminal operation returned an invalid result".to_string(),
            )
        })
    }

    /// Enqueues a fire-and-forget Berth terminal operation and returns once the bounded
    /// executor accepts it. The callback receives failures that happen after
    /// enqueue, so callers can fence the attachment instead of retrying
    /// ambiguous terminal input.
    pub(super) fn enqueue<F, Fut>(
        &self,
        start_daemon: bool,
        terminal_id: Option<String>,
        operation: F,
        on_error: Option<TerminalOperationErrorCallback>,
    ) -> Result<(), TerminalError>
    where
        F: FnOnce(Arc<Terminal>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), berth_term_sdk::berth::TerminalError>> + 'static,
    {
        let (reply_tx, _reply_rx) = mpsc::sync_channel(1);
        let error_terminal_id = terminal_id.clone();
        let operation: TerminalOperation = Box::new(move |terminal| {
            Box::pin(async move {
                operation(terminal)
                    .await
                    .map(|()| Box::new(()) as Box<dyn Any + Send>)
                    .map_err(|error| terminal_error_from_sdk(error, error_terminal_id.as_deref()))
            })
        });
        self.executor().submit(TerminalOperationJob {
            start_daemon,
            operation,
            reply: reply_tx,
            on_error,
        })
    }
}

pub(super) async fn run_terminal_executor(
    mut receiver: tokio::sync::mpsc::Receiver<TerminalOperationJob>,
    endpoint: PathBuf,
    daemon_binary: Option<PathBuf>,
) {
    let mut connection: Option<Arc<Terminal>> = None;
    while let Some(mut job) = receiver.recv().await {
        if job.start_daemon {
            // Creation is the one operation allowed to bootstrap the daemon;
            // force a fresh handshake so a stale transport cannot mask a
            // daemon restart between terminal sessions.
            connection = None;
        }
        // daemon 重启后缓存连接已读到 EOF：先重连，让本次操作读到新 daemon 的 epoch，
        // 而不是在旧连接上报 RuntimeUnavailable。只是本地状态检查，不重试任何操作。
        if connection.as_ref().is_some_and(|terminal| terminal.is_transport_closed()) {
            connection = None;
        }
        if connection.is_none() {
            match connect_terminal_for_operation(job.start_daemon, &endpoint, daemon_binary.clone())
                .await
            {
                Ok(terminal) => connection = Some(Arc::new(terminal)),
                Err(error) => {
                    if let Some(on_error) = job.on_error.take() {
                        on_error(error.to_string());
                    }
                    let _ = job.reply.send(Err(error));
                    continue;
                }
            }
        }

        let terminal = connection
            .as_ref()
            .expect("terminal executor connection initialized")
            .clone();
        let result = (job.operation)(terminal).await;
        if matches!(result, Err(TerminalError::RuntimeUnavailable(_))) {
            connection = None;
        }
        if let (Some(on_error), Some(error)) = (
            job.on_error.take(),
            result.as_ref().err().map(ToString::to_string),
        ) {
            on_error(error);
        }
        let _ = job.reply.send(result);
    }
}

async fn connect_terminal_for_operation(
    start_daemon: bool,
    endpoint: &Path,
    daemon_binary: Option<PathBuf>,
) -> Result<Terminal, TerminalError> {
    let builder = Terminal::builder().unix_socket(endpoint.to_path_buf());
    let result = if start_daemon {
        let daemon_binary = daemon_binary
            .filter(|path| path.is_file())
            .or_else(resolve_terminald_binary)
            .ok_or_else(|| {
                TerminalError::SpawnFailed(
                    "berth-termd is not bundled beside the Berth runtime".to_string(),
                )
            })?;
        if !daemon_binary.is_file() {
            return Err(TerminalError::SpawnFailed(format!(
                "berth-termd was not found at {}",
                daemon_binary.display()
            )));
        }
        #[cfg(unix)]
        replace_stale_endpoint_daemon(endpoint, &daemon_binary);
        builder
            .daemon_binary(daemon_binary)
            .connect_or_start()
            .await
    } else {
        builder.connect().await
    };

    result.map_err(|error| terminal_error_from_sdk(error, None))
}

/// 旧包名 `berth-terminald` 升级为 `berth-termd` 后，已删除的二进制仍可能占着
/// default socket。`connect_or_start` 会直接加入，pane spawn 就走旧进程。
#[cfg(unix)]
fn replace_stale_endpoint_daemon(endpoint: &Path, expected_binary: &Path) {
    let expected_stem = expected_binary
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("berth-termd");
    let endpoint_text = endpoint.to_string_lossy();
    let self_pid = std::process::id();
    for pid in unix_process_ids() {
        if pid == self_pid {
            continue;
        }
        let Some(cmdline) = proc_cmdline(pid) else {
            continue;
        };
        if !cmdline.contains(endpoint_text.as_ref()) || !is_terminal_daemon_command(&cmdline) {
            continue;
        }
        let exe = proc_exe_link(pid).unwrap_or_default();
        if !daemon_exe_is_stale(&exe, expected_stem) {
            continue;
        }
        terminate_pid(pid);
    }
}

#[cfg(unix)]
fn is_terminal_daemon_command(cmdline: &str) -> bool {
    cmdline.contains("berth-termd") || cmdline.contains("berth-terminald")
}

#[cfg(unix)]
fn daemon_exe_is_stale(exe_link: &str, expected_stem: &str) -> bool {
    const DELETED_SUFFIX: &str = " (deleted)";
    let deleted = exe_link.ends_with(DELETED_SUFFIX);
    let path = exe_link.trim_end_matches(DELETED_SUFFIX);
    let leaf = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let stem = leaf.strip_suffix(".exe").unwrap_or(leaf);
    if stem == "berth-terminald" && expected_stem == "berth-termd" {
        return true;
    }
    deleted && matches!(stem, "berth-termd" | "berth-terminald")
}

#[cfg(unix)]
fn unix_process_ids() -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
        .collect()
}

#[cfg(unix)]
fn proc_cmdline(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(String::from_utf8_lossy(&raw).replace('\0', " "))
}

#[cfg(unix)]
fn proc_exe_link(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn terminate_pid(pid: u32) {
    let pid_text = pid.to_string();
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid_text])
        .status();
    for _ in 0..25 {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &pid_text])
        .status();
}

pub(super) fn resolve_terminald_binary() -> Option<PathBuf> {
    resolve_companion_binary("berth-termd", Some("BERTH_TERMINALD_PATH"))
}

/// 与 GUI 同版本的 berth-cli 二进制（sidecar）；`berth group` 的 GUI 回退用它。
pub(crate) fn resolve_cli_binary() -> Option<PathBuf> {
    resolve_companion_binary("berth-cli", None)
}

/// 只复用已存在的产品命令或 PATH shim，不把 berth-cli 冒充名为 berth 的入口。
pub(super) fn resolve_cli_command() -> Option<PathBuf> {
    let command_name = if cfg!(windows) { "berth.exe" } else { "berth" };
    // `tauri dev`（有 CARGO_MANIFEST_DIR）：先用本仓库刚 staging 的 berth；共享 target 目录与 PATH 上
    // 其他检出的 shim 可能是旧版，pane 里的 `berth` 会读不了 dev 库。
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map(|manifest| PathBuf::from(manifest).join("binaries").join(command_name))
        .and_then(|command| which::which(command).ok())
        .or_else(|| {
            resolve_companion_binary("berth-cli", None)
                .and_then(|binary| binary.parent().map(|parent| parent.join(command_name)))
                .and_then(|command| which::which(command).ok())
        })
        .or_else(|| which::which("berth").ok())
}

fn resolve_companion_binary(binary_name: &str, override_env: Option<&str>) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        format!("{binary_name}.exe")
    } else {
        binary_name.to_owned()
    };
    let sidecar_prefix = format!("{binary_name}-");
    let is_executable_file = |path: &Path| {
        let Ok(metadata) = std::fs::metadata(path) else {
            return false;
        };
        if !metadata.is_file() || metadata.len() == 0 {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            true
        }
    };

    if let Some(path) = override_env.and_then(std::env::var_os).map(PathBuf::from) {
        if is_executable_file(&path) {
            return Some(path);
        }
    }

    let current = std::env::current_exe().ok()?;
    if current
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem == binary_name)
    {
        return Some(current);
    }

    let mut candidates = Vec::new();
    for ancestor in current.parent().into_iter().flat_map(Path::ancestors) {
        candidates.push(ancestor.join(&filename));
        candidates.push(ancestor.join("resources").join(&filename));
        candidates.push(ancestor.join("binaries").join(&filename));

        let sidecar_dir = ancestor.join("binaries");
        if let Ok(entries) = std::fs::read_dir(sidecar_dir) {
            let mut sidecars = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with(&sidecar_prefix)
                                && (cfg!(windows) && name.ends_with(".exe")
                                    || !cfg!(windows) && !name.ends_with(".exe"))
                        })
                })
                .collect::<Vec<_>>();
            sidecars.sort();
            candidates.extend(sidecars);
        }
    }

    let mut fallback_roots = Vec::new();
    if let Some(manifest) = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from) {
        fallback_roots.push(manifest.clone());
        if let Some(parent) = manifest.parent() {
            fallback_roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        fallback_roots.push(cwd.join("src-tauri"));
        fallback_roots.push(cwd);
    }
    for root in fallback_roots {
        candidates.push(root.join(&filename));
        candidates.push(root.join("target").join("debug").join(&filename));
        candidates.push(root.join("target").join("release").join(&filename));
        candidates.push(root.join("binaries").join(&filename));
        let sidecar_dir = root.join("binaries");
        if let Ok(entries) = std::fs::read_dir(sidecar_dir) {
            let mut sidecars = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with(&sidecar_prefix)
                                && (cfg!(windows) && name.ends_with(".exe")
                                    || !cfg!(windows) && !name.ends_with(".exe"))
                        })
                })
                .collect::<Vec<_>>();
            sidecars.sort();
            candidates.extend(sidecars);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(&filename));
        }
    }

    candidates.into_iter().find(|path| is_executable_file(path))
}

#[cfg(all(test, unix))]
mod tests {
    use super::daemon_exe_is_stale;

    #[test]
    fn legacy_terminald_name_is_stale_after_rename() {
        assert!(daemon_exe_is_stale(
            "/usr/bin/berth-terminald",
            "berth-termd"
        ));
        assert!(daemon_exe_is_stale(
            "/usr/bin/berth-terminald (deleted)",
            "berth-termd"
        ));
    }

    #[test]
    fn deleted_current_daemon_is_stale() {
        assert!(daemon_exe_is_stale(
            "/usr/bin/berth-termd (deleted)",
            "berth-termd"
        ));
    }

    #[test]
    fn live_current_daemon_is_kept() {
        assert!(!daemon_exe_is_stale("/usr/bin/berth-termd", "berth-termd"));
    }
}
