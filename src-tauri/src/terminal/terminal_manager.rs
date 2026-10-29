//! Berth's terminal manager.
//!
//! This module is the only Berth terminal runtime authority.  It keeps the
//! existing Berth terminal wire contract at the edges, while session/window/
//! pane state and PTY ownership live in the bundled `berth-termd` process.
//! The manager deliberately keeps only an in-process index of live handles;
//! it never persists runtime state and never marks a daemon epoch as lost.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use berth_project_core::instance::DataInstance;
use berth_project_core::tasks::{self, group};
use berth_term_sdk::berth::{default_endpoint_path, RuntimeBinding, WindowRef};
use chrono::Utc;
use sea_orm::DatabaseConnection;

use super::binding::pane_for_binding;
use super::lifecycle::{
    clear_runtime_index_inner, insert_record, sync_runtime_index, update_record_sequence,
    LiveTerminal, ResolvedTerminal, TerminalRecord, TerminalSessionManagerInner,
};
use super::model::{
    CreateTerminalRequest, TerminalDescriptor, TerminalLimits, TerminalOperationError,
    TerminalOwnership,
};
use super::remote::{create_remote_terminal, folder_session_name, scan_live_terminals_remote};
use super::runtime::{resolve_cli_command, resolve_terminald_binary};
use super::snapshot::snapshot_for_pane;
use super::validation::{
    clamp_grid, normalize_terminal_id, resolve_direct_executable, validate_cwd,
    validate_direct_command, validate_shell, TerminalLaunchEnvironment,
};
use crate::event_bridge::EventEmitter;
use crate::terminal::error::{TerminalError, TerminalErrorCode};
use crate::terminal::protocol::{TerminalSnapshot, TerminalStatus};

/// Shared Berth terminal manager backed by the bundled Berth terminal daemon.
#[derive(Clone)]
pub struct TerminalSessionManager {
    pub(super) inner: Arc<TerminalSessionManagerInner>,
}

/// Short alias used by Tauri state and command modules.
pub type TerminalManager = TerminalSessionManager;

impl TerminalSessionManager {
    /// Creates a Berth-backed manager using the Berth-owned default endpoint.
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(TerminalLimits::default())
    }

    /// Creates a Berth-backed manager with adapter limits.
    #[must_use]
    pub fn with_limits(limits: TerminalLimits) -> Self {
        let endpoint = default_endpoint_path()
            .unwrap_or_else(|_| std::env::temp_dir().join("berth-termd-default.sock"));
        Self::with_endpoint(limits, endpoint)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn with_test_endpoint(endpoint: PathBuf) -> Self {
        Self::with_endpoint(TerminalLimits::default(), endpoint)
    }

    fn with_endpoint(limits: TerminalLimits, endpoint: PathBuf) -> Self {
        let daemon_binary = resolve_terminald_binary();
        let backend_instance_id = endpoint.to_string_lossy().into_owned();
        Self {
            inner: Arc::new(TerminalSessionManagerInner {
                backend_instance_id,
                endpoint,
                daemon_binary,
                executor: OnceLock::new(),
                project_database: OnceLock::new(),
                sessions: Mutex::new(HashMap::new()),
                limits,
            }),
        }
    }

    /// 绑定已打开的宿主项目库；namespace 由共享 DataInstance 规则生成。
    pub(crate) fn configure_project_database(
        &self,
        instance: &DataInstance,
        conn: DatabaseConnection,
        gui_endpoint: Result<PathBuf, String>,
    ) -> Result<(), TerminalError> {
        let namespace = instance
            .namespace_key()
            .map_err(|state| TerminalError::SpawnFailed(state.message()))?;
        // control listener 仍尽力启动；配置错误只拒绝后续终端创建，不升级为 GUI 启动失败。
        let environment = gui_endpoint.and_then(|gui_endpoint| {
            // 默认 endpoint 已由 IPC 解析为 <tmpdir>/berth-<uid>/default，取其实际根。
            #[cfg(unix)]
            let terminal_tmpdir = self
                .inner
                .endpoint
                .parent()
                .and_then(std::path::Path::parent)
                .ok_or_else(|| "terminal endpoint has no socket root".to_owned())?
                .to_path_buf();
            #[cfg(not(unix))]
            let terminal_tmpdir = std::env::var_os("BERTH_TMPDIR")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let home = crate::git::credential::absolutize(&crate::platform::paths::berth_home_dir());
            TerminalLaunchEnvironment::from_resolved_paths(
                instance.data_dir(),
                instance.db_file_name(),
                &gui_endpoint,
                &terminal_tmpdir,
                &home,
                resolve_cli_command().as_deref(),
                std::env::var("PATH").ok(),
            )
            .map_err(|error| error.to_string())
        });
        self.inner
            .project_database
            .set((namespace, conn, environment))
            .map_err(|_| {
                TerminalError::SpawnFailed("project database is already configured".into())
            })
    }

    /// Returns another handle to the same live manager index.
    #[must_use]
    pub fn clone_ref(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }

    /// Returns the Berth daemon endpoint identity.
    #[must_use]
    pub fn backend_instance_id(&self) -> &str {
        &self.inner.backend_instance_id
    }

    /// 以 pane 同款身份运行 berth-cli：termd 端点 + 启动环境（实例库、GUI 端点、PATH）。
    /// 宿主还没配置项目库或环境投影失败时为 `None`。
    #[must_use]
    pub fn cli_launch(&self) -> Option<(PathBuf, HashMap<String, String>)> {
        let (_, _, environment) = self.inner.project_database.get()?;
        let environment = environment.as_ref().ok()?.merge(None).ok()?;
        Some((self.inner.endpoint.clone(), environment))
    }

    /// Creates a terminal window and lazily ensures its project session.
    pub async fn create(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<TerminalDescriptor, TerminalError> {
        self.create_internal(request, EventEmitter::Noop)
    }

    /// Creates a terminal window and emits lifecycle notifications through the
    /// supplied Berth event emitter.
    pub async fn create_with_emitter(
        &self,
        request: CreateTerminalRequest,
        emitter: EventEmitter,
    ) -> Result<TerminalDescriptor, TerminalError> {
        self.create_internal(request, emitter)
    }

    fn create_internal(
        &self,
        request: CreateTerminalRequest,
        emitter: EventEmitter,
    ) -> Result<TerminalDescriptor, TerminalError> {
        let cwd = validate_cwd(&request.cwd)?;
        let shell = validate_shell(request.shell.as_deref())?;
        let terminal_id = normalize_terminal_id(request.terminal_id)?;
        let (rows, cols) = clamp_grid(request.rows, request.cols);
        let (executable, extra_env) =
            resolve_direct_executable(request.executable, request.extra_env);
        validate_direct_command(executable.as_deref(), &request.args)?;
        if let Some((_, _, Err(message))) = self.inner.project_database.get() {
            return Err(TerminalError::SpawnFailed(message.clone()));
        }

        let command: Vec<String> = executable
            .iter()
            .cloned()
            .chain(request.args.iter().cloned())
            .collect();
        let session_id = berth_tool_core::paths::launch_session_id(&command);
        let agent_id = berth_tool_core::paths::launch_tool_id(&command);
        match self.scan_live_entries() {
            Ok(live) => {
                // 同项目、同工具、同一明确会话正在运行：返回原终端，前端沿原路径打开 tab。
                if let Some(session_id) = session_id {
                    // 一个项目一个群：主目录和 worktree 的终端都在项目群里登记。
                    let group = tasks::resolve(Path::new(&cwd))
                        .ok()
                        .map(|tasks::Scope { main, .. }| (main, group::MAIN_GROUP));
                    if let Some(entry) = live.iter().find(|entry| {
                        if entry.descriptor.status != TerminalStatus::Running
                            || entry.descriptor.folder_id != request.folder_id
                            || entry.descriptor.initial_cwd != cwd
                            || entry.descriptor.agent_id != agent_id
                        {
                            return false;
                        }
                        // 初次新建没有启动会话 id；收集器后续确认的当前 id 同样可复用。
                        let known = group
                            .as_ref()
                            .and_then(|(main, group)| {
                                group::bound_session_id(
                                    main,
                                    group,
                                    entry.descriptor.target_ref.as_deref()?,
                                )
                            })
                            .or_else(|| entry.session_id.clone());
                        known.as_deref() == Some(session_id.as_str())
                    }) {
                        return Ok(entry.descriptor.clone());
                    }
                }
                if live
                    .iter()
                    .any(|entry| entry.descriptor.terminal_id == terminal_id)
                {
                    return Err(TerminalError::SpawnFailed(format!(
                        "terminal id '{terminal_id}' already exists"
                    )));
                }
            }
            Err(TerminalError::RuntimeUnavailable(_)) => {}
            Err(error) => return Err(error),
        }

        let inner = self.inner.clone();
        let project_inner = self.inner.clone();
        let requested_terminal_id = terminal_id.clone();
        let requested_folder_id = request.folder_id;
        let target_and_descriptor = self.execute(true, None, move |terminal| async move {
            let project_session = match requested_folder_id {
                Some(folder_id) => Some(folder_session_name(&project_inner, folder_id).await?),
                None => None,
            };
            create_remote_terminal(
                terminal.as_ref(),
                requested_terminal_id,
                project_session,
                cwd,
                shell,
                request.initial_command,
                executable,
                request.args,
                extra_env,
                project_inner
                    .project_database
                    .get()
                    .and_then(|(_, _, environment)| environment.as_ref().ok()),
                rows,
                cols,
                request.keep_on_failed_exit,
            )
            .await
        })?;

        let (target, descriptor, binding) = target_and_descriptor;
        let sequence = descriptor.sequence;
        let descriptor = TerminalDescriptor {
            terminal_id: terminal_id.clone(),
            backend_instance_id: inner.backend_instance_id.clone(),
            folder_id: request.folder_id,
            ownership: if request.folder_id.is_some() {
                TerminalOwnership::Project
            } else {
                TerminalOwnership::Independent
            },
            title: descriptor.title,
            initial_cwd: descriptor.initial_cwd,
            shell: descriptor.shell,
            status: descriptor.status,
            process_id: descriptor.process_id,
            created_at: Utc::now(),
            exited_at: descriptor.exited_at,
            agent_id: descriptor.agent_id,
            agent_signal: descriptor.agent_signal,
            foreground_command: descriptor.foreground_command,
            launch_inputs: descriptor.launch_inputs,
            cwd: descriptor.cwd,
            tail: None,
            target_ref: super::model::encode_target_ref(&binding),
        };
        let record = TerminalRecord {
            descriptor: descriptor.clone(),
            target: target.clone(),
            binding,
            sequence,
            owner_window_label: request.client_id,
            input_sequences: HashMap::new(),
            input_lock: Arc::new(Mutex::new(())),
            subscribers: HashMap::new(),
            temp_files: request.temp_files,
            emitter,
        };
        if let Err(error) = insert_record(&inner, terminal_id.clone(), record) {
            let window_target = WindowRef::new(target.session, target.window_index);
            let _ = self.execute(false, Some(terminal_id), move |terminal| async move {
                terminal
                    .window(window_target)
                    .await?
                    .close()
                    .await
                    .map(|_| ())
            });
            return Err(error);
        }
        Ok(descriptor)
    }

    /// Lists live Berth project windows from the daemon.
    ///
    /// Unlike [`Self::list`], this preserves runtime-unavailable failures so
    /// inventory clients can distinguish a failed probe from an authoritative
    /// successful empty snapshot.
    pub fn try_list(&self) -> Result<Vec<TerminalDescriptor>, TerminalError> {
        let mut descriptors = self.scan_live_terminals()?;
        descriptors.sort_by_key(|descriptor| descriptor.created_at);
        Ok(descriptors)
    }

    /// Best-effort list used by internal cleanup/preflight projections where an
    /// unavailable daemon is equivalent to having no actionable terminals.
    pub fn list(&self) -> Vec<TerminalDescriptor> {
        match self.try_list() {
            Ok(descriptors) => descriptors,
            Err(error) => {
                tracing::debug!(error = %error, "berth terminal list skipped because daemon is absent");
                Vec::new()
            }
        }
    }

    /// Looks up one live terminal descriptor.
    pub fn describe(&self, terminal_id: &str) -> Result<TerminalDescriptor, TerminalError> {
        let descriptor = self
            .scan_live_terminals()
            .map_err(|error| match error {
                TerminalError::RuntimeUnavailable(_) => {
                    TerminalError::NotFound(terminal_id.to_string())
                }
                error => error,
            })?
            .into_iter()
            .find(|descriptor| descriptor.terminal_id == terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        Ok(descriptor)
    }

    /// Captures a sequence-consistent Berth snapshot from Berth terminal's pane.
    pub fn snapshot(&self, terminal_id: &str) -> Result<TerminalSnapshot, TerminalError> {
        let resolved = self.resolve_terminal(terminal_id)?;
        let backend = self.inner.backend_instance_id.clone();
        let snapshot_id = terminal_id.to_string();
        let snapshot = self.execute(
            false,
            Some(snapshot_id.clone()),
            move |terminal| async move {
                let pane = pane_for_binding(terminal.as_ref(), &resolved).await?;
                snapshot_for_pane(&pane, snapshot_id, backend).await
            },
        )?;
        update_record_sequence(&self.inner, snapshot.sequence, &snapshot.terminal_id);
        Ok(snapshot)
    }

    /// 读取终端 pane 末尾最多 `lines` 行纯文本，走与 `berth terminal capture` 相同的 SDK 路径。
    pub fn capture_tail(&self, terminal_id: &str, lines: u32) -> Result<String, TerminalError> {
        let resolved = self.resolve_terminal(terminal_id)?;
        let captured = self.execute(
            false,
            Some(terminal_id.to_string()),
            move |terminal| async move {
                let pane = pane_for_binding(terminal.as_ref(), &resolved).await?;
                pane.capture_pane().start(-i64::from(lines)).await
            },
        )?;
        let text = String::from_utf8_lossy(&captured.stdout);
        // 屏幕底部空白行不算输出。
        let (tail, _) = berth_control_proto::excerpt_tail(
            text.trim_end(),
            lines,
            berth_control_proto::MAX_EXCERPT_BYTES,
        );
        Ok(tail)
    }

    /// 返回 GUI 选中终端的绑定身份，不读取终端正文。
    pub(crate) fn current_binding(
        &self,
        terminal_id: &str,
    ) -> Result<RuntimeBinding, TerminalError> {
        let resolved = self.resolve_terminal_inner(terminal_id, false)?;
        let id = terminal_id.to_owned();
        self.execute(false, Some(id), move |terminal| async move {
            pane_for_binding(terminal.as_ref(), &resolved).await?;
            Ok(resolved.binding)
        })
    }

    /// Resolves the captured inner identity of one live terminal.
    ///
    /// The in-process index is the fast path; a terminal the index does not know
    /// yet is resolved from a fresh scan, which also refreshes the index. The
    /// returned binding is only a captured identity: the operation re-checks it
    /// against the daemon it runs on before addressing the pane.
    pub(super) fn resolve_terminal(
        &self,
        terminal_id: &str,
    ) -> Result<ResolvedTerminal, TerminalError> {
        self.resolve_terminal_inner(terminal_id, true)
    }

    fn resolve_terminal_inner(
        &self,
        terminal_id: &str,
        unavailable_is_not_found: bool,
    ) -> Result<ResolvedTerminal, TerminalError> {
        if let Some(resolved) = self
            .inner
            .sessions
            .lock()
            .expect("terminal index lock")
            .get(terminal_id)
            .map(|record| ResolvedTerminal {
                target: record.target.clone(),
                binding: record.binding.clone(),
            })
        {
            return Ok(resolved);
        }

        let live = self
            .scan_live_entries()
            .map_err(|error| match error {
                TerminalError::RuntimeUnavailable(_) if unavailable_is_not_found => {
                    TerminalError::NotFound(terminal_id.to_string())
                }
                error => error,
            })?
            .into_iter()
            .find(|entry| entry.descriptor.terminal_id == terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        Ok(ResolvedTerminal {
            target: live.target,
            binding: live.binding,
        })
    }

    fn scan_live_terminals(&self) -> Result<Vec<TerminalDescriptor>, TerminalError> {
        Ok(self
            .scan_live_entries()?
            .into_iter()
            .map(|entry| entry.descriptor)
            .collect())
    }

    fn scan_live_entries(&self) -> Result<Vec<LiveTerminal>, TerminalError> {
        let inner = self.inner.clone();
        let scanned = match self.execute(false, None, move |terminal| async move {
            scan_live_terminals_remote(terminal.as_ref(), &inner).await
        }) {
            Ok(scanned) => scanned,
            Err(error) => {
                self.clear_runtime_index();
                return Err(error);
            }
        };
        Ok(sync_runtime_index(&self.inner, &scanned))
    }

    fn clear_runtime_index(&self) {
        clear_runtime_index_inner(&self.inner);
    }
}

impl Default for TerminalSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

pub(super) fn short_id(value: &str) -> String {
    value.chars().take(8).collect()
}

pub(super) fn operation_error_for_terminal(error: TerminalError) -> TerminalOperationError {
    match error {
        TerminalError::NotFound(_) => TerminalErrorCode::TerminalNotFound.into(),
        TerminalError::Exited(_) => TerminalErrorCode::TerminalExited.into(),
        TerminalError::InputBackpressure => TerminalErrorCode::InputBackpressure.into(),
        TerminalError::InstanceExpired(_) => TerminalErrorCode::TerminalInstanceExpired.into(),
        other => TerminalOperationError::Runtime(other),
    }
}

pub(super) fn terminal_error_from_sdk(
    error: berth_term_sdk::berth::TerminalError,
    terminal_id: Option<&str>,
) -> TerminalError {
    match error {
        berth_term_sdk::berth::TerminalError::Transport { .. } => {
            TerminalError::RuntimeUnavailable("berth-termd runtime is not reachable".to_string())
        }
        error @ berth_term_sdk::berth::TerminalError::Unsupported { .. } => {
            TerminalError::Incompatible(error.to_string())
        }
        berth_term_sdk::berth::TerminalError::PaneNotFound { .. } => match terminal_id {
            Some(terminal_id) => TerminalError::NotFound(terminal_id.to_string()),
            None => TerminalError::RuntimeUnavailable(
                "berth-termd runtime is not reachable".to_string(),
            ),
        },
        berth_term_sdk::berth::TerminalError::Protocol {
            source: berth_term_sdk::berth::ProtocolError::SessionNotFound(session),
            ..
        } => TerminalError::NotFound(terminal_id.unwrap_or(&session).to_string()),
        // 绑定被判定失效：这是确定性过期，不是可重试的运行时故障，携带稳定原因。
        berth_term_sdk::berth::TerminalError::Protocol {
            source: berth_term_sdk::berth::ProtocolError::PaneBindingInvalid { reason },
            ..
        } => TerminalError::InstanceExpired(reason.to_string()),
        error => TerminalError::SpawnFailed(error.to_string()),
    }
}

#[cfg(test)]
#[path = "terminal_manager_tests.rs"]
mod tests;
