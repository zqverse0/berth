use std::collections::HashMap;

use crate::app_error::AppCommandError;
use crate::commands::primary_tabs::emit_primary_tabs_changed;
use crate::db::service::primary_tab_service;
use crate::event_bridge::EventEmitter;
use crate::git::credential;
use crate::terminal::manager::{CreateTerminalRequest, TerminalDescriptor, TerminalSessionManager};
use crate::terminal::protocol::{TerminalSnapshot, TerminalStatus};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

#[cfg(feature = "tauri-runtime")]
#[path = "terminal_packet.rs"]
mod terminal_packet;
#[cfg(feature = "tauri-runtime")]
#[path = "terminal_tauri.rs"]
mod terminal_tauri;
#[cfg(feature = "tauri-runtime")]
pub use terminal_tauri::{
    __cmd__terminal_attach_channel, __cmd__terminal_create, __cmd__terminal_detach,
    __cmd__terminal_get_session, __cmd__terminal_list_sessions, __cmd__terminal_remove_record,
    __cmd__terminal_resize_attached, __cmd__terminal_send_key, __cmd__terminal_send_line,
    __cmd__terminal_terminate,
    __cmd__terminal_write_attached_raw,
};
#[cfg(feature = "tauri-runtime")]
pub use terminal_tauri::{
    __tauri_command_name_terminal_attach_channel, __tauri_command_name_terminal_create,
    __tauri_command_name_terminal_detach, __tauri_command_name_terminal_get_session,
    __tauri_command_name_terminal_list_sessions, __tauri_command_name_terminal_remove_record,
    __tauri_command_name_terminal_resize_attached, __tauri_command_name_terminal_send_key,
    __tauri_command_name_terminal_send_line,
    __tauri_command_name_terminal_terminate, __tauri_command_name_terminal_write_attached_raw,
};
#[cfg(feature = "tauri-runtime")]
pub use terminal_tauri::{attach_terminal_to_sink, TerminalPacketSink};
#[cfg(feature = "tauri-runtime")]
pub use terminal_tauri::{
    terminal_attach_channel, terminal_create, terminal_detach, terminal_get_session,
    terminal_list_sessions, terminal_remove_record, terminal_resize_attached, terminal_send_key,
    terminal_send_line,
    terminal_terminate, terminal_write_attached_raw,
};
#[path = "terminal_types.rs"]
mod terminal_types;
pub use terminal_types::{
    CreatePersonalTerminalRequest, ResizeAttachedTerminalRequest, TerminalClientRequest,
    TerminalIdRequest,
};

const MAX_TERMINAL_INPUT_BYTES: usize = 1024 * 1024;

/// 桌面 Agent 启动只执行 `tools/<id>/launch.js`，由同版本 berth-cli 的内嵌引擎运行
/// （`berth-cli tools launch <脚本>`）。
/// 选项来自 launchbar.json，argv 由脚本拼接；Berth 不读 tool.json emit。
/// 启动失败应查该脚本或 `tools/<id>/`，不要改宿主。
///
/// 同一份 typed JSON 同时作为 `--berth-launch-inputs` 参数和
/// `BERTH_LAUNCH_INPUTS` 环境变量，脚本可打印对照，宿主不拼目标 CLI。
fn resolve_agent_launch(
    agent_id: &str,
    request: &CreatePersonalTerminalRequest,
) -> Result<(Option<String>, Vec<String>, HashMap<String, String>), AppCommandError> {
    berth_tool_core::plugins::ensure_enabled(agent_id)
        .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
    // 与 CLI `terminal create --agent` 同一份启动契约（berth-tool-core）。
    let Some((script, payload)) = berth_tool_core::paths::launch_script(
        &crate::tool::path::cli_tools_directory(),
        agent_id,
        request.agent_launch_inputs.clone().unwrap_or_default(),
    )
    .map_err(AppCommandError::configuration_invalid)?
    else {
        return Err(AppCommandError::not_found(format!(
            "no launch.js for agent '{agent_id}' under tools/{agent_id}/; \
             add a launch script — Berth does not splice Agent CLI arguments"
        )));
    };
    let cli = crate::terminal::manager::runtime::resolve_cli_binary().ok_or_else(|| {
        AppCommandError::not_found("berth-cli is missing next to Berth; reinstall Berth")
    })?;
    let executable = cli.to_string_lossy().into_owned();
    let mut argv = vec!["tools".to_string(), "launch".to_string()];
    argv.extend([
        script.to_string_lossy().into_owned(),
        "--berth-launch-inputs".to_string(),
        payload.clone(),
    ]);
    // 服务商覆盖是宿主通道（env 或 `-c`），不是 launchbar 选项。
    crate::tool::profile::append_extra_args(&mut argv, &request.provider_injection_args)?;
    let mut env = HashMap::new();
    env.insert("BERTH_LAUNCH_INPUTS".to_string(), payload);
    Ok((Some(executable), argv, env))
}

pub async fn create_terminal_core(
    manager: &TerminalSessionManager,
    emitter: EventEmitter,
    request: CreatePersonalTerminalRequest,
    extra_env: Option<HashMap<String, String>>,
) -> Result<TerminalDescriptor, AppCommandError> {
    let cwd = request.cwd.clone();
    let keep_on_failed_exit = request.agent_id.is_some();
    let (executable, args, request_env) = if let Some(agent_id) = request.agent_id.as_deref() {
        // 文件驱动：agent 启动只执行 tools/<id>/launch.js。
        resolve_agent_launch(agent_id, &request)?
    } else {
        (request.executable, request.args, request.env)
    };

    let result = manager
        .create_with_emitter(
            CreateTerminalRequest {
                terminal_id: request.terminal_id,
                cwd,
                shell: request.shell,
                initial_command: request.initial_command,
                executable,
                args,
                folder_id: request.folder_id,
                rows: request.rows,
                cols: request.cols,
                client_id: request.client_id,
                extra_env: if request_env.is_empty() {
                    extra_env
                } else {
                    let mut env = extra_env.unwrap_or_default();
                    for (key, value) in request_env {
                        if key.is_empty()
                            || key.contains('=')
                            || key.contains('\0')
                            || value.contains('\0')
                        {
                            return Err(AppCommandError::new(
                                crate::app_error::AppErrorCode::InvalidInput,
                                "managed command environment is invalid",
                            ));
                        }
                        env.insert(key, value);
                    }
                    Some(env)
                },
                temp_files: Vec::new(),
                keep_on_failed_exit,
            },
            emitter,
        )
        .await;
    result.map_err(AppCommandError::from)
}

pub fn list_terminals_core(
    manager: &TerminalSessionManager,
) -> Result<Vec<TerminalDescriptor>, AppCommandError> {
    manager.try_list().map_err(AppCommandError::from)
}

/// `tail_lines` 存在时同时读取 pane 末尾若干行纯文本（协作页「查看尾部输出」）。
pub fn get_terminal_core(
    manager: &TerminalSessionManager,
    request: TerminalIdRequest,
    tail_lines: Option<u32>,
) -> Result<TerminalDescriptor, AppCommandError> {
    let mut descriptor = manager
        .describe(&request.terminal_id)
        .map_err(AppCommandError::from)?;
    if let Some(lines) = tail_lines {
        let (lines, _) = berth_control_proto::WorkspaceExcerptParams { lines: Some(lines) }
            .limits()
            .map_err(AppCommandError::invalid_input)?;
        descriptor.tail = Some(
            manager
                .capture_tail(&request.terminal_id, lines)
                .map_err(AppCommandError::from)?,
        );
    }
    Ok(descriptor)
}

/// 不经 attach 向终端 pane 发送一个按键名（协作页「打断」）；上限同 CLI `--key`。
/// 不经 attach 向终端输入一行文本并回车（群组视图里「运行命令」），语义同 `berth terminal send --text` 加 `--key Enter`。
pub fn send_terminal_line_core(
    manager: &TerminalSessionManager,
    request: TerminalIdRequest,
    text: &str,
) -> Result<(), AppCommandError> {
    if text.trim().is_empty() || text.len() > 4096 || text.chars().any(char::is_control) {
        return Err(AppCommandError::invalid_input(
            "text must be one non-empty line of at most 4096 bytes",
        ));
    }
    manager
        .send_text_then_key(&request.terminal_id, text, "Enter")
        .map_err(AppCommandError::from)
}

pub fn send_terminal_key_core(
    manager: &TerminalSessionManager,
    request: TerminalIdRequest,
    key: &str,
) -> Result<(), AppCommandError> {
    if key.is_empty() || key.len() > 64 {
        return Err(AppCommandError::invalid_input("key must be 1-64 bytes"));
    }
    manager
        .send_key(&request.terminal_id, key)
        .map_err(AppCommandError::from)
}

/// Capture a sequence-consistent VT snapshot without registering a stream
/// subscriber. Live bytes go through the Tauri attach channel instead.
pub fn get_terminal_snapshot_core(
    manager: &TerminalSessionManager,
    request: TerminalIdRequest,
) -> Result<crate::terminal::protocol::TerminalSnapshot, AppCommandError> {
    manager
        .snapshot(&request.terminal_id)
        .map_err(AppCommandError::from)
}

/// Register an attach subscriber and return the sequence-N snapshot. The
/// caller drains the attachment's data/control lanes (Tauri Channel adapter).
/// Detach with [`detach_terminal_core`].
pub fn attach_terminal_core(
    manager: &TerminalSessionManager,
    request: TerminalClientRequest,
) -> Result<crate::terminal::protocol::TerminalAttachment, AppCommandError> {
    manager
        .attach(&request.terminal_id, &request.client_id)
        .map_err(AppCommandError::from)
}

pub fn detach_terminal_core(
    manager: &TerminalSessionManager,
    request: TerminalClientRequest,
) -> Result<(), AppCommandError> {
    manager
        .detach(&request.terminal_id, &request.client_id)
        .map_err(AppCommandError::from)
}

pub fn resize_terminal_core(
    manager: &TerminalSessionManager,
    request: ResizeAttachedTerminalRequest,
) -> Result<TerminalSnapshot, AppCommandError> {
    manager
        .resize_attached(
            &request.terminal_id,
            &request.client_id,
            request.input_sequence,
            request.cols,
            request.rows,
        )
        .map_err(AppCommandError::from)
}

pub async fn terminate_terminal_core(
    manager: &TerminalSessionManager,
    request: TerminalIdRequest,
) -> Result<(), AppCommandError> {
    manager
        .terminate(&request.terminal_id)
        .await
        .map_err(AppCommandError::from)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssociatedTerminalSummary {
    pub terminals: Vec<TerminalDescriptor>,
    pub running_count: usize,
    pub exited_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeTerminalDecision {
    Cancel,
    Terminate,
    ForceKeep,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDeletePreflightRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDeleteDecisionRequest {
    pub path: String,
    pub decision: WorktreeTerminalDecision,
}

fn summarize_terminals(terminals: Vec<TerminalDescriptor>) -> AssociatedTerminalSummary {
    let running_count = terminals
        .iter()
        .filter(|t| t.status == TerminalStatus::Running)
        .count();
    let exited_count = terminals.len().saturating_sub(running_count);
    AssociatedTerminalSummary {
        terminals,
        running_count,
        exited_count,
    }
}

/// Preflight seam for physical worktree deletion. Does not delete files.
pub async fn preflight_worktree_delete_core(
    manager: &TerminalSessionManager,
    path: &str,
) -> AssociatedTerminalSummary {
    let canonical = std::path::Path::new(path);
    summarize_terminals(manager.sessions_started_under(canonical))
}

/// Execute a worktree-terminal decision. Cancel is a no-op. Terminate kills
/// associated running PTYs. ForceKeep leaves processes running (caller may warn
/// about missing cwd later). Never invents a delete-UI — files are untouched.
pub async fn apply_worktree_terminal_decision_core(
    manager: &TerminalSessionManager,
    path: &str,
    decision: WorktreeTerminalDecision,
) -> Result<AssociatedTerminalSummary, AppCommandError> {
    let summary = preflight_worktree_delete_core(manager, path).await;
    match decision {
        WorktreeTerminalDecision::Cancel => Ok(summary),
        WorktreeTerminalDecision::ForceKeep => Ok(summary),
        WorktreeTerminalDecision::Terminate => {
            for terminal in &summary.terminals {
                if terminal.status == TerminalStatus::Running {
                    manager
                        .terminate(&terminal.terminal_id)
                        .await
                        .map_err(AppCommandError::from)?;
                }
            }
            Ok(preflight_worktree_delete_core(manager, path).await)
        }
    }
}

pub fn preflight_folder_terminal_removal_core(
    manager: &TerminalSessionManager,
    folder_id: i32,
) -> AssociatedTerminalSummary {
    summarize_terminals(manager.sessions_for_folder(folder_id))
}

pub async fn remove_terminal_record_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    manager: &TerminalSessionManager,
    request: TerminalIdRequest,
) -> Result<(), AppCommandError> {
    let descriptor = manager
        .describe(&request.terminal_id)
        .map_err(AppCommandError::from)?;
    if descriptor.status == TerminalStatus::Running {
        return Err(
            crate::terminal::error::TerminalError::StillRunning(request.terminal_id).into(),
        );
    }
    let invalidation = primary_tab_service::delete_terminal_tabs_and_bump(
        conn,
        &descriptor.terminal_id,
        &descriptor.backend_instance_id,
    )
    .await?;
    if let Some(tabs) = invalidation.emit {
        emit_primary_tabs_changed(
            emitter,
            invalidation.version,
            tabs,
            "terminal-record-remove".to_string(),
        );
    }
    manager
        .remove_record(&request.terminal_id)
        .map_err(AppCommandError::from)
}

/// Build extra env vars for the terminal session.
///
/// Uses `credential.helper` with a script that calls the app binary with
/// `--credential-helper`. The binary opens the DB, looks up the matching
/// account, and outputs credentials. No credentials are written to disk.
pub(crate) fn prepare_credential_env(
    app_data_dir: &std::path::Path,
) -> Option<HashMap<String, String>> {
    // Get the path to the current running binary
    let app_binary = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("[TERM] failed to get current exe path: {}", e);
            return None;
        }
    };

    let helper_script =
        match credential::create_credential_helper_script(app_data_dir, &app_binary) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("[TERM] failed to create credential helper script: {}", e);
                return None;
            }
        };

    let helper_path_str = helper_script.to_string_lossy().to_string();

    // GIT_CONFIG_COUNT adds config entries that are tried BEFORE file-based config.
    // For multi-valued keys like credential.helper, this means our helper runs first;
    // if it exits 0 with no output, git falls through to the user's existing helpers.
    let mut env = HashMap::new();
    env.insert("GIT_CONFIG_COUNT".to_string(), "1".to_string());
    env.insert(
        "GIT_CONFIG_KEY_0".to_string(),
        "credential.helper".to_string(),
    );
    // The '!' prefix tells git to run the rest as `sh -c <value>`. Single-quote
    // the path so spaces, `$`, backticks, etc. don't get re-interpreted by sh.
    env.insert(
        "GIT_CONFIG_VALUE_0".to_string(),
        format!("!{}", credential::sh_single_quote(&helper_path_str)),
    );

    Some(env)
}

#[cfg(all(test, unix))]
mod worktree_preflight_tests {
    use super::*;
    use crate::terminal::error::TerminalError;
    use crate::terminal::manager::{CreateTerminalRequest, TerminalManager};
    use berth_term_sdk::berth::Terminal;

    async fn shutdown_test_daemon(endpoint: &std::path::Path) {
        if let Ok(client) = Terminal::builder().unix_socket(endpoint).connect().await {
            client.shutdown().await.expect("shutdown test daemon");
        }
    }

    fn shell_request(command: &str, cwd: &str) -> CreateTerminalRequest {
        CreateTerminalRequest {
            terminal_id: None,
            cwd: cwd.to_string(),
            shell: Some("/bin/sh".to_string()),
            initial_command: Some(command.to_string()),
            executable: None,
            args: Vec::new(),
            folder_id: None,
            rows: 24,
            cols: 80,
            client_id: Some("client-a".to_string()),
            extra_env: None,
            temp_files: Vec::new(),
            keep_on_failed_exit: false,
        }
    }

    #[tokio::test]
    async fn worktree_terminal_decision_cancel_leaves_processes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().into_owned();
        let endpoint = dir.path().join("termd.sock");
        let manager = TerminalManager::with_test_endpoint(endpoint.clone());
        let terminal = manager
            .create(shell_request("sleep 30", &path))
            .await
            .expect("create");
        let summary = apply_worktree_terminal_decision_core(
            &manager,
            &path,
            WorktreeTerminalDecision::Cancel,
        )
        .await
        .expect("cancel");
        assert_eq!(summary.running_count, 1);
        assert_eq!(
            manager.describe(&terminal.terminal_id).unwrap().status,
            TerminalStatus::Running
        );
        manager
            .terminate(&terminal.terminal_id)
            .await
            .expect("cleanup terminal");
        shutdown_test_daemon(&endpoint).await;
    }

    #[tokio::test]
    async fn worktree_terminal_decision_terminate_kills_associated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().into_owned();
        let endpoint = dir.path().join("termd.sock");
        let manager = TerminalManager::with_test_endpoint(endpoint.clone());
        let terminal = manager
            .create(shell_request("sleep 30", &path))
            .await
            .expect("create");
        let summary = apply_worktree_terminal_decision_core(
            &manager,
            &path,
            WorktreeTerminalDecision::Terminate,
        )
        .await
        .expect("terminate");
        assert!(matches!(
            manager.describe(&terminal.terminal_id),
            Err(TerminalError::NotFound(id)) if id == terminal.terminal_id
        ));
        assert_eq!(summary.running_count, 0);
        shutdown_test_daemon(&endpoint).await;
    }

    #[tokio::test]
    async fn worktree_terminal_decision_force_keep_leaves_processes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().into_owned();
        let endpoint = dir.path().join("termd.sock");
        let manager = TerminalManager::with_test_endpoint(endpoint.clone());
        let terminal = manager
            .create(shell_request("sleep 30", &path))
            .await
            .expect("create");
        let summary = apply_worktree_terminal_decision_core(
            &manager,
            &path,
            WorktreeTerminalDecision::ForceKeep,
        )
        .await
        .expect("force keep");
        assert_eq!(summary.running_count, 1);
        assert_eq!(
            manager.describe(&terminal.terminal_id).unwrap().status,
            TerminalStatus::Running
        );
        manager
            .terminate(&terminal.terminal_id)
            .await
            .expect("cleanup terminal");
        shutdown_test_daemon(&endpoint).await;
    }
}

/// 桌面 Agent 启动只认 launch.js，不走 tool.json emit。
#[cfg(test)]
mod tool_asset_launch_tests {
    use super::*;

    fn agent_request(
        agent_id: &str,
        launch_inputs: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    ) -> CreatePersonalTerminalRequest {
        CreatePersonalTerminalRequest {
            terminal_id: None,
            cwd: "/tmp".into(),
            shell: None,
            initial_command: None,
            executable: None,
            args: Vec::new(),
            env: HashMap::new(),
            agent_id: Some(agent_id.into()),
            agent_mode_id: None,
            agent_extra_args: Vec::new(),
            agent_capability_values: Default::default(),
            agent_launch_inputs: launch_inputs,
            provider_injection_args: Vec::new(),
            folder_id: None,
            rows: 24,
            cols: 80,
            client_id: None,
        }
    }

    fn with_temp_berth_home(test: impl FnOnce(std::path::PathBuf)) {
        use crate::tool::path::TEST_ENV_LOCK;
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let dir = std::env::temp_dir().join(format!("terminal-launch-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        std::env::set_var("BERTH_HOME", &dir);
        test(dir.clone());
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn desktop_launch_execs_launch_js_with_typed_inputs() {
        // 测试进程旁边没有 berth-cli 时无法解析可执行文件，跳过。
        if crate::terminal::manager::runtime::resolve_cli_binary().is_none() {
            return;
        }
        with_temp_berth_home(|dir| {
            let package = dir.join("tools/scripted");
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(package.join("launch.js"), b"export default { launch: () => 0 }").unwrap();
            let mut inputs = std::collections::BTreeMap::new();
            inputs.insert("expert".to_string(), serde_json::json!("backend"));
            inputs.insert("sandbox".to_string(), serde_json::json!("read-only"));
            let mut request = agent_request("scripted", Some(inputs));
            request.provider_injection_args =
                vec!["-c".to_string(), "model_provider=berth".to_string()];
            let (executable, args, env) = resolve_agent_launch("scripted", &request).unwrap();
            assert!(executable.is_some());
            assert_eq!(&args[..2], ["tools", "launch"]);
            let args = &args[2..];
            assert_eq!(
                args[0],
                package
                    .join("launch.js")
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
            );
            assert_eq!(args[1], "--berth-launch-inputs");
            let payload: serde_json::Value = serde_json::from_str(&args[2]).unwrap();
            assert_eq!(
                payload,
                serde_json::json!({ "expert": "backend", "sandbox": "read-only" })
            );
            assert_eq!(&args[3..], ["-c", "model_provider=berth"]);
            assert_eq!(env.get("BERTH_LAUNCH_INPUTS").map(String::as_str), Some(args[2].as_str()));
        });
    }

    #[test]
    fn desktop_launch_requires_launch_js_even_if_tool_json_exists() {
        with_temp_berth_home(|dir| {
            let package = dir.join("tools/echo-agent");
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(
                package.join("tool.json"),
                r#"{ "protocol": "berth.tool/1", "id": "echo-agent", "identity": { "name": "Echo" } }"#,
            )
            .unwrap();
            let error =
                resolve_agent_launch("echo-agent", &agent_request("echo-agent", None)).unwrap_err();
            assert!(error.to_string().contains("no launch.js"));
            assert!(error.to_string().contains("tools/echo-agent"));
        });
    }
}
