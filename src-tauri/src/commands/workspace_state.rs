use crate::app_error::AppCommandError;
use crate::event_bridge::EventEmitter;
use crate::workspace_state::WorkspaceSnapshotResponse;

pub(crate) async fn start_workspace_state_stream_core(
    emitter: EventEmitter,
    root_path: String,
    wants_tree_git: bool,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    crate::workspace_state::start_workspace_state_stream_core(emitter, root_path, wants_tree_git)
        .await
}

pub(crate) async fn stop_workspace_state_stream_core(
    root_path: String,
    wants_tree_git: bool,
) -> Result<(), AppCommandError> {
    crate::workspace_state::stop_workspace_state_stream_core(root_path, wants_tree_git).await
}

pub(crate) async fn get_workspace_snapshot_core(
    root_path: String,
    since_seq: Option<u64>,
    protocol_version: Option<u16>,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    // 不带版本的是旧客户端：只认整份与协议 1 的 delta。
    let accepts_patches = protocol_version.is_some_and(|version| version >= 2);
    crate::workspace_state::get_workspace_snapshot_core(root_path, since_seq, accepts_patches).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn start_workspace_state_stream<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root_path: String,
    wants_tree_git: Option<bool>,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    let emitter = EventEmitter::tauri(app);
    // Default true: absent param means a legacy full subscriber.
    start_workspace_state_stream_core(emitter, root_path, wants_tree_git.unwrap_or(true)).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stop_workspace_state_stream(
    root_path: String,
    wants_tree_git: Option<bool>,
) -> Result<(), AppCommandError> {
    stop_workspace_state_stream_core(root_path, wants_tree_git.unwrap_or(true)).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_workspace_snapshot(
    root_path: String,
    since_seq: Option<u64>,
    protocol_version: Option<u16>,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    get_workspace_snapshot_core(root_path, since_seq, protocol_version).await
}
