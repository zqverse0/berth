//! Control request handlers.
//!
//! Each handler reuses the same core implementation as the corresponding
//! Tauri command; the control socket adds no new business logic.

use std::sync::Arc;

use serde_json::Value;
use tauri::Manager;
use berth_control_proto::{
    ErrorKind, FileOpenParams, FileOpenResult, FileOpenState, FileOpenWaitResult,
    KnowledgeDigestParams, ProjectAddParams,
    ProjectEntry, ProjectListParams, ProjectScope, RpcRequest, TargetBindingRef,
    WorkspaceDocumentParams, WorkspaceTerminalResult,
};
use berth_project_core::service::catalog::{list_catalog, CatalogScope};

use super::pending;
use super::ControlContext;

/// 事件名：CLI `berth open` 请求 GUI 在 main 窗口打开文件。
pub(crate) const WORKSPACE_OPEN_FILE_EVENT: &str = "workspace://open-file";
/// `agent.changed` 转发给前端的唤醒事件（无载荷）。
pub(crate) const AGENT_CHANGED_EVENT: &str = "agent://changed";

/// 数据库与事件发射器依赖；`None` 表示控制面在无 deps 环境下运行
/// （例如单元测试中的裸 context），此时 project/file 方法返回内部错误。
#[derive(Clone)]
pub(crate) struct ControlDeps {
    pub(crate) db: Arc<crate::db::AppDatabase>,
    pub(crate) emitter: crate::event_bridge::EventEmitter,
    pub(crate) app: tauri::AppHandle,
}

type HandlerResult = Result<Value, (ErrorKind, String)>;

fn invalid_params(message: impl Into<String>) -> (ErrorKind, String) {
    (ErrorKind::InvalidParams, message.into())
}

fn internal(message: impl Into<String>) -> (ErrorKind, String) {
    (ErrorKind::Internal, message.into())
}

fn not_found(message: impl Into<String>) -> (ErrorKind, String) {
    (ErrorKind::NotFound, message.into())
}

fn rejected(message: impl Into<String>) -> (ErrorKind, String) {
    (ErrorKind::Rejected, message.into())
}

/// `gui.status`：只报告编译期版本与进程信息，不读数据库。
pub(crate) fn gui_status(request: &RpcRequest, context: &ControlContext) -> HandlerResult {
    if !request
        .params
        .as_object()
        .is_some_and(|params| params.is_empty())
    {
        return Err(invalid_params("gui.status expects an empty params object"));
    }
    serde_json::to_value(context.status())
        .map_err(|error| internal(format!("failed to encode gui.status: {error}")))
}

/// `agent.changed`：Agent hook 刚报告了状态或群组变化，唤醒前端立即重读（只作唤醒，不带数据）。
pub(crate) fn agent_changed(context: &ControlContext) -> HandlerResult {
    if let Some(deps) = context.deps.as_ref() {
        crate::event_bridge::emit_event(&deps.emitter, AGENT_CHANGED_EVENT, ());
    }
    Ok(serde_json::json!({}))
}

/// `knowledge.digest`：项目族的 Agent 会话摘要，供整理知识库；只读。
pub(crate) async fn knowledge_digest(
    request: &RpcRequest,
    context: &ControlContext,
) -> HandlerResult {
    let params: KnowledgeDigestParams = decode_params(request)?;
    let Some(deps) = context.deps.as_ref() else {
        return Err(internal("knowledge.digest requires runtime dependencies"));
    };
    let result = crate::knowledge::digest::digest(&deps.db.conn, params)
        .await
        .map_err(app_error_to_kind)?;
    serde_json::to_value(result)
        .map_err(|error| internal(format!("failed to encode knowledge.digest: {error}")))
}

/// `project.list`：scope=open 取当前打开，scope=all 取全部注册项目。
/// 两个 scope 都走共享 crate 的目录投影，与 CLI `berth project ls` 同源。
pub(crate) async fn project_list(request: &RpcRequest, context: &ControlContext) -> HandlerResult {
    let params: ProjectListParams = decode_params(request)?;
    let Some(deps) = context.deps.as_ref() else {
        return Err(internal("project.list requires runtime dependencies"));
    };
    let entries: Vec<ProjectEntry> = list_catalog(&deps.db.conn, catalog_scope(params.scope))
        .await
        .map_err(|error| app_error_to_kind(crate::app_error::AppCommandError::from(error)))?
        .into_iter()
        .map(|entry| ProjectEntry {
            id: i64::from(entry.id),
            path: entry.path,
            name: entry.name,
            is_open: entry.is_open,
        })
        .collect();
    serde_json::to_value(entries).map_err(|error| internal(format!("{error}")))
}

fn catalog_scope(scope: ProjectScope) -> CatalogScope {
    match scope {
        ProjectScope::Open => CatalogScope::Open,
        ProjectScope::All => CatalogScope::All,
    }
}

/// `project.add`：与 GUI 相同的 workspace 打开路径（写库 + 发事件）。
pub(crate) async fn project_add(request: &RpcRequest, context: &ControlContext) -> HandlerResult {
    let params: ProjectAddParams = decode_params(request)?;
    let path = std::path::PathBuf::from(&params.path);
    if !path.is_absolute() {
        return Err(invalid_params("path must be absolute"));
    }
    if !path.is_dir() {
        return Err(not_found(format!(
            "project path '{}' is not an existing directory",
            params.path
        )));
    }
    let Some(deps) = context.deps.as_ref() else {
        return Err(internal("project.add requires runtime dependencies"));
    };
    let detail = crate::commands::folders::open_folder_in_workspace_core(
        &deps.emitter,
        &deps.db,
        params.path,
    )
    .await
    .map_err(app_error_to_kind)?;
    let entry = entry_from_detail(detail);
    serde_json::to_value(entry).map_err(|error| internal(format!("{error}")))
}

/// `file.open` 默认等待预算（毫秒）。
const DEFAULT_WAIT_MS: u64 = 30_000;
/// 服务端等待上限（毫秒）：防止单个连接长期占住 handler。
const MAX_WAIT_MS: u64 = 120_000;

/// `file.open`：校验绝对路径存在且为文件，登记 pending 后经 EventEmitter
/// 唤醒主窗口。默认只回 accepted；`wait: true` 时等待主窗口回执终态。
///
/// 发事件或登记成功都不代表文件已打开 —— 打开的完成点在主窗口回执
/// （父契约 §4：不能以 `emit_event` 返回代替打开成功）。
pub(crate) async fn file_open(request: &RpcRequest, context: &ControlContext) -> HandlerResult {
    let params: FileOpenParams = decode_params(request)?;
    let path = std::path::PathBuf::from(&params.path);
    if !path.is_absolute() {
        return Err(invalid_params("path must be absolute"));
    }
    if !path.is_file() {
        return Err(not_found(format!(
            "file path '{}' does not name an existing file",
            params.path
        )));
    }
    let Some(deps) = context.deps.as_ref() else {
        return Err(internal("file.open requires runtime dependencies"));
    };
    let want_receipt = params.wait == Some(true);
    let wait_ms = params
        .timeout_ms
        .unwrap_or(DEFAULT_WAIT_MS)
        .min(MAX_WAIT_MS);
    let registered = super::pending::register(
        &params.path,
        params.line,
        std::time::Duration::from_millis(wait_ms),
        want_receipt,
    )
    .map_err(|_| rejected("open request queue is busy; retry later"))?;

    #[derive(serde::Serialize)]
    struct Payload<'a> {
        request_id: u64,
        path: &'a str,
        line: Option<u32>,
    }
    // 事件只作唤醒；主窗口以 claim 领取的列表为准，冷启动与订阅间隙
    // 的请求由 pending 注册表兜底（父契约 §4.2）。
    crate::event_bridge::emit_event(
        &deps.emitter,
        WORKSPACE_OPEN_FILE_EVENT,
        &Payload {
            request_id: registered.id,
            path: &params.path,
            line: params.line,
        },
    );

    if !want_receipt {
        return serde_json::to_value(FileOpenResult { accepted: true })
            .map_err(|error| internal(format!("{error}")));
    }

    let Some(receiver) = registered.receiver else {
        return Err(internal(
            "wait request registered without a receipt channel",
        ));
    };
    match tokio::time::timeout(std::time::Duration::from_millis(wait_ms), receiver).await {
        Ok(Ok(pending::OpenFileOutcome::Opened { path, line })) => {
            serde_json::to_value(FileOpenWaitResult {
                accepted: true,
                state: FileOpenState::Opened,
                path,
                line,
                message: None,
            })
            .map_err(|error| internal(format!("{error}")))
        }
        Ok(Ok(pending::OpenFileOutcome::Failed { message })) => {
            serde_json::to_value(FileOpenWaitResult {
                accepted: true,
                state: FileOpenState::Failed,
                path: params.path.clone(),
                line: None,
                message: Some(message),
            })
            .map_err(|error| internal(format!("{error}")))
        }
        // 等待方还在但通道关闭：注册表被清空（进程退出路径），无法结算。
        Ok(Err(_channel_closed)) => Err(internal(
            "open receipt channel closed before the window settled the request",
        )),
        // 超时后操作可能已经开始，不能声称取消成功（父契约 §4.5）。
        Err(_elapsed) => Err((
            ErrorKind::Timeout,
            "file.open wait timed out; the workspace may still open the file".to_owned(),
        )),
    }
}

fn visible_main(context: &ControlContext) -> Result<&ControlDeps, (ErrorKind, String)> {
    let deps = context
        .deps
        .as_ref()
        .ok_or_else(|| internal("workspace query requires runtime dependencies"))?;
    let visible = deps
        .app
        .get_webview_window("main")
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    if !visible {
        return Err(not_found("the main workspace window is not visible"));
    }
    Ok(deps)
}

/// 从独立内存槽读取已提交的文本编辑器缓冲，绝不回退读取磁盘。
pub(crate) async fn workspace_current_document(
    request: &RpcRequest,
    context: &ControlContext,
) -> HandlerResult {
    let params: WorkspaceDocumentParams = decode_params(request)?;
    params.limits().map_err(invalid_params)?;
    let deps = visible_main(context)?;
    let store = deps
        .app
        .try_state::<Arc<crate::workspace_state::current_document::CurrentDocumentContextStore>>()
        .ok_or_else(|| internal("workspace document store is unavailable"))?;
    let result = store.get_workspace(params).await.map_err(|error| {
        use crate::workspace_state::current_document::WorkspaceDocumentReadError;
        let kind = match &error {
            WorkspaceDocumentReadError::InvalidParams(_)
            | WorkspaceDocumentReadError::RangeUnavailable { .. } => ErrorKind::InvalidParams,
            WorkspaceDocumentReadError::NotFound => ErrorKind::NotFound,
            WorkspaceDocumentReadError::StaleSnapshot => ErrorKind::StaleSnapshot,
        };
        (kind, error.to_string())
    })?;
    visible_main(context)?;
    serde_json::to_value(result).map_err(|error| internal(error.to_string()))
}

/// 只从 GUI 当前终端 ID 得到已绑定 pane 身份；不读取终端正文。
pub(crate) async fn workspace_current_terminal(
    request: &RpcRequest,
    context: &ControlContext,
) -> HandlerResult {
    if !request
        .params
        .as_object()
        .is_some_and(|params| params.is_empty())
    {
        return Err(invalid_params(
            "workspace.current_terminal expects an empty params object",
        ));
    }
    let deps = visible_main(context)?;
    let selected = deps
        .app
        .try_state::<super::CurrentTerminalSelection>()
        .ok_or_else(|| internal("workspace terminal selection is unavailable"))?;
    let terminal_id = selected
        .get()
        .ok_or_else(|| not_found("no visible terminal is selected"))?;
    let manager = deps
        .app
        .try_state::<crate::terminal::manager::TerminalManager>()
        .ok_or_else(|| internal("terminal manager is unavailable"))?
        .clone_ref();
    // 留出 control 写帧时间，避免同步 SDK 排队或 IPC 挂起时让 CLI 只看见断连。
    let binding = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        tokio::task::spawn_blocking({
            let id = terminal_id.clone();
            move || manager.current_binding(&id)
        }),
    )
    .await
    .map_err(|_| {
        (
            ErrorKind::Timeout,
            "terminal binding lookup timed out".into(),
        )
    })?
    .map_err(|error| internal(format!("terminal binding task failed: {error}")))?
    .map_err(|error| match error {
        crate::terminal::error::TerminalError::NotFound(_)
        | crate::terminal::error::TerminalError::InstanceExpired(_) => {
            not_found("selected terminal binding is no longer live")
        }
        crate::terminal::error::TerminalError::RuntimeUnavailable(_) => (
            ErrorKind::DaemonUnavailable,
            "terminal daemon is unavailable".into(),
        ),
        err @ crate::terminal::error::TerminalError::Incompatible(_) => {
            (ErrorKind::IncompatibleVersion, err.to_string())
        }
        other => internal(other.to_string()),
    })?;
    visible_main(context)?;
    if selected.get().as_deref() != Some(terminal_id.as_str()) {
        return Err(not_found("selected terminal changed during binding lookup"));
    }
    let target_ref = TargetBindingRef {
        version: 1,
        daemon_instance: binding.daemon_instance,
        session: binding.session.as_str().to_owned(),
        pane_id: binding.pane_id.as_u32(),
        generation: binding.generation,
    }
    .encode()
    .map_err(invalid_params)?;
    serde_json::to_value(WorkspaceTerminalResult {
        terminal_id,
        target_ref,
    })
    .map_err(|error| internal(error.to_string()))
}

fn decode_params<T: serde::de::DeserializeOwned>(
    request: &RpcRequest,
) -> Result<T, (ErrorKind, String)> {
    serde_json::from_value(request.params.clone())
        .map_err(|error| invalid_params(format!("invalid parameters: {error}")))
}

fn entry_from_detail(detail: crate::models::FolderDetail) -> ProjectEntry {
    ProjectEntry {
        id: i64::from(detail.id),
        path: detail.path,
        name: detail.name,
        is_open: true,
    }
}

fn app_error_to_kind(error: crate::app_error::AppCommandError) -> (ErrorKind, String) {
    let message = error.message.clone();
    use crate::app_error::AppErrorCode as Code;
    match error.code {
        Code::NotFound => not_found(message),
        Code::InvalidInput => invalid_params(message),
        _ => internal(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_open_rejects_relative_and_missing_paths() {
        let context = ControlContext::current();
        let relative = RpcRequest::file_open(1, "relative.rs", None);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let error = runtime
            .block_on(file_open(&relative, &context))
            .expect_err("relative path must be rejected");
        assert_eq!(error.0, ErrorKind::InvalidParams);

        let directory = RpcRequest::file_open(2, "/tmp", None);
        let error = runtime
            .block_on(file_open(&directory, &context))
            .expect_err("directory must be rejected");
        // /tmp 存在但不是文件 → not_found（而非 internal 的缺 deps）。
        assert_eq!(error.0, ErrorKind::NotFound);
    }

    #[test]
    fn workspace_queries_reject_invalid_params_before_accessing_window_state() {
        let context = ControlContext::current();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let document = RpcRequest::workspace_current_document(
            1,
            WorkspaceDocumentParams {
                lines: Some(0),
                ..Default::default()
            },
        );
        let error = runtime
            .block_on(workspace_current_document(&document, &context))
            .expect_err("zero lines must be rejected");
        assert_eq!(error.0, ErrorKind::InvalidParams);

        let terminal = RpcRequest::new(
            2,
            berth_control_proto::METHOD_WORKSPACE_CURRENT_TERMINAL,
            serde_json::json!({"pane_index": 0}),
        );
        let error = runtime
            .block_on(workspace_current_terminal(&terminal, &context))
            .expect_err("terminal discovery never accepts a pane slot");
        assert_eq!(error.0, ErrorKind::InvalidParams);
    }

    #[test]
    fn project_add_rejects_relative_and_missing_paths() {
        let context = ControlContext::current();
        let relative = RpcRequest::project_add(1, "relative");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let error = runtime
            .block_on(project_add(&relative, &context))
            .expect_err("relative path must be rejected");
        assert_eq!(error.0, ErrorKind::InvalidParams);

        let missing = RpcRequest::project_add(2, "/nonexistent-dir-for-berth-test");
        let error = runtime
            .block_on(project_add(&missing, &context))
            .expect_err("missing path must be rejected");
        assert_eq!(error.0, ErrorKind::NotFound);
    }
}
