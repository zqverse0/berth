use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(windows)]
use crate::bootstrap::deadline::StartupDeadline;
use crate::bootstrap::discovery;
#[cfg(windows)]
use crate::diagnostics::FEATURE_TRANSPORT_UNIX_SOCKET;
#[cfg(unix)]
use crate::diagnostics::FEATURE_TRANSPORT_WINDOWS_PIPE;
use crate::transport::TransportClient;
use crate::{Result, TerminalEndpoint, TerminalError};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED,
};

const INTERNAL_DAEMON_FLAG: &str = "--__internal-daemon";
#[cfg(windows)]
const WINDOWS_CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(windows)]
const WINDOWS_STARTUP_READY_EVENT_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(unix)]
pub(super) async fn connect_transport(
    endpoint: &TerminalEndpoint,
    timeout: Option<Duration>,
) -> Result<TransportClient> {
    match endpoint {
        TerminalEndpoint::UnixSocket(path) => {
            let stream = timeout_io("connect to Berth terminal daemon", timeout, async {
                tokio::net::UnixStream::connect(path).await
            })
            .await?;
            Ok(TransportClient::spawn(stream))
        }
        TerminalEndpoint::WindowsPipe(_) => Err(TerminalError::unsupported(
            FEATURE_TRANSPORT_WINDOWS_PIPE,
            "use a Unix socket endpoint on Unix SDK builds",
        )),
        TerminalEndpoint::Default => Err(TerminalError::transport(
            "resolve Berth SDK endpoint",
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "default endpoint was not resolved before connecting",
            ),
        )),
    }
}

pub(crate) async fn connect_transport_to_endpoint(
    endpoint: &TerminalEndpoint,
    timeout: Option<Duration>,
) -> Result<TransportClient> {
    connect_transport(endpoint, timeout).await
}

pub(crate) async fn connect_or_start_transport(
    endpoint: &TerminalEndpoint,
    default_timeout: Option<Duration>,
    daemon_binary: Option<&Path>,
) -> Result<TransportClient> {
    connect_or_start_transport_for_platform(endpoint, default_timeout, daemon_binary).await
}

#[cfg(unix)]
async fn connect_or_start_transport_for_platform(
    endpoint: &TerminalEndpoint,
    default_timeout: Option<Duration>,
    daemon_binary: Option<&Path>,
) -> Result<TransportClient> {
    let timeout = startup_operation_timeout(default_timeout);
    let TerminalEndpoint::UnixSocket(socket_path) = endpoint else {
        return connect_transport(endpoint, timeout).await;
    };
    let socket_path = socket_path.clone();
    let daemon_binary = daemon_binary.map(Path::to_path_buf);
    let outcome = crate::bootstrap::startup_unix::connect_or_start_with_timeout(
        &socket_path,
        || {
            let socket_path = socket_path.clone();
            let daemon_binary = daemon_binary.clone();
            async move { spawn_hidden_daemon(socket_path.as_os_str(), daemon_binary.as_deref()) }
        },
        timeout,
        crate::bootstrap::startup_unix::STARTUP_POLL_INTERVAL,
    )
    .await
    .map_err(startup_error)?;
    Ok(TransportClient::spawn(outcome.into_stream()))
}

#[cfg(windows)]
async fn connect_or_start_transport_for_platform(
    endpoint: &TerminalEndpoint,
    default_timeout: Option<Duration>,
    daemon_binary: Option<&Path>,
) -> Result<TransportClient> {
    let timeout = startup_operation_timeout(default_timeout);
    let startup_deadline = StartupDeadline::from_timeout(timeout);
    let TerminalEndpoint::WindowsPipe(pipe) = endpoint else {
        return connect_transport(endpoint, timeout).await;
    };
    let pipe_path = std::path::PathBuf::from(pipe);
    let daemon_binary = daemon_binary.map(Path::to_path_buf);
    let outcome = crate::bootstrap::startup_windows::connect_or_start_with_timeout(
        &pipe_path,
        || {
            let pipe_path = pipe_path.clone();
            let daemon_binary = daemon_binary.clone();
            async move { spawn_hidden_daemon(pipe_path.as_os_str(), daemon_binary.as_deref()) }
        },
        startup_deadline.requested_timeout(),
        crate::bootstrap::startup_windows::STARTUP_POLL_INTERVAL,
    )
    .await
    .map_err(startup_error)?;
    // Windows startup probes use a blocking client stream owned by a private
    // Tokio runtime. The SDK transport actor must own an async pipe client on
    // the caller's runtime, so reconnect here with the same configured retry
    // budget instead of using a raw one-shot open. Reuse only the remaining
    // startup budget so connect_or_start never becomes startup timeout plus
    // another full connect timeout.
    drop_windows_startup_probe_stream(outcome).await?;
    connect_transport(endpoint, startup_deadline.remaining_timeout()).await
}

#[cfg(windows)]
async fn drop_windows_startup_probe_stream(
    outcome: crate::bootstrap::startup_windows::StartupOutcome,
) -> Result<()> {
    tokio::task::spawn_blocking(move || drop(outcome))
        .await
        .map_err(|error| {
            TerminalError::transport(
                "release Windows startup probe stream",
                io::Error::other(error.to_string()),
            )
        })
}

#[cfg(not(any(unix, windows)))]
async fn connect_or_start_transport_for_platform(
    endpoint: &TerminalEndpoint,
    default_timeout: Option<Duration>,
    daemon_binary: Option<&Path>,
) -> Result<TransportClient> {
    connect_transport(endpoint, startup_operation_timeout(default_timeout)).await
}

pub(super) fn startup_operation_timeout(default_timeout: Option<Duration>) -> Option<Duration> {
    discovery::resolve_timeout(None, default_timeout)
}

fn spawn_hidden_daemon(endpoint: &OsStr, daemon_binary: Option<&Path>) -> io::Result<()> {
    let candidates = hidden_daemon_binary_candidates(daemon_binary);
    let mut last_error = None;
    for (index, binary) in candidates.iter().enumerate() {
        let result = match spawn_hidden_daemon_with_binary(endpoint, binary, true) {
            Ok(()) => return Ok(()),
            Err(error)
                if berth_term_os::daemon::should_retry_hidden_daemon_without_breakaway(&error) =>
            {
                spawn_hidden_daemon_with_binary(endpoint, binary, false)
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => return Ok(()),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound && index + 1 < candidates.len() =>
            {
                last_error = Some(error);
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                last_error = Some(error);
                break;
            }
            Err(error) => return Err(error),
        }
    }

    Err(hidden_daemon_not_found_error(&candidates, last_error))
}

fn spawn_hidden_daemon_with_binary(
    endpoint: &OsStr,
    binary: &OsStr,
    allow_job_breakaway: bool,
) -> io::Result<()> {
    #[cfg(windows)]
    let ready = berth_term_os::daemon::StartupReadyEvent::new()?;
    let mut command = Command::new(binary);
    command
        .arg(INTERNAL_DAEMON_FLAG)
        .arg(endpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.arg("--startup-ready-event").arg(ready.name());
    berth_term_os::daemon::configure_hidden_daemon_command(&mut command, allow_job_breakaway);
    let child = berth_term_os::daemon::spawn_hidden_daemon_command(&mut command)?;
    drop(child);
    #[cfg(windows)]
    {
        let _ = ready.wait(WINDOWS_STARTUP_READY_EVENT_TIMEOUT);
    }
    Ok(())
}

#[cfg(feature = "available")]
pub(super) fn cli_binary() -> OsString {
    std::env::var_os(discovery::SDK_CLI_BINARY_ENV)
        .or_else(|| resolve_executable_on_path("berth").map(|path| path.into_os_string()))
        .unwrap_or_else(|| "berth".into())
}

fn hidden_daemon_binary_candidates(daemon_binary: Option<&Path>) -> Vec<OsString> {
    let explicit = daemon_binary.map(|path| path.as_os_str().to_owned());
    hidden_daemon_binary_candidates_from_sources(
        explicit.or_else(|| std::env::var_os(discovery::SDK_DAEMON_BINARY_ENV)),
        resolve_executable_on_path("berth").or_else(|| resolve_executable_on_path("berth-cli")),
    )
}

#[cfg(test)]
fn hidden_daemon_binary_candidates_from_env(override_binary: Option<OsString>) -> Vec<OsString> {
    hidden_daemon_binary_candidates_from_sources(override_binary, None)
}

fn hidden_daemon_binary_candidates_from_sources(
    override_binary: Option<OsString>,
    public_binary: Option<PathBuf>,
) -> Vec<OsString> {
    let resolved_public_binary = public_binary
        .as_deref()
        .and_then(|path| std::fs::canonicalize(path).ok());
    let client_binary = std::env::current_exe().ok();
    let resolved_client_binary = client_binary
        .as_deref()
        .and_then(|path| std::fs::canonicalize(path).ok());
    hidden_daemon_binary_candidates_from_sources_with_resolved(
        override_binary,
        public_binary,
        resolved_public_binary.as_deref(),
        client_binary.as_deref(),
        resolved_client_binary.as_deref(),
    )
}

fn hidden_daemon_binary_candidates_from_sources_with_resolved(
    override_binary: Option<OsString>,
    public_binary: Option<PathBuf>,
    resolved_public_binary: Option<&Path>,
    client_binary: Option<&Path>,
    resolved_client_binary: Option<&Path>,
) -> Vec<OsString> {
    if let Some(binary) = override_binary {
        return vec![binary];
    }

    let mut candidates = Vec::new();
    // 守护进程已内置进 `berth` / `berth-cli`：当前客户端本身就是 CLI 时直接复用自身，
    // 让无头服务器只需单个 `berth` 二进制即可自拉起守护进程。
    push_self_daemon_candidate(&mut candidates, client_binary);
    push_self_daemon_candidate(&mut candidates, resolved_client_binary);
    // 非 CLI 宿主（如 GUI 或第三方 SDK 调用方）优先找同目录的 `berth-cli` / `berth`。
    push_client_sibling_candidates(&mut candidates, client_binary);
    push_client_sibling_candidates(&mut candidates, resolved_client_binary);
    if let Some(public_binary) = public_binary.as_deref() {
        push_public_daemon_candidates(&mut candidates, public_binary, resolved_public_binary);
    }
    push_unique_candidate(&mut candidates, OsString::from("berth"));
    push_unique_candidate(&mut candidates, OsString::from("berth-cli"));
    push_unique_candidate(&mut candidates, OsString::from("berth-termd"));
    candidates
}

fn is_embedded_daemon_cli_stem(file_stem: &str) -> bool {
    file_stem == "berth" || file_stem == "berth-cli" || file_stem.starts_with("berth-cli-")
}

fn is_non_empty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

fn push_self_daemon_candidate(candidates: &mut Vec<OsString>, client_binary: Option<&Path>) {
    let Some(binary) = client_binary else {
        return;
    };
    let Some(file_stem) = binary.file_stem().and_then(|stem| stem.to_str()) else {
        return;
    };
    if is_embedded_daemon_cli_stem(file_stem) && is_non_empty_file(binary) {
        push_unique_candidate(candidates, binary.as_os_str().to_os_string());
    }
}

/// Resolves daemon-capable CLI binaries sitting next to a non-CLI client executable.
fn push_client_sibling_candidates(candidates: &mut Vec<OsString>, client_binary: Option<&Path>) {
    let Some(binary) = client_binary else {
        return;
    };
    let Some(file_stem) = binary.file_stem().and_then(|stem| stem.to_str()) else {
        return;
    };
    if is_embedded_daemon_cli_stem(file_stem) || file_stem == "berth-termd" {
        return;
    }
    for stem in ["berth-cli", "berth", "berth-termd"] {
        if let Some(sibling) = sibling_binary_path(binary, stem) {
            if is_non_empty_file(&sibling) {
                push_unique_candidate(candidates, sibling.into_os_string());
            }
        }
    }
}

fn push_public_daemon_candidates(
    candidates: &mut Vec<OsString>,
    public_binary: &Path,
    resolved_binary: Option<&Path>,
) {
    if is_non_empty_file(public_binary) {
        push_unique_candidate(candidates, public_binary.as_os_str().to_os_string());
    }
    if let Some(resolved) = resolved_binary {
        if is_non_empty_file(resolved) {
            push_unique_candidate(candidates, resolved.as_os_str().to_os_string());
        }
    }
}

fn sibling_binary_path(binary: &Path, stem: &str) -> Option<PathBuf> {
    let mut candidate = binary.to_path_buf();
    let file_name = match binary.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if !extension.is_empty() => format!("{stem}.{extension}"),
        _ => stem.to_owned(),
    };
    candidate.set_file_name(file_name);
    candidate.is_file().then_some(candidate)
}

fn push_unique_candidate(candidates: &mut Vec<OsString>, candidate: OsString) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

fn resolve_executable_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for file_name in executable_file_names(name) {
            let candidate = directory.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn executable_file_names(name: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        let mut names = vec![OsString::from(name)];
        if Path::new(name).extension().is_none() {
            let pathext =
                std::env::var_os("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
            for extension in pathext.to_string_lossy().split(';') {
                if extension.is_empty() {
                    continue;
                }
                let normalized = if extension.starts_with('.') {
                    extension.to_owned()
                } else {
                    format!(".{extension}")
                };
                names.push(OsString::from(format!("{name}{normalized}")));
            }
        }
        names
    }
    #[cfg(not(windows))]
    {
        vec![OsString::from(name)]
    }
}

fn hidden_daemon_not_found_error(
    candidates: &[OsString],
    last_error: Option<io::Error>,
) -> io::Error {
    let candidates = candidates
        .iter()
        .map(|candidate| candidate.to_string_lossy())
        .collect::<Vec<_>>()
        .join(", ");
    let mut message = format!(
        "no Berth terminal daemon binary candidate was available; tried [{candidates}]. \
         Install Berth, ensure berth is on PATH, or set {} to an absolute Berth CLI/daemon path",
        discovery::SDK_DAEMON_BINARY_ENV
    );
    if let Some(error) = last_error {
        message.push_str(&format!("; last error: {error}"));
    }
    io::Error::new(io::ErrorKind::NotFound, message)
}

fn startup_error(error: impl fmt::Display) -> TerminalError {
    TerminalError::transport(
        "connect or start Berth terminal daemon",
        io::Error::other(error.to_string()),
    )
}

#[cfg(windows)]
pub(super) async fn connect_transport(
    endpoint: &TerminalEndpoint,
    timeout: Option<Duration>,
) -> Result<TransportClient> {
    match endpoint {
        TerminalEndpoint::WindowsPipe(pipe) => {
            let stream = connect_windows_pipe(pipe, timeout).await?;
            Ok(TransportClient::spawn(stream))
        }
        TerminalEndpoint::UnixSocket(_) => Err(TerminalError::unsupported(
            FEATURE_TRANSPORT_UNIX_SOCKET,
            "use a Windows named-pipe endpoint on Windows SDK builds",
        )),
        TerminalEndpoint::Default => Err(TerminalError::transport(
            "resolve Berth SDK endpoint",
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "default endpoint was not resolved before connecting",
            ),
        )),
    }
}

#[cfg(windows)]
async fn connect_windows_pipe(pipe: &str, timeout: Option<Duration>) -> Result<NamedPipeClient> {
    let deadline = StartupDeadline::from_timeout(timeout);
    loop {
        match ClientOptions::new().open(std::path::Path::new(pipe)) {
            Ok(stream) => return Ok(stream),
            Err(error) if windows_pipe_connect_retryable(&error) => {
                if deadline.is_elapsed() {
                    return Err(TerminalError::transport(
                        "connect to Berth terminal daemon",
                        timeout_error(
                            "connect to Berth terminal daemon",
                            deadline.requested_timeout().unwrap_or(Duration::MAX),
                        ),
                    ));
                }
                tokio::time::sleep(deadline.sleep_for(WINDOWS_CONNECT_RETRY_INTERVAL)).await;
            }
            Err(error) => {
                return Err(TerminalError::transport(
                    "connect to Berth terminal daemon",
                    error,
                ))
            }
        }
    }
}

#[cfg(windows)]
pub(super) fn windows_pipe_connect_retryable(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code)
            if code == ERROR_PIPE_BUSY as i32
                || code == ERROR_PIPE_NOT_CONNECTED as i32
                || code == ERROR_NO_DATA as i32
                || code == ERROR_FILE_NOT_FOUND as i32
    )
}

#[cfg(not(any(unix, windows)))]
pub(super) async fn connect_transport(
    _endpoint: &TerminalEndpoint,
    _timeout: Option<Duration>,
) -> Result<TransportClient> {
    Err(TerminalError::unsupported(
        "transport.local_ipc",
        "this target does not support Berth local IPC transports",
    ))
}

#[cfg(unix)]
async fn timeout_io<F, T>(
    operation: &'static str,
    timeout: Option<Duration>,
    future: F,
) -> Result<T>
where
    F: std::future::Future<Output = io::Result<T>>,
{
    match timeout {
        Some(timeout) => tokio::time::timeout(timeout, future)
            .await
            .map_err(|_| TerminalError::transport(operation, timeout_error(operation, timeout)))?
            .map_err(|error| TerminalError::transport(operation, error)),
        None => future
            .await
            .map_err(|error| TerminalError::transport(operation, error)),
    }
}

#[cfg(any(unix, windows))]
fn timeout_error(operation: &str, timeout: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!(
            "timed out after {}s while {operation}",
            timeout.as_secs_f32()
        ),
    )
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        hidden_daemon_binary_candidates_from_env, hidden_daemon_binary_candidates_from_sources,
        hidden_daemon_binary_candidates_from_sources_with_resolved, hidden_daemon_not_found_error,
    };

    fn temp_root(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "berth-term-sdk-daemon-candidate-{name}-{}-{timestamp}",
            std::process::id()
        ))
    }

    fn default_path_fallbacks() -> Vec<OsString> {
        vec![
            OsString::from("berth"),
            OsString::from("berth-cli"),
            OsString::from("berth-termd"),
        ]
    }

    #[test]
    fn hidden_daemon_spawn_falls_back_to_berth_on_path() {
        assert_eq!(
            hidden_daemon_binary_candidates_from_env(None),
            default_path_fallbacks()
        );
    }

    #[test]
    fn hidden_daemon_spawn_honors_explicit_sdk_binary_override() {
        assert_eq!(
            hidden_daemon_binary_candidates_from_env(Some(OsString::from("/tmp/custom-rmux"))),
            vec![OsString::from("/tmp/custom-rmux")]
        );
    }

    #[test]
    fn hidden_daemon_spawn_uses_public_berth_binary() {
        let root = temp_root("public-berth");
        std::fs::create_dir_all(&root).expect("create root");
        let public = root.join("berth");
        std::fs::write(&public, b"berth").expect("write public");

        let mut expected = vec![public.as_os_str().to_os_string()];
        if let Ok(resolved) = std::fs::canonicalize(&public) {
            let candidate = resolved.into_os_string();
            if !expected.contains(&candidate) {
                expected.push(candidate);
            }
        }
        expected.extend(default_path_fallbacks());

        assert_eq!(
            hidden_daemon_binary_candidates_from_sources(None, Some(public)),
            expected
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_daemon_spawn_uses_resolved_public_binary() {
        let root = temp_root("resolved-public");
        let links = root.join("links");
        let package = root.join("package");
        std::fs::create_dir_all(&links).expect("create links");
        std::fs::create_dir_all(&package).expect("create package");
        let alias = links.join("berth");
        let public = package.join("berth-cli");
        std::fs::write(&alias, b"alias").expect("write alias");
        std::fs::write(&public, b"cli").expect("write public");

        let mut expected = vec![
            alias.as_os_str().to_os_string(),
            public.as_os_str().to_os_string(),
        ];
        expected.extend(default_path_fallbacks());

        assert_eq!(
            hidden_daemon_binary_candidates_from_sources_with_resolved(
                None,
                Some(alias),
                Some(&public),
                None,
                None,
            ),
            expected
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_daemon_spawn_reexecs_standalone_berth_cli_directly() {
        let root = temp_root("standalone-cli");
        std::fs::create_dir_all(&root).expect("create root");
        let client = root.join("berth");
        std::fs::write(&client, b"cli").expect("write client");

        let mut expected = vec![client.as_os_str().to_os_string()];
        expected.extend(default_path_fallbacks());

        assert_eq!(
            hidden_daemon_binary_candidates_from_sources_with_resolved(
                None,
                None,
                None,
                Some(&client),
                None,
            ),
            expected
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_daemon_spawn_prefers_sibling_berth_cli_for_non_cli_host() {
        let root = temp_root("gui-sibling");
        std::fs::create_dir_all(&root).expect("create root");
        let gui = root.join("berth-gui");
        let cli = root.join("berth-cli");
        std::fs::write(&gui, b"gui").expect("write gui");
        std::fs::write(&cli, b"cli").expect("write cli");

        let mut expected = vec![cli.as_os_str().to_os_string()];
        expected.extend(default_path_fallbacks());

        assert_eq!(
            hidden_daemon_binary_candidates_from_sources_with_resolved(
                None,
                None,
                None,
                Some(&gui),
                None,
            ),
            expected
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_daemon_spawn_ignores_empty_client_placeholder() {
        let root = temp_root("client-empty-placeholder");
        std::fs::create_dir_all(&root).expect("create root");
        let gui = root.join("berth-gui");
        let cli = root.join("berth-cli");
        std::fs::write(&gui, b"gui").expect("write gui");
        std::fs::write(&cli, []).expect("write empty placeholder");

        assert_eq!(
            hidden_daemon_binary_candidates_from_sources_with_resolved(
                None,
                None,
                None,
                Some(&gui),
                None,
            ),
            default_path_fallbacks()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_daemon_spawn_reexecs_resolved_symlinked_cli() {
        let root = temp_root("resolved-client-cli");
        let links = root.join("links");
        let package = root.join("package");
        std::fs::create_dir_all(&links).expect("create links");
        std::fs::create_dir_all(&package).expect("create package");
        let alias = links.join("berth");
        let client = package.join("berth-cli-x86_64-unknown-linux-gnu");
        std::fs::write(&alias, b"alias").expect("write alias");
        std::fs::write(&client, b"cli").expect("write client");

        let mut expected = vec![
            alias.as_os_str().to_os_string(),
            client.as_os_str().to_os_string(),
        ];
        expected.extend(default_path_fallbacks());

        assert_eq!(
            hidden_daemon_binary_candidates_from_sources_with_resolved(
                None,
                None,
                None,
                Some(&alias),
                Some(&client),
            ),
            expected
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_daemon_not_found_error_mentions_env_override() {
        let error = hidden_daemon_not_found_error(&[OsString::from("berth")], None);
        let message = error.to_string();

        assert!(message.contains("berth"));
        assert!(message.contains("BERTH_SDK_DAEMON_BINARY"));
    }
}
