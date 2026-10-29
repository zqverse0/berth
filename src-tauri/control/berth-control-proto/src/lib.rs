#![deny(missing_docs)]
#![forbid(unsafe_code)]

//! Shared wire contract for the local Berth GUI control socket.
//!
//! This crate deliberately contains no transport or application code.  The
//! GUI and CLI use the same DTOs and line codec, while each side owns its
//! platform-specific socket lifecycle.

use std::fmt;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// JSON-RPC version used by the control protocol.
pub const JSONRPC_VERSION: &str = "2.0";
/// Control wire version negotiated by `berth.hello`.
pub const CONTROL_WIRE_VERSION: u32 = 1;
/// Hello method name.
pub const METHOD_HELLO: &str = "berth.hello";
/// GUI status method name.
pub const METHOD_GUI_STATUS: &str = "gui.status";
/// Capability advertised by a server that supports GUI status.
pub const CAPABILITY_GUI_STATUS: &str = "gui.status.v1";
/// Project list method name.
pub const METHOD_PROJECT_LIST: &str = "project.list";
/// Project add method name.
pub const METHOD_PROJECT_ADD: &str = "project.add";
/// Capability advertised by a server that supports project queries.
pub const CAPABILITY_PROJECT: &str = "project.v1";
/// File open method name.
pub const METHOD_FILE_OPEN: &str = "file.open";
/// Capability advertised by a server that can open files.
pub const CAPABILITY_FILE_OPEN: &str = "file.open.v1";
/// Capability advertised by a server that completes `file.open` waits with an
/// opened/failed receipt instead of returning after acceptance.
pub const CAPABILITY_FILE_OPEN_WAIT: &str = "file.open.wait.v1";
/// 当前工作区文本编辑器缓冲的查询方法。
pub const METHOD_WORKSPACE_CURRENT_DOCUMENT: &str = "workspace.current_document";
/// 当前工作区终端绑定的查询方法。
pub const METHOD_WORKSPACE_CURRENT_TERMINAL: &str = "workspace.current_terminal";
/// GUI 内存中的当前文本编辑器缓冲能力。
pub const CAPABILITY_WORKSPACE_CURRENT_DOCUMENT: &str = "workspace.current_document.v1";
/// 同一文档查询的按行范围与快照守卫扩展，不是另一套读取方法。
pub const CAPABILITY_WORKSPACE_DOCUMENT_RANGE: &str = "workspace.current_document.range.v1";
/// GUI 当前终端绑定的发现能力。
pub const CAPABILITY_WORKSPACE_CURRENT_TERMINAL: &str = "workspace.current_terminal.v1";
/// 知识整理用的会话摘要：项目（含 worktree）在游标之后的 Agent 会话文本。
pub const METHOD_KNOWLEDGE_DIGEST: &str = "knowledge.digest";
/// GUI 能按项目读取 Agent 会话并生成知识摘要。
pub const CAPABILITY_KNOWLEDGE_DIGEST: &str = "knowledge.digest.v1";
/// Agent hook 报告了状态或群组变化：GUI 立即刷新 pane 状态与群组，不等轮询。
pub const METHOD_AGENT_CHANGED: &str = "agent.changed";
/// GUI 接受 Agent 变化通知。
pub const CAPABILITY_AGENT_CHANGED: &str = "agent.changed.v1";
/// 工作区摘录的默认行数。
pub const DEFAULT_EXCERPT_LINES: u32 = 80;
/// 工作区摘录允许请求的最大行数。
pub const MAX_EXCERPT_LINES: u32 = 4096;
/// 工作区摘录默认的 UTF-8 字节上限。
pub const DEFAULT_EXCERPT_BYTES: usize = 8 * 1024;
/// 工作区摘录的 UTF-8 字节硬上限。
pub const MAX_EXCERPT_BYTES: usize = 256 * 1024;
/// Maximum encoded size of one newline-delimited frame, including newline.
pub const MAX_FRAME_BYTES: usize = 1_048_576;

/// JSON-RPC error code for an invalid request object.
pub const RPC_INVALID_REQUEST: i32 = -32_600;
/// JSON-RPC error code for an unknown method.
pub const RPC_METHOD_NOT_FOUND: i32 = -32_601;
/// JSON-RPC error code for invalid method parameters.
pub const RPC_INVALID_PARAMS: i32 = -32_602;
/// JSON-RPC error code for an internal server failure.
pub const RPC_INTERNAL_ERROR: i32 = -32_603;
/// JSON-RPC application error code for a wire-version mismatch.
pub const RPC_INCOMPATIBLE_VERSION: i32 = -32_001;
/// JSON-RPC application error code for a missing target.
pub const RPC_NOT_FOUND: i32 = -32_002;
/// JSON-RPC application error code for a policy refusal.
pub const RPC_REJECTED: i32 = -32_003;
/// JSON-RPC application error code for an operation that timed out after the
/// connection was established.  The operation may still have side effects.
pub const RPC_TIMEOUT: i32 = -32_004;
/// 终端 daemon 不可达时的 JSON-RPC 应用错误码。
pub const RPC_DAEMON_UNAVAILABLE: i32 = -32_005;
/// 当前 GUI 快照已改变，无法沿旧版本继续读取。
pub const RPC_STALE_SNAPSHOT: i32 = -32_006;

/// Stable machine-readable error kinds carried in `error.data.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The JSON-RPC object or required field is invalid.
    InvalidRequest,
    /// The method is not implemented by this server.
    MethodNotFound,
    /// Method parameters have the wrong shape or value.
    InvalidParams,
    /// The server could not complete a valid request.
    Internal,
    /// The peer and server do not share a wire version or capability.
    IncompatibleVersion,
    /// The referenced project or file does not exist.
    NotFound,
    /// 终端 daemon 不可达；GUI 不会因查询而启动它。
    DaemonUnavailable,
    /// 文档切换、提交、清空或 GUI 重启使显式快照引用失效。
    StaleSnapshot,
    /// The server refused the request by policy.
    Rejected,
    /// The operation exceeded its deadline after acceptance.  The outcome is
    /// unknown: the operation may already have started or completed.
    Timeout,
}

/// Additional stable data attached to a JSON-RPC error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcErrorData {
    /// Stable error kind.
    pub kind: ErrorKind,
}

/// JSON-RPC 2.0 request used by the control protocol.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcRequest {
    /// JSON-RPC protocol marker.
    pub jsonrpc: String,
    /// Numeric request identifier.
    pub id: u64,
    /// Method name.
    pub method: String,
    /// Method parameters.  The control methods require an object.
    pub params: serde_json::Value,
}

impl RpcRequest {
    /// Creates a request with the canonical JSON-RPC marker.
    #[must_use]
    pub fn new(id: u64, method: impl Into<String>, params: serde_json::Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            method: method.into(),
            params,
        }
    }

    /// Creates a hello request.
    #[must_use]
    pub fn hello(id: u64, params: HelloParams) -> Self {
        let params = serde_json::json!({
            "wire_version": params.wire_version,
            "client": params.client,
            "capabilities": params.capabilities,
        });
        Self::new(id, METHOD_HELLO, params)
    }

    /// Creates an empty GUI status request.
    #[must_use]
    pub fn gui_status(id: u64) -> Self {
        Self::new(id, METHOD_GUI_STATUS, serde_json::json!({}))
    }

    /// Creates a project list request.
    #[must_use]
    pub fn project_list(id: u64, scope: ProjectScope) -> Self {
        Self::new(
            id,
            METHOD_PROJECT_LIST,
            serde_json::json!({ "scope": scope }),
        )
    }

    /// Creates a project add request.
    #[must_use]
    pub fn project_add(id: u64, path: impl Into<String>) -> Self {
        Self::new(
            id,
            METHOD_PROJECT_ADD,
            serde_json::json!({ "path": path.into() }),
        )
    }

    /// Creates a file open request.
    #[must_use]
    pub fn file_open(id: u64, path: impl Into<String>, line: Option<u32>) -> Self {
        let mut params = serde_json::json!({ "path": path.into() });
        if let Some(line) = line {
            params["line"] = serde_json::json!(line);
        }
        Self::new(id, METHOD_FILE_OPEN, params)
    }

    /// 创建当前 GUI 文本编辑器缓冲的只读查询。
    #[must_use]
    pub fn workspace_current_document(id: u64, params: WorkspaceDocumentParams) -> Self {
        let mut value = serde_json::json!({ "lines": params.lines });
        if let Some(offset) = params.offset {
            value["offset"] = serde_json::json!(offset);
        }
        if let Some(reference) = params.snapshot_ref {
            value["snapshot_ref"] = serde_json::json!(reference);
        }
        Self::new(id, METHOD_WORKSPACE_CURRENT_DOCUMENT, value)
    }

    /// 创建知识整理会话摘要的只读查询。
    #[must_use]
    pub fn knowledge_digest(id: u64, params: &KnowledgeDigestParams) -> Self {
        Self::new(
            id,
            METHOD_KNOWLEDGE_DIGEST,
            serde_json::to_value(params).unwrap_or_default(),
        )
    }

    /// 创建 Agent 变化通知（无参数，只作唤醒）。
    #[must_use]
    pub fn agent_changed(id: u64) -> Self {
        Self::new(id, METHOD_AGENT_CHANGED, serde_json::json!({}))
    }

    /// 创建当前 GUI 终端绑定的只读查询。
    #[must_use]
    pub fn workspace_current_terminal(id: u64) -> Self {
        Self::new(id, METHOD_WORKSPACE_CURRENT_TERMINAL, serde_json::json!({}))
    }

    /// Creates a file open request that waits for the opened/failed receipt.
    ///
    /// Requires the server capability [`CAPABILITY_FILE_OPEN_WAIT`].
    #[must_use]
    pub fn file_open_wait(
        id: u64,
        path: impl Into<String>,
        line: Option<u32>,
        timeout_ms: u64,
    ) -> Self {
        let mut params =
            serde_json::json!({ "path": path.into(), "wait": true, "timeout_ms": timeout_ms });
        if let Some(line) = line {
            params["line"] = serde_json::json!(line);
        }
        Self::new(id, METHOD_FILE_OPEN, params)
    }
}

/// JSON-RPC 2.0 response used by the control protocol.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcResponse {
    /// JSON-RPC protocol marker.
    pub jsonrpc: String,
    /// Request identifier echoed by the server.
    pub id: u64,
    /// Successful result, mutually exclusive with `error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Error result, mutually exclusive with `result`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    /// Creates a successful response by serializing `result`.
    pub fn success<T: Serialize>(id: u64, result: &T) -> Result<Self, serde_json::Error> {
        Ok(Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: Some(serde_json::to_value(result)?),
            error: None,
        })
    }

    /// Creates an error response.
    #[must_use]
    pub fn failure(id: u64, code: i32, message: impl Into<String>, kind: ErrorKind) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data: Some(RpcErrorData { kind }),
            }),
        }
    }

    /// Returns the typed successful result, or the wire error.
    pub fn decode_result<T: DeserializeOwned>(self) -> Result<T, RpcError> {
        if self.result.is_some() && self.error.is_some() {
            return Err(RpcError {
                code: RPC_INTERNAL_ERROR,
                message: "response contained both result and error".to_owned(),
                data: Some(RpcErrorData {
                    kind: ErrorKind::Internal,
                }),
            });
        }
        if let Some(error) = self.error {
            return Err(error);
        }
        let result = self.result.ok_or_else(|| RpcError {
            code: RPC_INTERNAL_ERROR,
            message: "response contained neither result nor error".to_owned(),
            data: Some(RpcErrorData {
                kind: ErrorKind::Internal,
            }),
        })?;
        serde_json::from_value(result).map_err(|error| RpcError {
            code: RPC_INTERNAL_ERROR,
            message: format!("invalid response result: {error}"),
            data: Some(RpcErrorData {
                kind: ErrorKind::Internal,
            }),
        })
    }
}

/// JSON-RPC error object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    /// JSON-RPC error code.
    pub code: i32,
    /// Human-readable diagnostic.
    pub message: String,
    /// Stable machine-readable error data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<RpcErrorData>,
}

/// Client identity sent in the hello request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloClient {
    /// Client product name.
    pub name: String,
    /// Client product version.
    pub version: String,
}

/// Hello request parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloParams {
    /// Requested control wire version.
    pub wire_version: u32,
    /// Client identity.
    pub client: HelloClient,
    /// Capabilities the client may use.
    pub capabilities: Vec<String>,
}

/// Server identity returned by the hello response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloServer {
    /// Server product name.
    pub name: String,
    /// Server product version.
    pub version: String,
    /// Server process id.
    pub pid: u32,
}

/// Hello response result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloResult {
    /// Negotiated control wire version.
    pub wire_version: u32,
    /// Server identity.
    pub server: HelloServer,
    /// Capabilities available on this server.
    pub capabilities: Vec<String>,
}

/// Read-only GUI control-server status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuiStatus {
    /// GUI build version.
    pub version: String,
    /// GUI process id.
    pub pid: u32,
    /// Control wire version.
    pub wire_version: u32,
    /// Capabilities exposed by the control server.
    pub capabilities: Vec<String>,
}

/// Project list request scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectScope {
    /// Only projects currently open in the workspace.
    Open,
    /// Every registered project.
    All,
}

/// Parameters for [`METHOD_PROJECT_LIST`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectListParams {
    /// Which projects to return.
    pub scope: ProjectScope,
}

/// One project entry returned by [`METHOD_PROJECT_LIST`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// Project id, stable across sessions.
    pub id: i64,
    /// Absolute project path.
    pub path: String,
    /// Display name.
    pub name: String,
    /// Whether the project is currently open in the workspace.
    pub is_open: bool,
}

/// Parameters for [`METHOD_PROJECT_ADD`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectAddParams {
    /// Absolute directory path to add.
    pub path: String,
}

/// Result of [`METHOD_PROJECT_ADD`]: the upserted project.
pub type ProjectAddResult = ProjectEntry;

/// Parameters for [`METHOD_FILE_OPEN`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileOpenParams {
    /// Absolute file path.
    pub path: String,
    /// Optional 1-based line to reveal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// When `true`, the server waits for the main window's opened/failed
    /// receipt instead of returning after acceptance.  Requires
    /// [`CAPABILITY_FILE_OPEN_WAIT`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<bool>,
    /// Wait deadline in milliseconds.  Only meaningful with `wait: true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// Result of [`METHOD_FILE_OPEN`]: the open request was delivered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileOpenResult {
    /// Whether the GUI accepted the request.
    pub accepted: bool,
}

/// Terminal state of a waited file open, reported by the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpenState {
    /// The file loaded, activated, and any supported line reveal finished.
    Opened,
    /// The workspace could not open or reveal the file.
    Failed,
}

/// Result of [`METHOD_FILE_OPEN`] with `wait: true`: the actual outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileOpenWaitResult {
    /// The GUI accepted the request.
    pub accepted: bool,
    /// Terminal state of the open attempt.
    pub state: FileOpenState,
    /// Absolute path the workspace acted on.
    pub path: String,
    /// Line actually revealed, when known.  `null` when the request had no
    /// line or the workspace cannot report the settled line.
    pub line: Option<u32>,
    /// Failure diagnostic for [`FileOpenState::Failed`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Parameters for [`METHOD_KNOWLEDGE_DIGEST`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeDigestParams {
    /// 项目或其 worktree 的绝对路径；摘要覆盖整个项目族。
    pub path: String,
    /// RFC 3339 游标，只取之后的消息；省略时读全部历史。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/// Result of [`METHOD_KNOWLEDGE_DIGEST`]：按最后活动时间升序。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeDigestResult {
    /// 有新消息的会话。
    pub sessions: Vec<KnowledgeDigestSession>,
    /// 下一次调用的游标（本次已包含的最新消息时间）。
    pub next_since: String,
    /// 超出单次预算被截断；用 `next_since` 继续读。
    pub truncated: bool,
    /// 读取失败而跳过的会话。
    pub skipped: Vec<String>,
}

/// 摘要里的一个会话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeDigestSession {
    /// Agent 标识（`snake_case`）。
    pub agent: String,
    /// Agent 原生会话 id。
    pub id: String,
    /// 会话标题。
    pub title: Option<String>,
    /// 会话所在的项目或 worktree 路径。
    pub cwd: String,
    /// 开始时间（RFC 3339）。
    pub started_at: String,
    /// 游标之后的用户与助手消息，已截断。
    pub messages: Vec<KnowledgeDigestMessage>,
}

/// 摘要里的一条消息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeDigestMessage {
    /// `user` 或 `assistant`。
    pub role: String,
    /// 纯文本。
    pub text: String,
}

/// 文档读取参数；终端 capture 仍只接受 [`WorkspaceExcerptParams`] 的尾部预算。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceDocumentParams {
    /// 行数预算，省略时使用默认行数和默认字节上限。
    #[serde(default)]
    pub lines: Option<u32>,
    /// 1-based 起始行；省略时保留旧的尾部读取行为。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// 首读返回的当前快照引用；不保留或恢复历史快照。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
}

impl WorkspaceDocumentParams {
    /// 在连接 GUI 前校验范围与引用格式，复用正文预算规则。
    pub fn limits(&self) -> Result<(u32, usize), &'static str> {
        if self.offset == Some(0) {
            return Err("offset must be a positive 1-based line number");
        }
        if let Some(reference) = &self.snapshot_ref {
            let parts = reference
                .strip_prefix("v1.")
                .and_then(|value| value.split_once('.'));
            let valid = parts.is_some_and(|(scope, revision)| {
                scope.len() == 32
                    && scope
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    && !revision.starts_with('0')
                    && revision.bytes().all(|byte| byte.is_ascii_digit())
                    && revision.parse::<u64>().is_ok_and(|value| value > 0)
            });
            if reference.len() > 96 || !valid {
                return Err("invalid snapshot ref; use the reference from a current-file result");
            }
        }
        WorkspaceExcerptParams { lines: self.lines }.limits()
    }

    /// 扩展参数必须协商独立能力，旧 GUI 不得忽略它们后返回成功。
    #[must_use]
    pub fn required_capability(&self) -> &'static str {
        if self.offset.is_some() || self.snapshot_ref.is_some() {
            CAPABILITY_WORKSPACE_DOCUMENT_RANGE
        } else {
            CAPABILITY_WORKSPACE_CURRENT_DOCUMENT
        }
    }
}

/// 有界的尾部摘录参数，供终端 capture 与文档预算复用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceExcerptParams {
    /// 末尾行数；省略时使用 [`DEFAULT_EXCERPT_LINES`]。
    #[serde(default)]
    pub lines: Option<u32>,
}

impl WorkspaceExcerptParams {
    /// 校验行数预算并返回行数和字节数上限。
    pub fn limits(self) -> Result<(u32, usize), &'static str> {
        match self.lines {
            Some(lines) if lines == 0 || lines > MAX_EXCERPT_LINES => {
                Err("lines must be between 1 and 4096")
            }
            Some(lines) => Ok((lines, MAX_EXCERPT_BYTES)),
            None => Ok((DEFAULT_EXCERPT_LINES, DEFAULT_EXCERPT_BYTES)),
        }
    }
}

/// 返回快照末尾最多 `lines` 行及 `max_bytes` 个 UTF-8 字节。
/// 布尔值表示是否按任一上限截断。
#[must_use]
pub fn excerpt_tail(text: &str, lines: u32, max_bytes: usize) -> (String, bool) {
    let mut start = text.len();
    let mut remaining = lines;
    if start > 0 && text.as_bytes()[start - 1] == b'\n' {
        start -= 1;
    }
    while remaining > 0 {
        remaining -= 1;
        match text[..start].rfind('\n') {
            Some(index) => start = index,
            None => {
                start = 0;
                break;
            }
        }
    }
    if start > 0 {
        start += 1;
    }
    let by_lines = &text[start..];
    let mut byte_start = by_lines.len().saturating_sub(max_bytes);
    while !by_lines.is_char_boundary(byte_start) {
        byte_start += 1;
    }
    if byte_start > 0 && by_lines.as_bytes().get(byte_start) == Some(&b'\n') {
        byte_start += 1;
    }
    (
        by_lines[byte_start..].to_owned(),
        start > 0 || byte_start > 0,
    )
}

/// [`METHOD_WORKSPACE_CURRENT_DOCUMENT`] 的结果，始终来自 GUI 缓冲。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceDocumentResult {
    /// 当前选中文件的绝对路径。
    pub source_path: String,
    /// 已提交编辑器缓冲的 UTF-8 文本摘录。
    pub content: String,
    /// 缓冲提交时的 Unix 毫秒时间戳。
    pub committed_at_ms: u64,
    /// 进程内单调递增的修订号，包括清空操作。
    pub revision: u64,
    /// 输入缓冲或输出摘录是否被截断。
    pub truncated: bool,
    /// 当前进程内的快照引用；旧 v1 GUI 可能不提供，不能据此安全续读。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
    /// 原始缓冲中的实际行范围；旧 v1 GUI 可省略，不填伪造的默认范围。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<WorkspaceDocumentRange>,
}

/// 文本片段在原始 GUI 缓冲中的位置；末尾换行符不额外计一行，空文件计一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceDocumentRange {
    /// 片段首行，1-based；可能是按字节裁剪后的半行。
    pub start_line: u64,
    /// 片段末行，1-based 且包含在结果中。
    pub end_line: u64,
    /// 输入缓冲截取前的总行数。
    pub total_lines: u64,
    /// 内存保留片段在原缓冲中的首行，不保证该行完整。
    pub available_start_line: u64,
    /// 片段是否包含首行开头。
    pub start_line_complete: bool,
    /// 片段是否包含末行结尾；false 时不能跨过本行继续。
    pub end_line_complete: bool,
    /// 仅在可以无遗漏地按行续读时提供；同快照的下一起始行。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

/// [`METHOD_WORKSPACE_CURRENT_TERMINAL`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceTerminalResult {
    /// GUI 当前选中的终端标签 ID。
    pub terminal_id: String,
    /// 带版本的绑定引用，不是权限凭证。
    pub target_ref: String,
}

/// 作为单个 CLI 参数传递的有界、不透明目标绑定引用。
/// 它标识终端身份，不提供授权或加密。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetBindingRef {
    /// 编码格式的版本。
    pub version: u8,
    /// GUI 记录的 daemon epoch；仅旧 daemon 可能没有。
    pub daemon_instance: Option<String>,
    /// 捕获时的 session 名称。
    pub session: String,
    /// 稳定 pane ID，绝不是 pane 槽位。
    pub pane_id: u32,
    /// 捕获时 pane 进程的 generation。
    pub generation: u64,
}

impl TargetBindingRef {
    /// 为 CLI 编码有界引用，不记录其内容。
    pub fn encode(&self) -> Result<String, &'static str> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| "cannot encode target ref")?;
        let encoded = format!("v1.{}", URL_SAFE_NO_PAD.encode(bytes));
        if encoded.len() > 1024 {
            return Err("target ref is too long");
        }
        Ok(encoded)
    }

    /// 解析显式传入的 CLI 引用，拒绝未知版本与超长输入。
    pub fn decode(reference: &str) -> Result<Self, &'static str> {
        if reference.len() > 1024 {
            return Err("target ref is too long");
        }
        let encoded = reference
            .strip_prefix("v1.")
            .ok_or("unsupported target ref version")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "invalid target ref encoding")?;
        let binding: Self =
            serde_json::from_slice(&bytes).map_err(|_| "invalid target ref payload")?;
        binding.validate()?;
        Ok(binding)
    }

    fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 {
            return Err("unsupported target ref version");
        }
        if self.session.is_empty() || self.session.len() > 256 || self.session.contains('\0') {
            return Err("invalid target ref session");
        }
        if self
            .daemon_instance
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 256)
        {
            return Err("invalid target ref daemon instance");
        }
        Ok(())
    }
}

/// Errors produced by newline frame encoding/decoding.
#[derive(Debug)]
pub enum FrameError {
    /// JSON serialization failed.
    Encode(serde_json::Error),
    /// JSON parsing failed.
    Decode(serde_json::Error),
    /// The encoded frame exceeds [`MAX_FRAME_BYTES`].
    TooLarge {
        /// Actual encoded frame length.
        actual: usize,
        /// Maximum accepted frame length.
        maximum: usize,
    },
    /// A frame contains a line break before its delimiter.
    EmbeddedNewline,
    /// A frame is empty after removing its delimiter.
    Empty,
    /// A frame does not end with the newline delimiter.
    MissingDelimiter,
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Encode(error) => write!(formatter, "failed to encode control frame: {error}"),
            Self::Decode(error) => write!(formatter, "failed to decode control frame: {error}"),
            Self::TooLarge { actual, maximum } => write!(
                formatter,
                "control frame is too large ({actual} bytes; maximum {maximum})"
            ),
            Self::EmbeddedNewline => {
                formatter.write_str("control frame contains an embedded newline")
            }
            Self::Empty => formatter.write_str("control frame is empty"),
            Self::MissingDelimiter => {
                formatter.write_str("control frame is missing its newline delimiter")
            }
        }
    }
}

impl std::error::Error for FrameError {}

/// Encodes one JSON value as a newline-delimited control frame.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, FrameError> {
    let mut bytes = serde_json::to_vec(value).map_err(FrameError::Encode)?;
    if bytes.iter().any(|byte| *byte == b'\n' || *byte == b'\r') {
        return Err(FrameError::EmbeddedNewline);
    }
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            actual: bytes.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    Ok(bytes)
}

/// 在 control 帧上限内编码响应；JSON 转义导致内容超过 1 MiB 时，
/// 返回带类型的拒绝响应，而不是直接断开连接。
pub fn encode_response_frame(response: &RpcResponse) -> Result<Vec<u8>, FrameError> {
    match encode_frame(response) {
        Ok(frame) => Ok(frame),
        Err(FrameError::TooLarge { .. }) => encode_frame(&RpcResponse::failure(
            response.id,
            error_code(ErrorKind::Rejected),
            "control response exceeds 1 MiB",
            ErrorKind::Rejected,
        )),
        Err(error) => Err(error),
    }
}

/// Decodes one newline-delimited control frame.
pub fn decode_frame<T: DeserializeOwned>(input: &[u8]) -> Result<T, FrameError> {
    if input.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            actual: input.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }

    if input.is_empty() {
        return Err(FrameError::Empty);
    }
    if input.last() != Some(&b'\n') {
        return Err(FrameError::MissingDelimiter);
    }

    let payload = &input[..input.len() - 1];
    if payload.is_empty() {
        return Err(FrameError::Empty);
    }
    if payload.iter().any(|byte| *byte == b'\n' || *byte == b'\r') {
        return Err(FrameError::EmbeddedNewline);
    }
    serde_json::from_slice(payload).map_err(FrameError::Decode)
}

/// Validates the common JSON-RPC request envelope.
pub fn validate_request(request: &RpcRequest) -> Result<(), ErrorKind> {
    if request.jsonrpc != JSONRPC_VERSION || request.method.is_empty() {
        return Err(ErrorKind::InvalidRequest);
    }
    Ok(())
}

/// Returns the JSON-RPC code associated with a stable error kind.
#[must_use]
pub const fn error_code(kind: ErrorKind) -> i32 {
    match kind {
        ErrorKind::InvalidRequest => RPC_INVALID_REQUEST,
        ErrorKind::MethodNotFound => RPC_METHOD_NOT_FOUND,
        ErrorKind::InvalidParams => RPC_INVALID_PARAMS,
        ErrorKind::Internal => RPC_INTERNAL_ERROR,
        ErrorKind::IncompatibleVersion => RPC_INCOMPATIBLE_VERSION,
        ErrorKind::NotFound => RPC_NOT_FOUND,
        ErrorKind::DaemonUnavailable => RPC_DAEMON_UNAVAILABLE,
        ErrorKind::StaleSnapshot => RPC_STALE_SNAPSHOT,
        ErrorKind::Rejected => RPC_REJECTED,
        ErrorKind::Timeout => RPC_TIMEOUT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_and_status_shapes_round_trip() {
        let hello = RpcRequest::hello(
            1,
            HelloParams {
                wire_version: CONTROL_WIRE_VERSION,
                client: HelloClient {
                    name: "berth-cli".to_owned(),
                    version: "0.31.1".to_owned(),
                },
                capabilities: Vec::new(),
            },
        );
        let encoded = encode_frame(&hello).expect("hello encodes");
        let decoded: RpcRequest = decode_frame(&encoded).expect("hello decodes");
        assert_eq!(decoded, hello);
        assert_eq!(decoded.method, METHOD_HELLO);

        let status = GuiStatus {
            version: "0.31.1".to_owned(),
            pid: 42,
            wire_version: CONTROL_WIRE_VERSION,
            capabilities: vec![CAPABILITY_GUI_STATUS.to_owned()],
        };
        let response = RpcResponse::success(2, &status).expect("status response");
        let encoded = encode_frame(&response).expect("status encodes");
        let decoded: RpcResponse = decode_frame(&encoded).expect("status decodes");
        assert_eq!(
            decoded.decode_result::<GuiStatus>().expect("typed status"),
            status
        );
    }

    #[test]
    fn errors_have_stable_codes_and_kinds() {
        let response = RpcResponse::failure(
            7,
            error_code(ErrorKind::IncompatibleVersion),
            "wire version mismatch",
            ErrorKind::IncompatibleVersion,
        );
        let json = serde_json::to_value(response).expect("error serializes");
        assert_eq!(json["error"]["code"], serde_json::json!(-32001));
        assert_eq!(json["error"]["data"]["kind"], "incompatible_version");
    }

    #[test]
    fn frame_limit_and_invalid_json_are_rejected() {
        let oversized = vec![b'a'; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            decode_frame::<serde_json::Value>(&oversized),
            Err(FrameError::TooLarge { .. })
        ));
        assert!(matches!(
            decode_frame::<serde_json::Value>(b"not-json\n"),
            Err(FrameError::Decode(_))
        ));
        assert!(matches!(
            decode_frame::<serde_json::Value>(b"\n"),
            Err(FrameError::Empty)
        ));
        assert!(matches!(
            decode_frame::<serde_json::Value>(b"{}"),
            Err(FrameError::MissingDelimiter)
        ));
        assert!(matches!(
            decode_frame::<serde_json::Value>(b"{}\r\n"),
            Err(FrameError::EmbeddedNewline)
        ));
    }

    #[test]
    fn escaped_workspace_excerpt_gets_bounded_error_instead_of_disconnection() {
        let result = WorkspaceDocumentResult {
            source_path: "/synthetic/control.txt".into(),
            content: "\u{0001}".repeat(MAX_EXCERPT_BYTES),
            committed_at_ms: 1,
            revision: 1,
            truncated: false,
            snapshot_ref: Some(format!("v1.{}.1", "a".repeat(32))),
            range: Some(WorkspaceDocumentRange {
                start_line: 1,
                end_line: 1,
                total_lines: 1,
                available_start_line: 1,
                start_line_complete: true,
                end_line_complete: true,
                next_offset: None,
            }),
        };
        let response = RpcResponse::success(7, &result).expect("workspace response");
        assert!(matches!(
            encode_frame(&response),
            Err(FrameError::TooLarge { .. })
        ));
        let frame = encode_response_frame(&response).expect("bounded error frame");
        let decoded: RpcResponse = decode_frame(&frame).expect("valid response frame");
        assert_eq!(decoded.id, 7);
        assert!(decoded.result.is_none());
        assert_eq!(
            decoded
                .error
                .and_then(|error| error.data)
                .map(|data| data.kind),
            Some(ErrorKind::Rejected)
        );
    }

    #[test]
    fn request_validation_only_checks_the_common_envelope() {
        let mut request = RpcRequest::gui_status(1);
        assert!(validate_request(&request).is_ok());
        request.jsonrpc = "1.0".to_owned();
        assert_eq!(validate_request(&request), Err(ErrorKind::InvalidRequest));
        request.jsonrpc = JSONRPC_VERSION.to_owned();
        request.method.clear();
        assert_eq!(validate_request(&request), Err(ErrorKind::InvalidRequest));
        request.method = METHOD_GUI_STATUS.to_owned();
        request.params = serde_json::json!(null);
        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn project_and_file_shapes_round_trip() {
        let list = RpcRequest::project_list(1, ProjectScope::All);
        let encoded = encode_frame(&list).expect("list encodes");
        let decoded: RpcRequest = decode_frame(&encoded).expect("list decodes");
        assert_eq!(decoded.method, METHOD_PROJECT_LIST);
        let params: ProjectListParams =
            serde_json::from_value(decoded.params).expect("list params");
        assert_eq!(params.scope, ProjectScope::All);

        let entry = ProjectEntry {
            id: 12,
            path: "/home/u/proj".to_owned(),
            name: "proj".to_owned(),
            is_open: true,
        };
        let response = RpcResponse::success(2, &vec![entry.clone()]).expect("entries");
        let entries: Vec<ProjectEntry> = response.decode_result().expect("typed entries");
        assert_eq!(entries, vec![entry]);

        let open = RpcRequest::file_open(3, "/tmp/a.rs", Some(42));
        let encoded = encode_frame(&open).expect("open encodes");
        let decoded: RpcRequest = decode_frame(&encoded).expect("open decodes");
        let params: FileOpenParams = serde_json::from_value(decoded.params).expect("open params");
        assert_eq!(params.path, "/tmp/a.rs");
        assert_eq!(params.line, Some(42));

        // line 字段缺省时不参与序列化。
        let without_line = FileOpenParams {
            path: "/tmp/a.rs".to_owned(),
            line: None,
            wait: None,
            timeout_ms: None,
        };
        assert_eq!(
            serde_json::to_string(&without_line).expect("params json"),
            r#"{"path":"/tmp/a.rs"}"#
        );

        let accepted = FileOpenResult { accepted: true };
        let response = RpcResponse::success(4, &accepted).expect("accepted");
        let result: FileOpenResult = response.decode_result().expect("typed accepted");
        assert!(result.accepted);
    }

    #[test]
    fn file_open_wait_shapes_round_trip() {
        let request = RpcRequest::file_open_wait(5, "/tmp/a.rs", Some(42), 30_000);
        let decoded: FileOpenParams = serde_json::from_value(request.params).expect("wait params");
        assert_eq!(decoded.path, "/tmp/a.rs");
        assert_eq!(decoded.line, Some(42));
        assert_eq!(decoded.wait, Some(true));
        assert_eq!(decoded.timeout_ms, Some(30_000));

        // 旧客户端的请求不带 wait 字段，反序列化保持兼容。
        let legacy: FileOpenParams =
            serde_json::from_value(serde_json::json!({ "path": "/tmp/a.rs" }))
                .expect("legacy params");
        assert_eq!(legacy.wait, None);

        let opened = FileOpenWaitResult {
            accepted: true,
            state: FileOpenState::Opened,
            path: "/tmp/a.rs".to_owned(),
            line: None,
            message: None,
        };
        let json = serde_json::to_value(&opened).expect("wait result json");
        assert_eq!(json["state"], serde_json::json!("opened"));
        assert!(json.get("message").is_none());
        let decoded: FileOpenWaitResult =
            serde_json::from_value(json).expect("wait result round trip");
        assert_eq!(decoded, opened);

        let failed = FileOpenWaitResult {
            accepted: true,
            state: FileOpenState::Failed,
            path: "/tmp/a.rs".to_owned(),
            line: None,
            message: Some("reveal timed out".to_owned()),
        };
        let json = serde_json::to_value(&failed).expect("failed json");
        assert_eq!(json["state"], serde_json::json!("failed"));
        assert_eq!(json["message"], serde_json::json!("reveal timed out"));
    }

    #[test]
    fn workspace_excerpt_and_control_shapes_are_bounded() {
        let params: WorkspaceExcerptParams = serde_json::from_value(
            RpcRequest::workspace_current_document(1, WorkspaceDocumentParams::default()).params,
        )
        .unwrap();
        assert_eq!(params.limits(), Ok((80, 8192)));
        assert_eq!(
            WorkspaceExcerptParams { lines: Some(4096) }.limits(),
            Ok((4096, 262144))
        );
        assert!(WorkspaceExcerptParams { lines: Some(0) }.limits().is_err());
        assert!(WorkspaceExcerptParams { lines: Some(4097) }
            .limits()
            .is_err());
        assert_eq!(
            RpcRequest::workspace_current_terminal(2).method,
            METHOD_WORKSPACE_CURRENT_TERMINAL
        );
        let (excerpt, truncated) = excerpt_tail("first\n第二\nlast\n", 2, 7);
        assert_eq!(excerpt, "last\n");
        assert!(truncated);
        let (excerpt, truncated) = excerpt_tail("界界界", 80, 4);
        assert_eq!(excerpt, "界");
        assert!(truncated);
        let (excerpt, truncated) = excerpt_tail("alpha\nbeta\n", 80, 8192);
        assert_eq!(excerpt, "alpha\nbeta\n");
        assert!(!truncated);
    }

    #[test]
    fn workspace_document_range_parameters_are_bounded_and_separate_from_terminal() {
        let defaults = WorkspaceDocumentParams::default();
        assert_eq!(defaults.limits(), Ok((80, 8192)));
        assert_eq!(
            defaults.required_capability(),
            CAPABILITY_WORKSPACE_CURRENT_DOCUMENT
        );
        let reference = format!("v1.{}.42", "a".repeat(32));
        let params = WorkspaceDocumentParams {
            offset: Some(1),
            lines: Some(2),
            snapshot_ref: Some(reference.clone()),
        };
        assert_eq!(
            params.required_capability(),
            CAPABILITY_WORKSPACE_DOCUMENT_RANGE
        );
        assert_eq!(params.limits(), Ok((2, MAX_EXCERPT_BYTES)));
        let request = RpcRequest::workspace_current_document(3, params.clone());
        assert_eq!(
            serde_json::from_value::<WorkspaceDocumentParams>(request.params.clone()).unwrap(),
            params
        );
        assert!(serde_json::from_value::<WorkspaceExcerptParams>(request.params).is_err());
        for value in [
            serde_json::json!({"offset": -1}),
            serde_json::json!({"offset": 1.5}),
            serde_json::json!({"unknown": true}),
        ] {
            assert!(serde_json::from_value::<WorkspaceDocumentParams>(value).is_err());
        }
        for params in [
            WorkspaceDocumentParams {
                offset: Some(0),
                ..Default::default()
            },
            WorkspaceDocumentParams {
                lines: Some(0),
                ..Default::default()
            },
            WorkspaceDocumentParams {
                lines: Some(4097),
                ..Default::default()
            },
        ] {
            assert!(params.limits().is_err());
        }
        for reference in [
            "".into(),
            "v2.fake".into(),
            format!("v1.{}.0", "a".repeat(32)),
            format!("v1.{}.01", "a".repeat(32)),
            "x".repeat(97),
        ] {
            assert!(WorkspaceDocumentParams {
                snapshot_ref: Some(reference),
                ..Default::default()
            }
            .limits()
            .is_err());
        }
        assert_eq!(error_code(ErrorKind::StaleSnapshot), RPC_STALE_SNAPSHOT);
    }

    #[test]
    fn workspace_document_legacy_results_do_not_fabricate_range_metadata() {
        let old: WorkspaceDocumentResult = serde_json::from_value(serde_json::json!({
            "source_path": "/synthetic/old.txt", "content": "old buffer",
            "committed_at_ms": 1, "revision": 1, "truncated": false,
        }))
        .unwrap();
        assert!(old.snapshot_ref.is_none());
        assert!(old.range.is_none());
        assert!(serde_json::to_value(old).unwrap().get("range").is_none());
    }

    #[test]
    fn timeout_kind_has_a_stable_code() {
        assert_eq!(error_code(ErrorKind::Timeout), RPC_TIMEOUT);
        let response = RpcResponse::failure(1, RPC_TIMEOUT, "deadline", ErrorKind::Timeout);
        let json = serde_json::to_value(response).expect("timeout serializes");
        assert_eq!(json["error"]["code"], serde_json::json!(-32004));
        assert_eq!(json["error"]["data"]["kind"], serde_json::json!("timeout"));
        let parsed: RpcError = serde_json::from_value(json["error"].clone()).expect("parses");
        assert_eq!(parsed.data.expect("data").kind, ErrorKind::Timeout);
    }

    #[test]
    fn not_found_and_rejected_have_stable_codes() {
        for (kind, code) in [
            (ErrorKind::NotFound, RPC_NOT_FOUND),
            (ErrorKind::Rejected, RPC_REJECTED),
        ] {
            assert_eq!(error_code(kind), code);
            let response = RpcResponse::failure(1, code, "msg", kind);
            let json = serde_json::to_value(&response).expect("error serializes");
            assert_eq!(json["error"]["code"], serde_json::json!(code));
        }
        let parsed: RpcError = serde_json::from_value(serde_json::json!({
            "code": RPC_NOT_FOUND,
            "message": "missing",
            "data": { "kind": "not_found" }
        }))
        .expect("error decodes");
        assert_eq!(parsed.data.expect("data").kind, ErrorKind::NotFound);
    }

    #[test]
    fn response_with_result_and_error_is_rejected() {
        let response = RpcResponse {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id: 1,
            result: Some(serde_json::json!({"ok": true})),
            error: Some(RpcError {
                code: RPC_INTERNAL_ERROR,
                message: "internal".to_owned(),
                data: Some(RpcErrorData {
                    kind: ErrorKind::Internal,
                }),
            }),
        };
        let error = response
            .decode_result::<serde_json::Value>()
            .expect_err("both result and error must be invalid");
        assert_eq!(error.code, RPC_INTERNAL_ERROR);
        assert_eq!(
            error.data.as_ref().map(|data| data.kind),
            Some(ErrorKind::Internal)
        );
    }
}
