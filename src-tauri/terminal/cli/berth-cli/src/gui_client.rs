//! Client for the local GUI control socket.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use berth_control_proto::{
    decode_frame, encode_frame, ErrorKind, GuiStatus, HelloClient, HelloParams, HelloResult,
    KnowledgeDigestParams, KnowledgeDigestResult, ProjectEntry, RpcError, RpcRequest, RpcResponse,
    WorkspaceDocumentParams, WorkspaceDocumentResult, WorkspaceTerminalResult,
    CAPABILITY_AGENT_CHANGED, CAPABILITY_FILE_OPEN, CAPABILITY_FILE_OPEN_WAIT, CAPABILITY_GUI_STATUS,
    CAPABILITY_KNOWLEDGE_DIGEST, CAPABILITY_PROJECT, CAPABILITY_WORKSPACE_CURRENT_TERMINAL,
    CAPABILITY_WORKSPACE_DOCUMENT_RANGE, CONTROL_WIRE_VERSION, MAX_FRAME_BYTES,
    RPC_DAEMON_UNAVAILABLE, RPC_INCOMPATIBLE_VERSION, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS,
    RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_NOT_FOUND, RPC_REJECTED,
};
use berth_term_ipc::{connect_blocking, endpoint_for_label, BlockingLocalStream, LocalEndpoint};

const GUI_ENDPOINT_ENV: &str = "BERTH_GUI_ENDPOINT";
const GUI_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Result of a GUI status probe.
#[derive(Debug)]
pub(crate) struct GuiClientError {
    /// Stable process exit code.
    pub(crate) exit_code: u8,
    /// Human-readable diagnostic.
    pub(crate) message: String,
    /// Machine-readable error kind used by `--json`.
    pub(crate) kind: &'static str,
    /// 操作可能已经开始（超时/断连后无法确认结果）；JSON 输出标记
    /// `outcome: "unknown"`，调用方不得盲目重放写请求（父契约 §5）。
    pub(crate) outcome_unknown: bool,
}

impl GuiClientError {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            exit_code: crate::EXIT_GUI_UNAVAILABLE,
            message: message.into(),
            kind: "gui_unavailable",
            outcome_unknown: false,
        }
    }

    fn incompatible(message: impl Into<String>) -> Self {
        Self {
            exit_code: crate::EXIT_INCOMPATIBLE,
            message: message.into(),
            kind: "incompatible_version",
            outcome_unknown: false,
        }
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self {
            exit_code: 1,
            message: message.into(),
            kind: "protocol",
            outcome_unknown: false,
        }
    }

    fn rejected(message: impl Into<String>) -> Self {
        Self {
            exit_code: crate::EXIT_REJECTED,
            message: message.into(),
            kind: "rejected",
            outcome_unknown: false,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            exit_code: crate::EXIT_TARGET_NOT_FOUND,
            message: message.into(),
            kind: "not_found",
            outcome_unknown: false,
        }
    }

    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            exit_code: crate::EXIT_USER_ERROR,
            message: message.into(),
            kind: "invalid_params",
            outcome_unknown: false,
        }
    }

    /// 已连接后的等待超时：操作可能已经开始，结果未知。
    fn timed_out(message: impl Into<String>) -> Self {
        Self {
            exit_code: crate::EXIT_OPERATION_TIMEOUT,
            message: message.into(),
            kind: "timeout",
            outcome_unknown: true,
        }
    }

    /// 已建立连接的只读工作区查询超时，不误报 GUI 未运行。
    fn for_workspace_probe(mut self) -> Self {
        if self.exit_code == crate::EXIT_GUI_UNAVAILABLE {
            self.exit_code = crate::EXIT_OPERATION_TIMEOUT;
            self.kind = "timeout";
        }
        self
    }

    /// 标记操作结果未知（请求发出后的连接中断同样适用）。
    fn with_unknown_outcome(mut self) -> Self {
        self.outcome_unknown = true;
        self
    }
}

/// Serializes a runtime error for the CLI's JSON output mode.
pub(crate) fn error_json(error: &GuiClientError) -> String {
    let mut value = serde_json::json!({
        "error": {
            "kind": error.kind,
            "message": error.message,
        }
    });
    if error.outcome_unknown {
        value["error"]["outcome"] = serde_json::json!("unknown");
    }
    value.to_string()
}

/// Resolves the GUI endpoint: `--gui` → `BERTH_GUI_ENDPOINT` → per-user
/// default label.
pub(crate) fn resolve_gui_endpoint(cli_override: Option<&OsString>) -> io::Result<LocalEndpoint> {
    let env_value = std::env::var_os(GUI_ENDPOINT_ENV);
    let explicit = cli_override
        .or(env_value.as_ref())
        .filter(|value| !value.is_empty());
    let Some(value) = explicit else {
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

/// One hello-negotiated control connection.
#[derive(Debug)]
pub(crate) struct GuiControlSession {
    stream: BlockingLocalStream,
}

impl GuiControlSession {
    /// Connects and negotiates hello. `required_capability` is checked against
    /// the advertised server capabilities.
    pub(crate) fn connect(
        endpoint: &LocalEndpoint,
        required_capability: &str,
    ) -> Result<Self, GuiClientError> {
        let mut stream = connect_blocking(endpoint, GUI_CONNECT_TIMEOUT).map_err(|error| {
            GuiClientError::unavailable(format!(
                "GUI control socket is unavailable at '{}': {error}",
                endpoint_display(endpoint)
            ))
        })?;
        stream
            .set_read_timeout(Some(GUI_CONNECT_TIMEOUT))
            .map_err(|error| {
                GuiClientError::protocol(format!("failed to configure GUI read timeout: {error}"))
            })?;
        stream
            .set_write_timeout(Some(GUI_CONNECT_TIMEOUT))
            .map_err(|error| {
                GuiClientError::protocol(format!("failed to configure GUI write timeout: {error}"))
            })?;

        let hello = RpcRequest::hello(
            1,
            HelloParams {
                wire_version: CONTROL_WIRE_VERSION,
                client: HelloClient {
                    name: "berth-cli".to_owned(),
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                },
                capabilities: Vec::new(),
            },
        );
        write_frame(&mut stream, &hello)?;
        let hello_response: RpcResponse = read_frame(&mut stream, GUI_CONNECT_TIMEOUT)?;
        ensure_response_id(&hello_response, 1)?;
        let hello_result: HelloResult = decode_response(hello_response)?;
        if hello_result.wire_version != CONTROL_WIRE_VERSION {
            return Err(GuiClientError::incompatible(format!(
                "GUI control wire version {} is incompatible with client version {}",
                hello_result.wire_version, CONTROL_WIRE_VERSION
            )));
        }
        if !hello_result
            .capabilities
            .iter()
            .any(|capability| capability == required_capability)
        {
            return Err(GuiClientError::incompatible(format!(
                "GUI control server does not advertise {required_capability}"
            )));
        }
        Ok(Self { stream })
    }

    /// Sends one request and returns the typed result.
    pub(crate) fn call<T: serde::de::DeserializeOwned>(
        &mut self,
        request: RpcRequest,
    ) -> Result<T, GuiClientError> {
        let id = request.id;
        write_frame(&mut self.stream, &request)?;
        let response: RpcResponse = read_frame(&mut self.stream, GUI_CONNECT_TIMEOUT)?;
        ensure_response_id(&response, id)?;
        decode_response(response)
    }

    pub(crate) fn call_workspace_probe<T: serde::de::DeserializeOwned>(
        &mut self,
        request: RpcRequest,
    ) -> Result<T, GuiClientError> {
        self.call(request)
            .map_err(GuiClientError::for_workspace_probe)
    }
}

/// 连接失败时的拉起策略（父契约 §2：诊断与只读查询不启动进程）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchPolicy {
    /// `gui status` / `project ls` / `doctor`：连接失败即返回，不拉起。
    ProbeOnly,
    /// `open`：默认端点失败时尝试拉起（显式端点仍不拉起）。
    AllowLaunch,
}

/// 连接 GUI 控制面；按策略决定默认端点不可达时是否拉起 GUI。
/// `launch_deadline` 让 `--wait` 的总预算覆盖自动拉起阶段。
fn open_session(
    required_capability: &str,
    cli_override: Option<&OsString>,
    policy: LaunchPolicy,
    launch_deadline: Option<Instant>,
) -> Result<GuiControlSession, GuiClientError> {
    let endpoint = resolve_gui_endpoint(cli_override).map_err(|error| {
        GuiClientError::unavailable(format!(
            "GUI control socket endpoint is unavailable: {error}"
        ))
    })?;

    match GuiControlSession::connect(&endpoint, required_capability) {
        Ok(session) => Ok(session),
        Err(error) if error.exit_code == crate::EXIT_GUI_UNAVAILABLE => {
            // 显式端点（--gui 或环境变量）视为用户自管，不自动拉起。
            let env_value = std::env::var_os(GUI_ENDPOINT_ENV);
            let explicit = cli_override.or(env_value.as_ref());
            if policy == LaunchPolicy::ProbeOnly || explicit.is_some_and(|value| !value.is_empty())
            {
                return Err(error);
            }
            let launched = crate::gui_launch::try_launch_gui(launch_deadline)
                .map_err(GuiClientError::unavailable)?;
            if !launched {
                return Err(error);
            }
            GuiControlSession::connect(&endpoint, required_capability)
        }
        Err(error) => Err(error),
    }
}

/// `berth gui status`
pub(crate) fn status(cli_override: Option<&OsString>, json: bool) -> Result<(), GuiClientError> {
    let mut session = open_session(
        CAPABILITY_GUI_STATUS,
        cli_override,
        LaunchPolicy::ProbeOnly,
        None,
    )?;
    let status: GuiStatus = session.call(RpcRequest::gui_status(2))?;
    if json {
        let encoded = serde_json::to_string(&status).map_err(|error| {
            GuiClientError::protocol(format!("failed to encode status JSON: {error}"))
        })?;
        println!("{encoded}");
    } else {
        println!("version: {}", status.version);
        println!("pid: {}", status.pid);
        println!("wire_version: {}", status.wire_version);
        println!("capabilities: {}", status.capabilities.join(", "));
    }
    Ok(())
}

/// `berth project current-file` 仅读取已运行 GUI 的编辑器缓冲。
pub(crate) fn current_file(
    cli_override: Option<&OsString>,
    params: WorkspaceDocumentParams,
    json: bool,
) -> Result<(), GuiClientError> {
    params.limits().map_err(GuiClientError::invalid_params)?;
    let capability = params.required_capability();
    let mut session = open_session(capability, cli_override, LaunchPolicy::ProbeOnly, None)?;
    let result: WorkspaceDocumentResult =
        session.call_workspace_probe(RpcRequest::workspace_current_document(2, params))?;
    if capability == CAPABILITY_WORKSPACE_DOCUMENT_RANGE
        && (result.snapshot_ref.is_none() || result.range.is_none())
    {
        return Err(GuiClientError::protocol(
            "GUI omitted the negotiated document range or snapshot ref",
        ));
    }
    if json {
        println!(
            "{}",
            serde_json::to_string(&result)
                .map_err(|error| GuiClientError::protocol(error.to_string()))?
        );
    } else {
        print!("{}", result.content);
    }
    Ok(())
}

/// `berth terminal current` 仅查询已运行 GUI 的终端选择。
pub(crate) fn current_terminal(
    cli_override: Option<&OsString>,
    json: bool,
) -> Result<(), GuiClientError> {
    let mut session = open_session(
        CAPABILITY_WORKSPACE_CURRENT_TERMINAL,
        cli_override,
        LaunchPolicy::ProbeOnly,
        None,
    )?;
    let result: WorkspaceTerminalResult =
        session.call_workspace_probe(RpcRequest::workspace_current_terminal(2))?;
    if json {
        println!(
            "{}",
            serde_json::to_string(&result)
                .map_err(|error| GuiClientError::protocol(error.to_string()))?
        );
    } else {
        println!(
            "terminal_id: {}\ntarget_ref: {}",
            result.terminal_id, result.target_ref
        );
    }
    Ok(())
}

/// 摘要要逐个解析会话：读取预算比普通查询宽。
const KNOWLEDGE_DIGEST_BUDGET: Duration = Duration::from_secs(120);

/// `berth knowledge digest`：GUI 用项目会话浏览器读取项目族的 Agent 会话并压成摘要。
/// 只读查询，GUI 不在时不拉起。
pub(crate) fn knowledge_digest(
    cli_override: Option<&OsString>,
    params: &KnowledgeDigestParams,
) -> Result<KnowledgeDigestResult, GuiClientError> {
    let mut session = open_session(
        CAPABILITY_KNOWLEDGE_DIGEST,
        cli_override,
        LaunchPolicy::ProbeOnly,
        None,
    )?;
    write_frame(
        &mut session.stream,
        &RpcRequest::knowledge_digest(2, params),
    )?;
    let response: RpcResponse = read_frame(&mut session.stream, KNOWLEDGE_DIGEST_BUDGET)?;
    ensure_response_id(&response, 2)?;
    decode_response(response)
}

/// Agent hook 之后唤醒 GUI 立即刷新；GUI 没开就算了，不拉起。
pub(crate) fn agent_changed(cli_override: Option<&OsString>) -> Result<(), GuiClientError> {
    let mut session = open_session(CAPABILITY_AGENT_CHANGED, cli_override, LaunchPolicy::ProbeOnly, None)?;
    session.call::<serde_json::Value>(RpcRequest::agent_changed(2)).map(drop)
}

/// `berth project add <path>`
pub(crate) fn project_add(
    cli_override: Option<&OsString>,
    path: String,
    json: bool,
) -> Result<(), GuiClientError> {
    let mut session = open_session(
        CAPABILITY_PROJECT,
        cli_override,
        LaunchPolicy::ProbeOnly,
        None,
    )?;
    let entry: ProjectEntry = session.call(RpcRequest::project_add(2, path))?;
    if json {
        let encoded = serde_json::to_string(&entry).map_err(|error| {
            GuiClientError::protocol(format!("failed to encode project JSON: {error}"))
        })?;
        println!("{encoded}");
    } else {
        println!("{} {} ({})", entry.id, entry.name, entry.path);
    }
    Ok(())
}

/// `berth group spawn` 的 worker 目录还不是项目时经运行中的 GUI 注册；GUI 不在时调用方直接写库。
pub(crate) fn project_ensure(
    cli_override: Option<&OsString>,
    path: String,
) -> Result<ProjectEntry, GuiClientError> {
    let mut session = open_session(
        CAPABILITY_PROJECT,
        cli_override,
        LaunchPolicy::ProbeOnly,
        None,
    )?;
    session.call(RpcRequest::project_add(2, path))
}

/// `berth open <path>[:line]` 的目标解析结果。
#[derive(Debug)]
pub(crate) struct OpenTarget {
    pub(crate) path: String,
    pub(crate) line: Option<u32>,
}

/// 解析 `open` 目标（父契约 §3）：
///
/// - `--line` 显式指定时优先，且必须为正整数；
/// - 相对路径按调用者 cwd 转绝对；存在性、类型与 canonicalize 由服务端负责；
/// - `path:N` 简写仅在后缀为正整数时拆分 —— 后缀非正整数（含 Windows
///   盘符 `C:\…`、冒号文件名）不拆，整体作为路径；
/// - target 整体指向存在的文件时优先按该文件解释（真实文件名可以含
///   冒号或数字后缀）。
pub(crate) fn parse_open_target(
    target: &str,
    explicit_line: Option<u32>,
) -> Result<OpenTarget, GuiClientError> {
    if explicit_line == Some(0) {
        return Err(GuiClientError::invalid_params(
            "--line must be a positive integer",
        ));
    }
    if target.is_empty() {
        return Err(GuiClientError::invalid_params("path cannot be empty"));
    }

    let absolute = if PathBuf::from(target).is_absolute() {
        target.to_owned()
    } else {
        let cwd = std::env::current_dir().map_err(|error| {
            GuiClientError::invalid_params(format!(
                "cannot resolve relative path '{target}': {error}"
            ))
        })?;
        cwd.join(target).display().to_string()
    };

    if PathBuf::from(&absolute).is_file() {
        return Ok(OpenTarget {
            path: absolute,
            line: explicit_line,
        });
    }

    let (path, shorthand_line) = match absolute.rsplit_once(':') {
        Some((path, suffix)) if !suffix.is_empty() => match suffix.parse::<u32>() {
            Ok(line) if line > 0 => (path.to_owned(), Some(line)),
            // 后缀不是正整数：整体作为路径（覆盖 Windows 盘符与冒号文件名）。
            _ => (absolute.clone(), None),
        },
        _ => (absolute.clone(), None),
    };
    Ok(OpenTarget {
        path,
        line: explicit_line.or(shorthand_line),
    })
}

/// `berth open <path>[:line] [--line N] [--wait] [--timeout S]`
///
/// 无 `--wait`：请求接收即返回（`accepted` 不代表打开完成）。
/// `--wait`：等待主窗口完成加载、激活与行定位后返回实际终态；拉起与
/// 等待共享 `timeout_secs` 的同一预算（父契约 §2/§5）。
pub(crate) fn open(
    cli_override: Option<&OsString>,
    target: &str,
    explicit_line: Option<u32>,
    wait: bool,
    timeout_secs: u64,
    json: bool,
) -> Result<(), GuiClientError> {
    let target = parse_open_target(target, explicit_line)?;
    let total = Duration::from_secs(timeout_secs);
    let start = Instant::now();

    if !wait {
        let mut session = open_session(
            CAPABILITY_FILE_OPEN,
            cli_override,
            LaunchPolicy::AllowLaunch,
            None,
        )?;
        let result: berth_control_proto::FileOpenResult =
            session.call(RpcRequest::file_open(2, target.path.clone(), target.line))?;
        if json {
            println!("{}", serde_json::to_string(&result).unwrap_or_default());
        } else if result.accepted {
            // accepted 只表示 GUI 已接收，不代表文件已打开（父契约 §2）。
            println!("accepted {}", target.path);
        }
        return Ok(());
    }

    let deadline = start + total;
    let mut session = open_session(
        CAPABILITY_FILE_OPEN_WAIT,
        cli_override,
        LaunchPolicy::AllowLaunch,
        Some(deadline),
    )?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(GuiClientError::timed_out(
            "GUI launch consumed the entire --timeout budget before the open request was sent",
        ));
    }
    let request = RpcRequest::file_open_wait(
        2,
        target.path.clone(),
        target.line,
        remaining.as_millis() as u64,
    );
    write_frame(&mut session.stream, &request)?;
    let response: RpcResponse =
        read_frame(&mut session.stream, remaining).map_err(|error| match error.exit_code {
            // 预算用尽：操作可能已开始，结果未知。
            crate::EXIT_GUI_UNAVAILABLE => GuiClientError::timed_out(error.message),
            // 请求已发出后的连接异常：结果同样未知。
            _ => error.with_unknown_outcome(),
        })?;
    ensure_response_id(&response, 2)?;
    let result: berth_control_proto::FileOpenWaitResult = decode_response(response)?;

    if result.state == berth_control_proto::FileOpenState::Failed {
        // GUI 已完成但结果是失败：非零退出码让 agent 不解析 JSON 也能感知。
        return Err(GuiClientError {
            exit_code: 1,
            message: result
                .message
                .clone()
                .unwrap_or_else(|| "open failed".to_owned()),
            kind: "open_failed",
            outcome_unknown: false,
        });
    }
    // opened 还必须确认目标文件；状态成功或相同行号不能证明打开了请求的文件。
    let same_path = result.path.len() <= 4096
        && !result.path.contains('\0')
        && Path::new(&result.path).is_absolute()
        && (result.path == target.path
            || matches!(
                (
                    std::fs::canonicalize(&result.path),
                    std::fs::canonicalize(&target.path),
                ),
                (Ok(actual), Ok(requested)) if actual == requested
            ));
    if !same_path {
        return Err(GuiClientError {
            exit_code: crate::EXIT_REJECTED,
            message: "opened path does not match the requested file".into(),
            kind: "location_unconfirmed",
            outcome_unknown: false,
        });
    }
    if let Some(requested) = target.line {
        if result.line != Some(requested) {
            // opened 只证明文件打开；实际行缺失或不符时不能报告定位完成。
            return Err(GuiClientError {
                exit_code: crate::EXIT_REJECTED,
                message: format!("opened {}; requested line {requested}, actual line {:?}; location is unconfirmed", result.path, result.line),
                kind: "location_unconfirmed",
                outcome_unknown: false,
            });
        }
    }
    if json {
        println!(
            "{}",
            serde_json::to_string(&result)
                .map_err(|error| GuiClientError::protocol(error.to_string()))?
        );
    } else if let Some(line) = result.line {
        println!("opened {}:{line}", result.path);
    } else {
        println!("opened {}", result.path);
    }
    Ok(())
}

fn endpoint_display(endpoint: &LocalEndpoint) -> String {
    #[cfg(windows)]
    {
        return endpoint.as_pipe_name().to_string_lossy().into_owned();
    }
    #[cfg(not(windows))]
    endpoint.as_path().display().to_string()
}

fn write_frame<T: serde::Serialize>(
    stream: &mut BlockingLocalStream,
    value: &T,
) -> Result<(), GuiClientError> {
    let frame = encode_frame(value).map_err(|error| {
        GuiClientError::protocol(format!("failed to encode control frame: {error}"))
    })?;
    stream
        .write_all(&frame)
        .and_then(|_| stream.flush())
        .map_err(|error| map_io_error("write control frame", error))
}

/// 读取一帧；`budget` 是本次读取的总预算（wait 模式传剩余 deadline，
/// 常规请求传连接超时）。
fn read_frame<T: serde::de::DeserializeOwned>(
    stream: &mut BlockingLocalStream,
    budget: Duration,
) -> Result<T, GuiClientError> {
    let mut frame = Vec::with_capacity(256);
    let deadline = Instant::now() + budget;
    loop {
        let mut byte = [0_u8; 1];
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(GuiClientError::unavailable(
                "timed out waiting for GUI control response",
            ));
        }
        stream.set_read_timeout(Some(remaining)).map_err(|error| {
            GuiClientError::protocol(format!("failed to configure GUI read timeout: {error}"))
        })?;
        let count = stream
            .read(&mut byte)
            .map_err(|error| map_io_error("read control frame", error))?;
        if count == 0 {
            return Err(GuiClientError::protocol(
                "GUI control server closed before completing a frame",
            ));
        }
        frame.push(byte[0]);
        if frame.len() > MAX_FRAME_BYTES {
            return Err(GuiClientError::protocol("GUI control frame exceeds 1 MiB"));
        }
        if byte[0] == b'\n' {
            return decode_frame(&frame).map_err(|error| {
                GuiClientError::protocol(format!("invalid GUI control frame: {error}"))
            });
        }
    }
}

fn map_io_error(operation: &str, error: io::Error) -> GuiClientError {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        GuiClientError::unavailable(format!("GUI control socket {operation} timed out: {error}"))
    } else {
        GuiClientError::protocol(format!("failed to {operation}: {error}"))
    }
}

fn ensure_response_id(response: &RpcResponse, expected: u64) -> Result<(), GuiClientError> {
    if response.jsonrpc != berth_control_proto::JSONRPC_VERSION {
        return Err(GuiClientError::protocol(
            "GUI control response has an invalid jsonrpc version",
        ));
    }
    if response.id != expected {
        return Err(GuiClientError::protocol(format!(
            "GUI control response id {} does not match request id {expected}",
            response.id
        )));
    }
    Ok(())
}

fn decode_response<T: serde::de::DeserializeOwned>(
    response: RpcResponse,
) -> Result<T, GuiClientError> {
    match response.decode_result() {
        Ok(result) => Ok(result),
        Err(error) => Err(map_rpc_error(error)),
    }
}

fn map_rpc_error(error: RpcError) -> GuiClientError {
    let kind = error.data.as_ref().map(|data| data.kind).or_else(|| {
        Some(match error.code {
            RPC_INVALID_REQUEST => ErrorKind::InvalidRequest,
            RPC_METHOD_NOT_FOUND => ErrorKind::MethodNotFound,
            RPC_INVALID_PARAMS => ErrorKind::InvalidParams,
            RPC_INTERNAL_ERROR => ErrorKind::Internal,
            RPC_INCOMPATIBLE_VERSION => ErrorKind::IncompatibleVersion,
            RPC_NOT_FOUND => ErrorKind::NotFound,
            RPC_DAEMON_UNAVAILABLE => ErrorKind::DaemonUnavailable,
            berth_control_proto::RPC_STALE_SNAPSHOT => ErrorKind::StaleSnapshot,
            RPC_REJECTED => ErrorKind::Rejected,
            _ => return None,
        })
    });

    if kind == Some(ErrorKind::IncompatibleVersion) || error.code == RPC_INCOMPATIBLE_VERSION {
        return GuiClientError::incompatible(error.message);
    }

    match kind {
        Some(ErrorKind::NotFound) => GuiClientError::not_found(error.message),
        Some(ErrorKind::StaleSnapshot) => GuiClientError {
            exit_code: crate::EXIT_TARGET_NOT_FOUND,
            message: error.message,
            kind: "stale_snapshot",
            outcome_unknown: false,
        },
        Some(ErrorKind::DaemonUnavailable) => GuiClientError {
            exit_code: crate::EXIT_DAEMON_UNAVAILABLE,
            message: error.message,
            kind: "daemon_unavailable",
            outcome_unknown: false,
        },
        Some(ErrorKind::Rejected) => GuiClientError::rejected(error.message),
        Some(ErrorKind::InvalidParams) => GuiClientError::invalid_params(error.message),
        Some(ErrorKind::InvalidRequest) => GuiClientError::invalid_params(error.message),
        // 服务端超时：操作可能已经开始，结果未知（父契约 §5）。
        Some(ErrorKind::Timeout) => GuiClientError::timed_out(error.message),
        Some(ErrorKind::Internal) => GuiClientError {
            exit_code: 1,
            message: error.message,
            kind: "internal",
            outcome_unknown: false,
        },
        Some(ErrorKind::MethodNotFound) | None => GuiClientError::protocol(error.message),
        Some(ErrorKind::IncompatibleVersion) => unreachable!("handled above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn json_error_is_one_machine_readable_object() {
        let error = GuiClientError::unavailable("socket missing");
        let value: serde_json::Value = serde_json::from_str(&error_json(&error)).expect("JSON");
        assert_eq!(value["error"]["kind"], "gui_unavailable");
        assert_eq!(value["error"]["message"], "socket missing");
    }

    #[test]
    fn response_id_validation_is_strict() {
        let response = RpcResponse::success(
            2,
            &GuiStatus {
                version: "0.31.1".to_owned(),
                pid: 1,
                wire_version: CONTROL_WIRE_VERSION,
                capabilities: vec![CAPABILITY_GUI_STATUS.to_owned()],
            },
        )
        .expect("response");
        assert!(ensure_response_id(&response, 2).is_ok());
        assert!(ensure_response_id(&response, 1).is_err());
    }

    #[test]
    fn platform_timeout_kinds_are_reported_as_gui_unavailable() {
        for kind in [io::ErrorKind::TimedOut, io::ErrorKind::WouldBlock] {
            let error = map_io_error("read control frame", io::Error::from(kind));
            assert_eq!(error.exit_code, crate::EXIT_GUI_UNAVAILABLE);
            assert_eq!(error.kind, "gui_unavailable");
        }
    }

    #[test]
    fn workspace_probe_distinguishes_connected_timeout_from_missing_gui() {
        let error = GuiClientError::unavailable("read timed out").for_workspace_probe();
        assert_eq!(error.exit_code, crate::EXIT_OPERATION_TIMEOUT);
        assert_eq!(error.kind, "timeout");
        assert!(!error.outcome_unknown);
        assert_eq!(
            GuiClientError::not_found("no editor")
                .for_workspace_probe()
                .exit_code,
            crate::EXIT_TARGET_NOT_FOUND
        );
    }

    #[test]
    fn incompatible_error_code_maps_without_optional_error_data() {
        let response = RpcResponse {
            jsonrpc: berth_control_proto::JSONRPC_VERSION.to_owned(),
            id: 1,
            result: None,
            error: Some(berth_control_proto::RpcError {
                code: RPC_INCOMPATIBLE_VERSION,
                message: "wire version mismatch".to_owned(),
                data: None,
            }),
        };
        let error = decode_response::<HelloResult>(response).expect_err("must reject version");
        assert_eq!(error.exit_code, crate::EXIT_INCOMPATIBLE);
        assert_eq!(error.kind, "incompatible_version");
    }

    #[test]
    fn known_rpc_error_kind_is_preserved_for_json_output() {
        let response = RpcResponse {
            jsonrpc: berth_control_proto::JSONRPC_VERSION.to_owned(),
            id: 2,
            result: None,
            error: Some(RpcError {
                code: berth_control_proto::RPC_INTERNAL_ERROR,
                message: "GUI failed internally".to_owned(),
                data: Some(berth_control_proto::RpcErrorData {
                    kind: ErrorKind::Internal,
                }),
            }),
        };
        let error = decode_response::<GuiStatus>(response).expect_err("must reject RPC error");
        assert_eq!(error.exit_code, 1);
        assert_eq!(error.kind, "internal");
        let json: serde_json::Value =
            serde_json::from_str(&error_json(&error)).expect("error JSON");
        assert_eq!(json["error"]["kind"], "internal");
    }

    #[test]
    fn gui_status_filter_matches_the_command_name() {
        assert_eq!(berth_control_proto::METHOD_GUI_STATUS, "gui.status");
    }

    #[test]
    fn open_target_parses_path_and_optional_line() {
        let target = parse_open_target("/abs/file.rs:42", None).expect("target");
        assert_eq!(target.path, "/abs/file.rs");
        assert_eq!(target.line, Some(42));

        let target = parse_open_target("/abs/file.rs", None).expect("target");
        assert_eq!(target.path, "/abs/file.rs");
        assert_eq!(target.line, None);

        // --line 优先于 path:N 简写。
        let target = parse_open_target("/abs/file.rs:10", Some(42)).expect("target");
        assert_eq!(target.path, "/abs/file.rs");
        assert_eq!(target.line, Some(42));

        // --line 必须为正整数。
        let error = parse_open_target("/abs/file.rs", Some(0)).expect_err("zero line");
        assert_eq!(error.exit_code, crate::EXIT_USER_ERROR);
    }

    #[test]
    fn open_target_non_positive_suffix_stays_part_of_the_path() {
        // 后缀 0 不是正整数 → 整体作为路径。
        let target = parse_open_target("/abs/file.rs:0", None).expect("target");
        assert_eq!(target.path, "/abs/file.rs:0");
        assert_eq!(target.line, None);

        // 非数字后缀 → 整体作为路径，不再报错。
        let target = parse_open_target("/abs/file.rs:abc", None).expect("target");
        assert_eq!(target.path, "/abs/file.rs:abc");
        assert_eq!(target.line, None);
    }

    #[cfg(windows)]
    #[test]
    fn open_target_keeps_windows_drive_paths_intact() {
        // Windows 盘符是绝对路径：后缀非正整数 → 不拆。
        let target = parse_open_target(r"C:\src\main.rs", None).expect("target");
        assert_eq!(target.path, r"C:\src\main.rs");
        assert_eq!(target.line, None);

        // 盘符 + 正整数行号简写仍可拆。
        let target = parse_open_target(r"C:\src\main.rs:42", None).expect("target");
        assert_eq!(target.path, r"C:\src\main.rs");
        assert_eq!(target.line, Some(42));
    }

    #[test]
    fn open_target_resolves_relative_paths_against_cwd() {
        let target = parse_open_target("relative.rs:42", None).expect("target");
        let cwd = std::env::current_dir().expect("cwd");
        assert_eq!(target.path, cwd.join("relative.rs").display().to_string());
        assert_eq!(target.line, Some(42));

        let target = parse_open_target("relative.rs", None).expect("target");
        assert_eq!(target.path, cwd.join("relative.rs").display().to_string());
        assert_eq!(target.line, None);
    }

    #[cfg(unix)]
    #[test]
    fn open_target_prefers_an_existing_file_with_special_name() {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        // 真实文件名可以带冒号或数字后缀：存在的文件优先整体作为路径。
        let dir = std::env::temp_dir().join(format!(
            "berth-open-target-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let colon_name = dir.join("weird:name.rs");
        let numbered_name = dir.join("plain.rs:42");
        std::fs::write(&colon_name, b"x").expect("write");
        std::fs::write(&numbered_name, b"x").expect("write");

        let target = parse_open_target(colon_name.to_str().expect("utf8"), None).expect("target");
        assert_eq!(target.path, colon_name.display().to_string());
        assert_eq!(target.line, None);

        let target =
            parse_open_target(numbered_name.to_str().expect("utf8"), None).expect("target");
        assert_eq!(target.path, numbered_name.display().to_string());
        assert_eq!(target.line, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_only_session_does_not_attempt_launch() {
        // 不存在的 socket 端点：ProbeOnly 必须直接返回不可达错误，而不是
        // 走拉起分支（本测试环境无 BERTH_GUI_BINARY / sibling / APPIMAGE，
        // 若误入拉起分支同样会失败，但 ProbeOnly 语义由策略分支保证）。
        let missing = LocalEndpoint::from_path(
            std::env::temp_dir().join(format!("berth-missing-gui-{}", std::process::id())),
        );
        let error = GuiControlSession::connect(&missing, CAPABILITY_GUI_STATUS)
            .expect_err("unreachable endpoint");
        assert_eq!(error.exit_code, crate::EXIT_GUI_UNAVAILABLE);
        assert_eq!(error.kind, "gui_unavailable");
    }

    #[test]
    fn server_timeout_maps_to_exit_8_with_unknown_outcome() {
        let response = RpcResponse {
            jsonrpc: berth_control_proto::JSONRPC_VERSION.to_owned(),
            id: 2,
            result: None,
            error: Some(RpcError {
                code: berth_control_proto::RPC_TIMEOUT,
                message: "file.open wait timed out".to_owned(),
                data: Some(berth_control_proto::RpcErrorData {
                    kind: ErrorKind::Timeout,
                }),
            }),
        };
        let error = decode_response::<GuiStatus>(response).expect_err("timeout maps");
        assert_eq!(error.exit_code, crate::EXIT_OPERATION_TIMEOUT);
        assert_eq!(error.kind, "timeout");
        assert!(error.outcome_unknown);
        let json: serde_json::Value =
            serde_json::from_str(&error_json(&error)).expect("error JSON");
        assert_eq!(json["error"]["outcome"], serde_json::json!("unknown"));
    }

    #[test]
    fn timed_out_error_marks_unknown_outcome_in_json() {
        let error = GuiClientError::timed_out("budget exhausted");
        assert_eq!(error.exit_code, crate::EXIT_OPERATION_TIMEOUT);
        let json: serde_json::Value =
            serde_json::from_str(&error_json(&error)).expect("error JSON");
        assert_eq!(json["error"]["kind"], "timeout");
        assert_eq!(json["error"]["outcome"], serde_json::json!("unknown"));
        // 无 outcome 标记的错误不输出该字段。
        let plain = GuiClientError::unavailable("socket missing");
        let plain_json: serde_json::Value =
            serde_json::from_str(&error_json(&plain)).expect("plain JSON");
        assert!(plain_json["error"].get("outcome").is_none());
    }

    #[test]
    fn not_found_and_rejected_map_to_stable_exit_codes() {
        for (code, kind, expected_exit, expected_kind) in [
            (
                berth_control_proto::RPC_NOT_FOUND,
                ErrorKind::NotFound,
                crate::EXIT_TARGET_NOT_FOUND,
                "not_found",
            ),
            (
                berth_control_proto::RPC_REJECTED,
                ErrorKind::Rejected,
                crate::EXIT_REJECTED,
                "rejected",
            ),
            (
                berth_control_proto::RPC_INVALID_PARAMS,
                ErrorKind::InvalidParams,
                crate::EXIT_USER_ERROR,
                "invalid_params",
            ),
        ] {
            let response = RpcResponse {
                jsonrpc: berth_control_proto::JSONRPC_VERSION.to_owned(),
                id: 2,
                result: None,
                error: Some(RpcError {
                    code,
                    message: "msg".to_owned(),
                    data: Some(berth_control_proto::RpcErrorData { kind }),
                }),
            };
            let error = decode_response::<GuiStatus>(response).expect_err("must map error");
            assert_eq!(error.exit_code, expected_exit);
            assert_eq!(error.kind, expected_kind);
        }
    }

    #[cfg(unix)]
    #[test]
    fn gui_status_client_round_trips_hello_and_status_without_daemon() {
        use std::os::unix::net::UnixListener;
        use std::thread;

        static NEXT_SOCKET: AtomicU64 = AtomicU64::new(0);
        let socket = std::env::temp_dir().join(format!(
            "berth-gui-status-client-{}-{}",
            std::process::id(),
            NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)
        ));
        let listener = UnixListener::bind(&socket).expect("fixture listener");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fixture accept");
            let hello: RpcRequest = read_fixture_frame(&mut stream);
            assert_eq!(hello.method, berth_control_proto::METHOD_HELLO);
            let hello_response = RpcResponse::success(
                hello.id,
                &HelloResult {
                    wire_version: CONTROL_WIRE_VERSION,
                    server: berth_control_proto::HelloServer {
                        name: "berth-gui".to_owned(),
                        version: "0.31.1".to_owned(),
                        pid: 123,
                    },
                    capabilities: vec![CAPABILITY_GUI_STATUS.to_owned()],
                },
            )
            .expect("hello response");
            stream
                .write_all(&encode_frame(&hello_response).expect("hello frame"))
                .expect("write hello");

            let status_request: RpcRequest = read_fixture_frame(&mut stream);
            assert_eq!(
                status_request.method,
                berth_control_proto::METHOD_GUI_STATUS
            );
            let status_response = RpcResponse::success(
                status_request.id,
                &GuiStatus {
                    version: "0.31.1".to_owned(),
                    pid: 123,
                    wire_version: CONTROL_WIRE_VERSION,
                    capabilities: vec![CAPABILITY_GUI_STATUS.to_owned()],
                },
            )
            .expect("status response");
            stream
                .write_all(&encode_frame(&status_response).expect("status frame"))
                .expect("write status");
        });

        let result = GuiControlSession::connect(
            &LocalEndpoint::from_path(socket.clone()),
            CAPABILITY_GUI_STATUS,
        );
        let mut session = result.expect("session");
        let status: GuiStatus = session
            .call(RpcRequest::gui_status(2))
            .expect("status call");
        server.join().expect("fixture server");
        let _ = std::fs::remove_file(socket);
        assert_eq!(status.pid, 123);
    }

    #[cfg(unix)]
    fn current_file_fixture(
        params: WorkspaceDocumentParams,
        capabilities: Vec<String>,
        result: Option<serde_json::Value>,
    ) -> Result<(), GuiClientError> {
        use std::os::unix::net::UnixListener;
        let dir = tempfile::tempdir().expect("synthetic control directory");
        let socket = dir.path().join("gui.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let expected = RpcRequest::workspace_current_document(2, params.clone());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let hello: RpcRequest = read_fixture_frame(&mut stream);
            let response = RpcResponse::success(
                hello.id,
                &HelloResult {
                    wire_version: CONTROL_WIRE_VERSION,
                    server: berth_control_proto::HelloServer {
                        name: "synthetic-gui".into(),
                        version: "test".into(),
                        pid: 123,
                    },
                    capabilities,
                },
            )
            .unwrap();
            stream.write_all(&encode_frame(&response).unwrap()).unwrap();
            if let Some(result) = result {
                let request: RpcRequest = read_fixture_frame(&mut stream);
                assert_eq!(request, expected);
                stream
                    .write_all(
                        &encode_frame(&RpcResponse::success(request.id, &result).unwrap()).unwrap(),
                    )
                    .unwrap();
            } else {
                let mut byte = [0];
                assert_eq!(
                    stream.read(&mut byte).unwrap(),
                    0,
                    "unsupported capability must not send the document request"
                );
            }
        });
        let result = current_file(Some(&socket.into_os_string()), params, true);
        server.join().expect("fixture server");
        result
    }

    #[cfg(unix)]
    #[test]
    fn current_file_range_negotiation_preserves_legacy_and_refuses_ignored_parameters() {
        let old = serde_json::json!({
            "source_path": "/synthetic/old.txt", "content": "old buffer", "revision": 1,
            "committed_at_ms": 1, "truncated": false,
        });
        let v1 = berth_control_proto::CAPABILITY_WORKSPACE_CURRENT_DOCUMENT;
        current_file_fixture(
            WorkspaceDocumentParams::default(),
            vec![v1.into()],
            Some(old.clone()),
        )
        .unwrap();
        let params = WorkspaceDocumentParams {
            offset: Some(1),
            ..Default::default()
        };
        let error = current_file_fixture(params.clone(), vec![v1.into()], None).unwrap_err();
        assert_eq!(error.exit_code, crate::EXIT_INCOMPATIBLE);
        let error = current_file_fixture(
            params.clone(),
            vec![CAPABILITY_WORKSPACE_DOCUMENT_RANGE.into()],
            Some(old.clone()),
        )
        .unwrap_err();
        assert_eq!(error.kind, "protocol");
        let mut new = old;
        new["snapshot_ref"] = serde_json::json!(format!("v1.{}.1", "b".repeat(32)));
        new["range"] = serde_json::json!({
            "start_line": 1, "end_line": 1, "total_lines": 1, "available_start_line": 1,
            "start_line_complete": true, "end_line_complete": true,
        });
        current_file_fixture(
            params,
            vec![CAPABILITY_WORKSPACE_DOCUMENT_RANGE.into()],
            Some(new),
        )
        .unwrap();
    }

    #[test]
    fn current_file_invalid_range_is_rejected_before_gui_access_and_stale_is_typed() {
        let missing: OsString = "/synthetic/absent-gui.sock".into();
        for params in [
            WorkspaceDocumentParams {
                offset: Some(0),
                ..Default::default()
            },
            WorkspaceDocumentParams {
                snapshot_ref: Some("bad".into()),
                ..Default::default()
            },
            WorkspaceDocumentParams {
                lines: Some(4097),
                ..Default::default()
            },
        ] {
            let error = current_file(Some(&missing), params, true).unwrap_err();
            assert_eq!(error.exit_code, crate::EXIT_USER_ERROR);
            assert_eq!(error.kind, "invalid_params");
        }
        let error = map_rpc_error(RpcError {
            code: berth_control_proto::RPC_STALE_SNAPSHOT,
            message: "changed".into(),
            data: None,
        });
        assert_eq!(error.exit_code, crate::EXIT_TARGET_NOT_FOUND);
        assert_eq!(error.kind, "stale_snapshot");
        assert!(!error.outcome_unknown);
    }

    #[cfg(unix)]
    fn waited_open_with_line(
        actual: Option<u32>,
        requested: Option<u32>,
    ) -> Result<(), GuiClientError> {
        waited_open_with_paths(
            "/synthetic/document.txt",
            "/synthetic/document.txt",
            actual,
            requested,
        )
    }

    #[cfg(unix)]
    fn waited_open_with_paths(
        actual_path: &str,
        requested_path: &str,
        actual: Option<u32>,
        requested: Option<u32>,
    ) -> Result<(), GuiClientError> {
        use std::os::unix::net::UnixListener;

        let dir = tempfile::tempdir().expect("synthetic control directory");
        let socket = dir.path().join("gui.sock");
        let listener = UnixListener::bind(&socket).expect("fixture listener");
        let actual_path = actual_path.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fixture accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let hello: RpcRequest = read_fixture_frame(&mut stream);
            let response = RpcResponse::success(
                hello.id,
                &HelloResult {
                    wire_version: CONTROL_WIRE_VERSION,
                    server: berth_control_proto::HelloServer {
                        name: "synthetic-gui".into(),
                        version: "test".into(),
                        pid: 123,
                    },
                    capabilities: vec![CAPABILITY_FILE_OPEN_WAIT.into()],
                },
            )
            .unwrap();
            stream.write_all(&encode_frame(&response).unwrap()).unwrap();
            let request: RpcRequest = read_fixture_frame(&mut stream);
            assert_eq!(request.method, berth_control_proto::METHOD_FILE_OPEN);
            let response = RpcResponse::success(
                request.id,
                &berth_control_proto::FileOpenWaitResult {
                    accepted: true,
                    state: berth_control_proto::FileOpenState::Opened,
                    path: actual_path,
                    line: actual,
                    message: None,
                },
            )
            .unwrap();
            stream.write_all(&encode_frame(&response).unwrap()).unwrap();
        });
        let result = open(
            Some(&socket.into_os_string()),
            requested_path,
            requested,
            true,
            2,
            true,
        );
        server.join().expect("fixture server");
        result
    }

    #[cfg(unix)]
    #[test]
    fn open_wait_requires_the_requested_line_to_be_confirmed() {
        for actual in [None, Some(2)] {
            let error = waited_open_with_line(actual, Some(7)).expect_err("unconfirmed location");
            assert_eq!(error.exit_code, crate::EXIT_REJECTED);
            assert_eq!(error.kind, "location_unconfirmed");
            assert!(!error.outcome_unknown);
        }
        waited_open_with_line(Some(7), Some(7)).expect("confirmed reveal");
        waited_open_with_line(None, None).expect("opened without a location request");
    }

    #[cfg(unix)]
    #[test]
    fn open_wait_rejects_a_receipt_for_a_different_file() {
        for line in [None, Some(7)] {
            let error = waited_open_with_paths(
                "/synthetic/other.txt",
                "/synthetic/document.txt",
                line,
                line,
            )
            .expect_err("a matching line cannot confirm a different file");
            assert_eq!(error.exit_code, crate::EXIT_REJECTED);
            assert_eq!(error.kind, "location_unconfirmed");
            assert!(!error.outcome_unknown);
        }
    }

    #[cfg(unix)]
    #[test]
    fn open_wait_rejects_invalid_actual_paths() {
        for actual in [
            "document.txt".to_owned(),
            "/synthetic/document.txt\0".to_owned(),
            format!("/{}", "a".repeat(4096)),
        ] {
            let error = waited_open_with_paths(&actual, "/synthetic/document.txt", None, None)
                .expect_err("an actual path must be absolute and bounded");
            assert_eq!(error.exit_code, crate::EXIT_REJECTED);
            assert_eq!(error.kind, "location_unconfirmed");
            assert!(!error.outcome_unknown);
        }
    }

    #[cfg(unix)]
    #[test]
    fn open_wait_accepts_a_canonical_alias_for_the_requested_file() {
        let directory = tempfile::tempdir().expect("synthetic alias directory");
        let document = directory.path().join("document.txt");
        let alias = directory.path().join("alias.txt");
        std::fs::write(&document, "synthetic-only").expect("synthetic document");
        std::os::unix::fs::symlink(&document, &alias).expect("synthetic path alias");
        let canonical = std::fs::canonicalize(&document).expect("canonical document");
        for line in [None, Some(7)] {
            waited_open_with_paths(
                canonical.to_str().expect("UTF-8 temporary path"),
                alias.to_str().expect("UTF-8 temporary path"),
                line,
                line,
            )
            .expect("the actual canonical path confirms the requested alias");
        }
    }

    #[cfg(unix)]
    fn read_fixture_frame<T: serde::de::DeserializeOwned>(
        stream: &mut std::os::unix::net::UnixStream,
    ) -> T {
        let mut frame = Vec::new();
        loop {
            let mut byte = [0_u8; 1];
            stream.read_exact(&mut byte).expect("fixture read");
            frame.push(byte[0]);
            if byte[0] == b'\n' {
                return decode_frame(&frame).expect("fixture decode");
            }
        }
    }
}
