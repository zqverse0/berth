//! Berth GUI 的本地 control socket。
//!
//! 监听器只协商共享线协议并分发 GUI、项目、文件打开与当前工作区查询；
//! handler 复用 Tauri command 的业务实现。长期交接入口
//! [`workspace_open_file_handoff`] 只供主窗口领取与回执 CLI `file.open` 请求。

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};

use berth_control_proto::{
    decode_frame, encode_response_frame, error_code, validate_request, ErrorKind, FileOpenState,
    GuiStatus, HelloParams, HelloResult, HelloServer, RpcRequest, RpcResponse,
    CAPABILITY_FILE_OPEN, CAPABILITY_FILE_OPEN_WAIT, CAPABILITY_GUI_STATUS, CAPABILITY_PROJECT,
    CAPABILITY_WORKSPACE_CURRENT_DOCUMENT, CAPABILITY_WORKSPACE_CURRENT_TERMINAL,
    CAPABILITY_WORKSPACE_DOCUMENT_RANGE, CAPABILITY_KNOWLEDGE_DIGEST, CAPABILITY_AGENT_CHANGED,
    CONTROL_WIRE_VERSION,
    MAX_FRAME_BYTES, METHOD_HELLO,
};
use berth_term_ipc::{
    connect_blocking, endpoint_for_label, LocalEndpoint, LocalListener, LocalStream, PeerIdentity,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod handlers;
mod pending;

pub(crate) use handlers::ControlDeps;

const GUI_ENDPOINT_ENV: &str = "BERTH_GUI_ENDPOINT";
const CONTROL_IO_TIMEOUT: Duration = Duration::from_secs(5);

/// GUI 当前选中的终端标签；只保存 ID，不保存 pane 地址或终端正文。
#[derive(Default)]
pub(crate) struct CurrentTerminalSelection(RwLock<Option<String>>);

impl CurrentTerminalSelection {
    pub(crate) fn get(&self) -> Option<String> {
        self.0.read().expect("terminal selection lock").clone()
    }

    pub(crate) fn clear(&self) {
        *self.0.write().expect("terminal selection lock") = None;
    }
}

/// 低频同步当前可见终端标签，隐藏时不接受旧的选中状态。
#[tauri::command]
pub(crate) fn set_current_workspace_terminal(
    window: tauri::WebviewWindow,
    selection: tauri::State<'_, CurrentTerminalSelection>,
    terminal_id: Option<String>,
) -> Result<(), crate::app_error::AppCommandError> {
    if window.label() != "main" {
        return Err(crate::app_error::AppCommandError::permission_denied(
            "only the main window may select a workspace terminal",
        ));
    }
    let terminal_id = if window.is_visible().unwrap_or(false) {
        terminal_id
    } else {
        None
    };
    if terminal_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 256 || id.trim() != id)
    {
        return Err(crate::app_error::AppCommandError::invalid_input(
            "terminal_id must be a non-empty bounded identifier",
        ));
    }
    *selection.0.write().expect("terminal selection lock") = terminal_id;
    if !window.is_visible().unwrap_or(false) {
        selection.clear();
    }
    Ok(())
}

#[cfg(unix)]
const SOCKET_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// 启动尽力可用的 GUI control listener。
///
/// 绑定失败只记录诊断，不阻止桌面应用继续启动。
pub(crate) fn spawn(
    db: crate::db::AppDatabase,
    emitter: crate::event_bridge::EventEmitter,
    app: tauri::AppHandle,
) {
    let mut context = ControlContext::current();
    context.deps = Some(ControlDeps {
        db: Arc::new(db),
        emitter,
        app,
    });
    tauri::async_runtime::spawn(async move {
        let endpoint = match resolve_gui_endpoint() {
            Ok(endpoint) => endpoint,
            Err(error) => {
                tracing::warn!("GUI control endpoint is invalid: {error}");
                return;
            }
        };

        let bound = match bind_endpoint(&endpoint) {
            Ok(bound) => bound,
            Err(error) => {
                tracing::warn!(endpoint = ?endpoint.as_path(), "GUI control listener unavailable: {error}");
                return;
            }
        };

        accept_loop(bound, context).await;
    });
}

/// Resolves the GUI endpoint from the explicit override or the per-user
/// default label.
pub(crate) fn resolve_gui_endpoint() -> io::Result<LocalEndpoint> {
    let Some(value) = std::env::var_os(GUI_ENDPOINT_ENV).filter(|value| !value.is_empty()) else {
        return endpoint_for_label("gui");
    };

    if value.to_string_lossy().contains("://") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "BERTH_GUI_ENDPOINT must be a local socket path or named pipe",
        ));
    }

    #[cfg(unix)]
    {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "BERTH_GUI_ENDPOINT must be an absolute Unix socket path",
            ));
        }
        return Ok(LocalEndpoint::from_path(path));
    }

    #[cfg(windows)]
    {
        let lower = value.to_string_lossy().to_ascii_lowercase();
        if !(lower.starts_with(r"\\.\pipe\") || lower.starts_with(r"\\?\pipe\")) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "BERTH_GUI_ENDPOINT must name a Windows local named pipe",
            ));
        }
        return Ok(LocalEndpoint::from_path(PathBuf::from(value)));
    }

    #[allow(unreachable_code)]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "GUI control endpoints are unsupported on this platform",
    ))
}

#[derive(Clone)]
struct ControlContext {
    version: String,
    pid: u32,
    capabilities: Vec<String>,
    deps: Option<ControlDeps>,
}

impl ControlContext {
    fn current() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: std::process::id(),
            capabilities: vec![
                CAPABILITY_GUI_STATUS.to_owned(),
                CAPABILITY_PROJECT.to_owned(),
                CAPABILITY_FILE_OPEN.to_owned(),
                CAPABILITY_FILE_OPEN_WAIT.to_owned(),
                CAPABILITY_WORKSPACE_CURRENT_DOCUMENT.to_owned(),
                CAPABILITY_WORKSPACE_DOCUMENT_RANGE.to_owned(),
                CAPABILITY_WORKSPACE_CURRENT_TERMINAL.to_owned(),
                CAPABILITY_KNOWLEDGE_DIGEST.to_owned(),
                CAPABILITY_AGENT_CHANGED.to_owned(),
            ],
            deps: None,
        }
    }

    fn hello_result(&self) -> HelloResult {
        HelloResult {
            wire_version: CONTROL_WIRE_VERSION,
            server: HelloServer {
                name: "berth-gui".to_owned(),
                version: self.version.clone(),
                pid: self.pid,
            },
            capabilities: self.capabilities.clone(),
        }
    }

    fn status(&self) -> GuiStatus {
        GuiStatus {
            version: self.version.clone(),
            pid: self.pid,
            wire_version: CONTROL_WIRE_VERSION,
            capabilities: self.capabilities.clone(),
        }
    }
}

async fn accept_loop(bound: BoundControl, context: ControlContext) {
    let BoundControl { listener, cleanup } = bound;
    let _cleanup = cleanup;
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let context = context.clone();
                tauri::async_runtime::spawn(async move {
                    handle_connection(stream, peer, context).await;
                });
            }
            Err(error) => {
                tracing::warn!("GUI control accept failed: {error}");
                // Avoid a hot loop if the platform listener temporarily
                // reports an error.  A later accept may still recover it.
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle_connection(mut stream: LocalStream, peer: PeerIdentity, context: ControlContext) {
    if !peer_is_authorized(&peer) {
        tracing::warn!(peer = ?peer, "rejected GUI control peer from another user");
        return;
    }

    let hello = match read_request(&mut stream).await {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(error) => {
            tracing::debug!("GUI control hello frame rejected: {error}");
            return;
        }
    };

    if let Err(kind) = validate_request(&hello) {
        let _ = send_error(&mut stream, hello.id, kind, "invalid hello request").await;
        return;
    }
    if hello.method != METHOD_HELLO {
        let _ = send_error(
            &mut stream,
            hello.id,
            ErrorKind::MethodNotFound,
            "first control request must be berth.hello",
        )
        .await;
        return;
    }

    let hello_params: HelloParams = match serde_json::from_value(hello.params) {
        Ok(params) => params,
        Err(error) => {
            let _ = send_error(
                &mut stream,
                hello.id,
                ErrorKind::InvalidParams,
                format!("invalid hello parameters: {error}"),
            )
            .await;
            return;
        }
    };
    if hello_params.wire_version != CONTROL_WIRE_VERSION {
        let _ = send_error(
            &mut stream,
            hello.id,
            ErrorKind::IncompatibleVersion,
            format!(
                "unsupported control wire version {}; server supports {}",
                hello_params.wire_version, CONTROL_WIRE_VERSION
            ),
        )
        .await;
        return;
    }

    let hello_response = match RpcResponse::success(hello.id, &context.hello_result()) {
        Ok(response) => response,
        Err(error) => {
            tracing::error!("failed to encode GUI control hello response: {error}");
            return;
        }
    };
    if send_response(&mut stream, &hello_response).await.is_err() {
        return;
    }

    loop {
        match read_request(&mut stream).await {
            Ok(Some(request)) => {
                let response = dispatch_request(&request, &context).await;
                if send_response(&mut stream, &response).await.is_err() {
                    return;
                }
            }
            Ok(None) => return,
            Err(error) => {
                tracing::debug!("GUI control frame rejected: {error}");
                return;
            }
        }
    }
}

/// 分发单个控制请求。未知方法返回 `method_not_found` 而不是断开，
/// 这样同一连接可以继续发后续请求。
async fn dispatch_request(request: &RpcRequest, context: &ControlContext) -> RpcResponse {
    if let Err(kind) = validate_request(request) {
        return RpcResponse::failure(
            request.id,
            error_code(kind),
            "invalid control request",
            kind,
        );
    }
    let result = match request.method.as_str() {
        berth_control_proto::METHOD_GUI_STATUS => handlers::gui_status(request, context),
        berth_control_proto::METHOD_PROJECT_LIST => handlers::project_list(request, context).await,
        berth_control_proto::METHOD_PROJECT_ADD => handlers::project_add(request, context).await,
        berth_control_proto::METHOD_FILE_OPEN => handlers::file_open(request, context).await,
        berth_control_proto::METHOD_WORKSPACE_CURRENT_DOCUMENT => {
            handlers::workspace_current_document(request, context).await
        }
        berth_control_proto::METHOD_WORKSPACE_CURRENT_TERMINAL => {
            handlers::workspace_current_terminal(request, context).await
        }
        berth_control_proto::METHOD_KNOWLEDGE_DIGEST => {
            handlers::knowledge_digest(request, context).await
        }
        berth_control_proto::METHOD_AGENT_CHANGED => handlers::agent_changed(context),
        _ => {
            return RpcResponse::failure(
                request.id,
                error_code(ErrorKind::MethodNotFound),
                format!("unknown control method {}", request.method),
                ErrorKind::MethodNotFound,
            );
        }
    };
    match result {
        Ok(value) => RpcResponse::success(request.id, &value).unwrap_or_else(|error| {
            RpcResponse::failure(
                request.id,
                error_code(ErrorKind::Internal),
                format!("failed to encode control response: {error}"),
                ErrorKind::Internal,
            )
        }),
        Err(kind_message) => {
            let (kind, message) = kind_message;
            RpcResponse::failure(request.id, error_code(kind), message, kind)
        }
    }
}

async fn read_request(stream: &mut LocalStream) -> Result<Option<RpcRequest>, ControlIoError> {
    let frame = tokio::time::timeout(CONTROL_IO_TIMEOUT, read_frame(stream))
        .await
        .map_err(|_| ControlIoError::Timeout)??;
    let Some(frame) = frame else {
        return Ok(None);
    };
    decode_frame(&frame)
        .map(Some)
        .map_err(ControlIoError::Frame)
}

async fn read_frame(stream: &mut LocalStream) -> Result<Option<Vec<u8>>, ControlIoError> {
    let mut frame = Vec::with_capacity(256);
    loop {
        let mut byte = [0_u8; 1];
        let count = stream.read(&mut byte).await.map_err(ControlIoError::Io)?;
        if count == 0 {
            if frame.is_empty() {
                return Ok(None);
            }
            return Err(ControlIoError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "control peer closed before newline delimiter",
            )));
        }
        frame.push(byte[0]);
        if frame.len() > MAX_FRAME_BYTES {
            return Err(ControlIoError::Frame(
                berth_control_proto::FrameError::TooLarge {
                    actual: frame.len(),
                    maximum: MAX_FRAME_BYTES,
                },
            ));
        }
        if byte[0] == b'\n' {
            return Ok(Some(frame));
        }
    }
}

async fn send_response(
    stream: &mut LocalStream,
    response: &RpcResponse,
) -> Result<(), ControlIoError> {
    let frame = encode_response_frame(response).map_err(ControlIoError::Frame)?;
    tokio::time::timeout(CONTROL_IO_TIMEOUT, async {
        stream.write_all(&frame).await?;
        stream.flush().await
    })
    .await
    .map_err(|_| ControlIoError::Timeout)?
    .map_err(ControlIoError::Io)
}

async fn send_error(
    stream: &mut LocalStream,
    id: u64,
    kind: ErrorKind,
    message: impl Into<String>,
) -> Result<(), ControlIoError> {
    let response = RpcResponse::failure(id, error_code(kind), message, kind);
    send_response(stream, &response).await
}

fn peer_is_authorized(peer: &PeerIdentity) -> bool {
    #[cfg(unix)]
    {
        return peer.uid == berth_term_os::identity::real_user_id();
    }
    #[cfg(windows)]
    {
        // `LocalListener` creates a same-user security descriptor and the
        // client validates the server SID.  The shared PeerIdentity.uid is a
        // synthetic zero on Windows and must not be used for authorization.
        let _ = peer;
        return true;
    }
    #[allow(unreachable_code)]
    true
}

#[derive(Debug)]
enum ControlIoError {
    Io(io::Error),
    Timeout,
    Frame(berth_control_proto::FrameError),
}

impl std::fmt::Display for ControlIoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Timeout => formatter.write_str("control I/O timed out"),
            Self::Frame(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ControlIoError {}

struct BoundControl {
    listener: LocalListener,
    #[cfg(unix)]
    cleanup: SocketCleanup,
    #[cfg(windows)]
    cleanup: NoopCleanup,
}

fn bind_endpoint(endpoint: &LocalEndpoint) -> io::Result<BoundControl> {
    #[cfg(unix)]
    {
        return bind_unix_endpoint(endpoint);
    }
    #[cfg(windows)]
    {
        let listener = LocalListener::bind(endpoint)?;
        return Ok(BoundControl {
            listener,
            cleanup: NoopCleanup,
        });
    }
    #[allow(unreachable_code)]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "GUI control endpoints are unsupported on this platform",
    ))
}

#[cfg(windows)]
#[derive(Debug)]
struct NoopCleanup;

#[cfg(windows)]
impl Drop for NoopCleanup {
    fn drop(&mut self) {}
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SocketIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
#[derive(Debug)]
struct SocketCleanup {
    path: PathBuf,
    identity: SocketIdentity,
}

#[cfg(unix)]
impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let Ok(metadata) = std::fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_symlink()
            || !metadata.file_type().is_socket()
            || metadata.uid() != berth_term_os::identity::real_user_id()
        {
            return;
        }
        let identity = SocketIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        if identity == self.identity {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn bind_unix_endpoint(endpoint: &LocalEndpoint) -> io::Result<BoundControl> {
    let path = endpoint.as_path();
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "GUI control socket '{}' has no parent directory",
                path.display()
            ),
        )
    })?;
    ensure_socket_parent(parent)?;
    prepare_socket_path(path)?;

    let listener = LocalListener::bind(endpoint)?;
    let identity = match socket_identity_at(path) {
        Ok(identity) => identity,
        Err(error) => {
            drop(listener);
            return Err(error);
        }
    };
    if let Err(error) = enforce_socket_permissions(path, identity) {
        // The listener has just created this inode.  Release it before trying
        // to remove the path, and only remove the same inode; a concurrent
        // replacement must be left untouched.
        drop(listener);
        remove_socket_if_identity_matches(path, identity);
        return Err(error);
    }
    Ok(BoundControl {
        listener,
        cleanup: SocketCleanup {
            path: path.to_path_buf(),
            identity,
        },
    })
}

#[cfg(unix)]
fn socket_identity_at(path: &Path) -> io::Result<SocketIdentity> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("GUI control path '{}' is not a Unix socket", path.display()),
        ));
    }
    if metadata.uid() != berth_term_os::identity::real_user_id() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "GUI control socket '{}' has unsafe ownership",
                path.display()
            ),
        ));
    }
    Ok(SocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(unix)]
fn enforce_socket_permissions(path: &Path, expected: SocketIdentity) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if socket_identity_at(path)? != expected {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!(
                "GUI control socket '{}' changed while binding",
                path.display()
            ),
        ));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_socket()
        || metadata.uid() != berth_term_os::identity::real_user_id()
        || (SocketIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }) != expected
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "GUI control socket '{}' has unsafe permissions or identity",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn remove_socket_if_identity_matches(path: &Path, expected: SocketIdentity) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_socket()
        || metadata.uid() != berth_term_os::identity::real_user_id()
    {
        return;
    }
    let identity = SocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    if identity == expected {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(unix)]
fn ensure_socket_parent(parent: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    reject_symlink_components(parent)?;
    let mut missing = Vec::new();
    let mut cursor = parent;
    loop {
        match std::fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!(
                            "GUI control parent '{}' is not a plain directory",
                            cursor.display()
                        ),
                    ));
                }
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(cursor.to_path_buf());
                cursor = cursor.parent().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "GUI control parent '{}' has no existing ancestor",
                            parent.display()
                        ),
                    )
                })?;
            }
            Err(error) => return Err(error),
        }
    }

    if missing.is_empty() {
        return validate_existing_socket_parent(parent);
    }

    // Existing shared ancestors (for example `/tmp`) are not modified.  Only
    // directories created for this endpoint receive owner-only permissions.
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(parent)?;
    for path in missing {
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "GUI control parent '{}' is not a plain directory",
                    path.display()
                ),
            ));
        }
        if metadata.uid() != berth_term_os::identity::real_user_id() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "GUI control parent '{}' has unsafe ownership",
                    path.display()
                ),
            ));
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        let mode = std::fs::symlink_metadata(&path)?.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "GUI control parent '{}' has unsafe permissions",
                    path.display()
                ),
            ));
        }
    }
    validate_existing_socket_parent(parent)
}

#[cfg(unix)]
fn validate_existing_socket_parent(parent: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "GUI control parent '{}' is not a plain directory",
                parent.display()
            ),
        ));
    }
    if metadata.uid() != berth_term_os::identity::real_user_id() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "GUI control parent '{}' has unsafe ownership",
                parent.display()
            ),
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "GUI control parent '{}' must be owner-only",
                parent.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn reject_symlink_components(path: &Path) -> io::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if !trusted_platform_directory_alias(&current)? {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!(
                            "GUI control path component '{}' is a symlink",
                            current.display()
                        ),
                    ));
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn trusted_platform_directory_alias(path: &Path) -> io::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let expected = if path == Path::new("/tmp") {
            Some(Path::new("/private/tmp"))
        } else if path == Path::new("/var") {
            Some(Path::new("/private/var"))
        } else {
            None
        };
        let Some(expected) = expected else {
            return Ok(false);
        };
        return Ok(std::fs::canonicalize(path)? == std::fs::canonicalize(expected)?);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Ok(false)
    }
}

#[cfg(unix)]
fn prepare_socket_path(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "GUI control path '{}' exists but is not a Unix socket",
                path.display()
            ),
        ));
    }
    if metadata.uid() != berth_term_os::identity::real_user_id() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "GUI control socket '{}' has unsafe ownership",
                path.display()
            ),
        ));
    }

    let endpoint = LocalEndpoint::from_path(path.to_path_buf());
    match connect_blocking(&endpoint, SOCKET_PROBE_TIMEOUT) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("GUI control socket '{}' is already in use", path.display()),
        )),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            // Re-check the inode after the probe.  If another process
            // replaced the path while we were connecting, never unlink its
            // socket (or a different file).
            let current = match std::fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            };
            if current.file_type().is_symlink() || !current.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "GUI control path '{}' changed to a non-socket",
                        path.display()
                    ),
                ));
            }
            if current.uid() != berth_term_os::identity::real_user_id() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "GUI control socket '{}' changed to another owner",
                        path.display()
                    ),
                ));
            }
            if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!(
                        "GUI control socket '{}' changed while probing",
                        path.display()
                    ),
                ));
            }
            match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(io::Error::new(
            error.kind(),
            format!("cannot prove GUI control socket is stale: {error}"),
        )),
    }
}

/// [`workspace_open_file_handoff`] 的请求体：领取或回执，仅此两种操作。
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub(crate) enum OpenFileHandoffRequest {
    /// 领取所有未过期、未回执的 `file.open` 请求。
    Claim,
    /// 回执一条请求的终态；首次回执生效，重复回执幂等忽略。
    Complete {
        /// 领取时拿到的关联 ID。
        request_id: u64,
        /// 终态。
        state: FileOpenState,
        /// viewer 实际打开的路径；旧前端缺字段时不能确认成功。
        path: Option<String>,
        /// 实际定位行（无法报告时为 None）。
        line: Option<u32>,
        /// 失败诊断。
        message: Option<String>,
    },
}

/// [`workspace_open_file_handoff`] 的返回：领取结果或回执确认。
#[derive(Debug, serde::Serialize)]
#[serde(untagged)]
pub(crate) enum OpenFileHandoffResult {
    /// 领取到的待处理请求列表。
    Claimed(Vec<pending::ClaimedOpenFile>),
    /// 回执已被记录（首次或重复均返回成功）。
    Settled,
}

/// 主窗口与 CLI `file.open` 请求的长期交接入口（claim / complete）。
///
/// 只服务 workspace 文件打开的领取与回执，不是任意动作执行器
/// （A PRD「长期入口论证」）。仅 `main` 窗口可调用。
#[tauri::command]
pub(crate) async fn workspace_open_file_handoff(
    window: tauri::WebviewWindow,
    request: OpenFileHandoffRequest,
) -> Result<OpenFileHandoffResult, crate::app_error::AppCommandError> {
    // 拒绝辅助窗口领取/回执（父契约 §4.3）。
    if window.label() != "main" {
        return Err(crate::app_error::AppCommandError::permission_denied(
            "only the main window may hand off open-file requests",
        ));
    }
    match request {
        OpenFileHandoffRequest::Claim => Ok(OpenFileHandoffResult::Claimed(pending::claim())),
        OpenFileHandoffRequest::Complete {
            request_id,
            state,
            path,
            line,
            message,
        } => {
            let outcome = match state {
                FileOpenState::Opened => match path {
                    Some(path) => pending::OpenFileOutcome::Opened { path, line },
                    None => pending::OpenFileOutcome::Failed {
                        message: "workspace did not confirm the actual opened path".into(),
                    },
                },
                FileOpenState::Failed => pending::OpenFileOutcome::Failed {
                    message: message.unwrap_or_else(|| "open failed".to_owned()),
                },
            };
            pending::complete(request_id, outcome);
            Ok(OpenFileHandoffResult::Settled)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn dispatch_rejects_unknown_method_and_non_empty_params() {
        let context = ControlContext::current();
        let unknown = RpcRequest::new(1, "unknown", serde_json::json!({}));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let response = runtime.block_on(dispatch_request(&unknown, &context));
        assert_eq!(
            response
                .error
                .as_ref()
                .and_then(|error| error.data.as_ref())
                .map(|data| data.kind),
            Some(ErrorKind::MethodNotFound)
        );

        let invalid = RpcRequest::new(
            2,
            berth_control_proto::METHOD_GUI_STATUS,
            serde_json::json!({"x": 1}),
        );
        let response = runtime.block_on(dispatch_request(&invalid, &context));
        assert_eq!(
            response
                .error
                .as_ref()
                .and_then(|error| error.data.as_ref())
                .map(|data| data.kind),
            Some(ErrorKind::InvalidParams)
        );

        let invalid = RpcRequest::new(
            3,
            berth_control_proto::METHOD_GUI_STATUS,
            serde_json::Value::Null,
        );
        let response = runtime.block_on(dispatch_request(&invalid, &context));
        assert_eq!(
            response
                .error
                .as_ref()
                .and_then(|error| error.data.as_ref())
                .map(|data| data.kind),
            Some(ErrorKind::InvalidParams)
        );
    }

    #[test]
    fn status_contains_only_stable_control_fields() {
        let status = ControlContext::current().status();
        assert_eq!(status.wire_version, CONTROL_WIRE_VERSION);
        assert_eq!(
            status.capabilities,
            vec![
                CAPABILITY_GUI_STATUS.to_owned(),
                CAPABILITY_PROJECT.to_owned(),
                CAPABILITY_FILE_OPEN.to_owned(),
                CAPABILITY_FILE_OPEN_WAIT.to_owned(),
                CAPABILITY_WORKSPACE_CURRENT_DOCUMENT.to_owned(),
                CAPABILITY_WORKSPACE_DOCUMENT_RANGE.to_owned(),
                CAPABILITY_WORKSPACE_CURRENT_TERMINAL.to_owned(),
                CAPABILITY_KNOWLEDGE_DIGEST.to_owned(),
                CAPABILITY_AGENT_CHANGED.to_owned(),
            ]
        );
        assert!(status.pid > 0);
    }

    #[cfg(unix)]
    #[test]
    fn stale_owned_socket_is_removed_but_regular_file_is_preserved() {
        use std::os::unix::net::UnixListener;

        let root = std::env::temp_dir().join(format!(
            "berth-control-test-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("test root");
        let socket = root.join("gui");
        let listener = UnixListener::bind(&socket).expect("bind stale socket");
        drop(listener);
        prepare_socket_path(&socket).expect("remove stale socket");
        assert!(!socket.exists());

        std::fs::write(&socket, b"keep").expect("regular file");
        assert!(prepare_socket_path(&socket).is_err());
        assert!(socket.exists());
        let _ = std::fs::remove_file(&socket);
        let _ = std::fs::remove_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn active_socket_is_preserved_during_stale_probe() {
        use std::os::unix::net::UnixListener;

        let root = std::env::temp_dir().join(format!(
            "berth-control-active-test-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("test root");
        let socket = root.join("gui");
        let listener = UnixListener::bind(&socket).expect("bind active socket");

        let error = prepare_socket_path(&socket).expect_err("active socket must be busy");
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        assert!(socket.exists(), "active socket must remain in place");

        drop(listener);
        let _ = std::fs::remove_file(&socket);
        let _ = std::fs::remove_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn existing_parent_permissions_are_not_changed_when_unsafe() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let root = std::env::temp_dir().join(format!(
            "berth-control-parent-test-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("test root");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755))
            .expect("set test permissions");
        let before = std::fs::symlink_metadata(&root).expect("parent metadata");

        let error = ensure_socket_parent(&root).expect_err("unsafe parent must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        let after = std::fs::symlink_metadata(&root).expect("parent metadata after check");
        assert_eq!(before.uid(), after.uid());
        assert_eq!(
            before.permissions().mode() & 0o777,
            after.permissions().mode() & 0o777
        );

        let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_dir(&root);
    }
}
