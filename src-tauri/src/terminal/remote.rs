//! Remote daemon operations and terminal descriptor discovery.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use berth_project_core::runtime::{classify_session, project_session_key, SessionOwnership};
use berth_project_core::service::catalog::{list_catalog, CatalogScope};
use berth_term_sdk::berth::{
    CreateTerminal, PaneAgentSignal, PaneId, PaneProcessState, ProcessSpec, ProtocolError,
    RuntimeBinding, SessionName, Terminal, TerminalSizeSpec,
};

use super::lifecycle::{LiveTerminal, TerminalSessionManagerInner, TerminalTarget};
use super::model::{TerminalAgentSignal, TerminalDescriptor, TerminalOwnership};
use super::snapshot::pane_for_target;
use super::validation::{environment_to_vec, resolve_shell, TerminalLaunchEnvironment};
use crate::terminal::protocol::TerminalStatus;

/// Generation recorded when the live detail probe found no pane.
///
/// A live daemon reports pane process generations starting at 1, so this
/// sentinel can never collide with an observed generation. It means "the pane
/// was listed but not observed by the detail probe": operations still address
/// the captured pane id, and the daemon decides on the operation whether that
/// pane still exists, which reports a vanished pane instead of guessing.
const UNOBSERVED_PANE_GENERATION: u64 = 0;

#[cfg(all(test, unix))]
#[path = "launch_environment_tests.rs"]
mod launch_environment_tests;

#[derive(Debug, Clone)]
pub(super) struct RemoteDescriptor {
    pub(super) title: String,
    pub(super) initial_cwd: String,
    pub(super) shell: String,
    pub(super) status: TerminalStatus,
    pub(super) process_id: Option<u32>,
    pub(super) exited_at: Option<DateTime<Utc>>,
    pub(super) sequence: u64,
    /// Stable pane id of the addressed pane.
    ///
    /// Taken from the pane's own info snapshot when the daemon listed it, and
    /// from the caller's pane listing otherwise.
    pub(super) pane_id: PaneId,
    /// Pane process generation observed together with [`Self::pane_id`].
    pub(super) generation: u64,
    pub(super) agent_id: Option<String>,
    pub(super) session_id: Option<String>,
    pub(super) launch_inputs: Option<serde_json::Value>,
    pub(super) agent_signal: Option<TerminalAgentSignal>,
    /// 前台进程名（termd `pane_current_command`）。
    pub(super) foreground_command: Option<String>,
    /// 前台进程当前目录（termd `pane_current_path`）。
    pub(super) cwd: Option<String>,
}

pub(super) async fn create_remote_terminal(
    terminal: &Terminal,
    terminal_id: String,
    project_session: Option<SessionName>,
    cwd: String,
    shell: String,
    initial_command: Option<String>,
    executable: Option<String>,
    args: Vec<String>,
    environment: Option<HashMap<String, String>>,
    host_environment: Option<&TerminalLaunchEnvironment>,
    rows: u16,
    cols: u16,
    keep_on_failed_exit: bool,
) -> Result<(TerminalTarget, RemoteDescriptor, RuntimeBinding), berth_term_sdk::berth::TerminalError>
{
    let session_name = match project_session {
        Some(session) => session,
        None => terminal_session_name(&terminal_id).map_err(|error| {
            berth_term_sdk::berth::TerminalError::protocol(ProtocolError::invalid_target(
                terminal_id.clone(),
                error,
            ))
        })?,
    };
    let size = TerminalSizeSpec::new(cols, rows);
    // 两条创建路径使用同一份显式实例环境，不依赖 daemon 的旧 session 或进程快照。
    let environment = match host_environment {
        Some(host) => Some(host.merge(environment).map_err(|error| {
            berth_term_sdk::berth::TerminalError::protocol(ProtocolError::invalid_target(
                "terminal environment",
                error.to_string(),
            ))
        })?),
        None => environment,
    };
    let mut process = if let Some(executable) = executable {
        ProcessSpec::argv(std::iter::once(executable).chain(args))
    } else if let Some(command) = initial_command {
        ProcessSpec::shell(command)
    } else {
        ProcessSpec::argv([shell])
    };
    process.environment = environment_to_vec(environment);
    let created = terminal
        .create_terminal(CreateTerminal {
            session: session_name.clone(),
            window_name: terminal_id.clone(),
            cwd,
            process,
            size,
            detached: false,
            keep_on_failed_exit,
        })
        .await?;
    let target = TerminalTarget {
        session: session_name,
        window_index: created.pane.target().window_index,
        pane_index: created.pane.target().pane_index,
    };
    // 详情只补展示字段，守卫句柄会拒绝换代；不能用 respawn 后的代际覆盖出生绑定。
    let descriptor =
        describe_remote_pane(&created.pane, &terminal_id, created.binding.pane_id).await?;
    created.pane.set_title(descriptor.title.clone()).await?;
    Ok((target, descriptor, created.binding))
}

pub(super) async fn scan_live_terminals_remote(
    terminal: &Terminal,
    inner: &Arc<TerminalSessionManagerInner>,
) -> Result<Vec<LiveTerminal>, berth_term_sdk::berth::TerminalError> {
    let mut result = Vec::new();
    let (namespace, projects) = match inner.project_database.get() {
        Some((namespace, conn, _)) => (
            namespace.as_str(),
            list_catalog(conn, CatalogScope::All)
                .await
                .map_err(|error| project_catalog_error(error.to_string()))?,
        ),
        None => ("", Vec::new()),
    };
    // 实例身份（epoch）来自已缓存的握手能力协商：整个扫描只读一次，零额外往返。
    let daemon_instance = terminal.daemon_instance().await?;
    // Agent 工具 id（= 命令名）；只在有 pane 需要按前台进程识别时读一次 tool.json。
    // ponytail: 每次扫描重读，tool.json 多或轮询更密时再按目录 mtime 缓存。
    let mut agent_ids: Option<HashSet<String>> = None;
    for session_name in terminal.list_sessions().await? {
        let (folder_id, ownership) =
            match classify_session(session_name.as_str(), namespace, &projects) {
                SessionOwnership::Project(project) => {
                    (Some(project.id), TerminalOwnership::Project)
                }
                SessionOwnership::Foreign => continue,
                SessionOwnership::LegacyUnresolved => (None, TerminalOwnership::LegacyUnresolved),
                SessionOwnership::Independent => {
                    if !session_name.as_str().starts_with("berth-terminal-") {
                        continue;
                    }
                    (None, TerminalOwnership::Independent)
                }
            };
        let session = terminal.session(session_name.clone()).await?;
        // One list-windows per session returns the real window list: request
        // count grows with live windows (previously every slot 0..256 issued
        // an exists → full ListWindows), and sparse/high-index windows are
        // enumerated exactly.
        for entry in session.windows().await? {
            let window_index = entry.index;
            let window = session.window(window_index);
            let panes = window.panes().await?;
            let Some(window_pane) = panes
                .iter()
                .find(|pane| pane.active)
                .or_else(|| panes.first())
            else {
                continue;
            };
            let target = TerminalTarget {
                session: session_name.clone(),
                window_index,
                pane_index: window_pane.target.pane_index,
            };
            let terminal_id = entry
                .name
                .clone()
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| format!("window-{}", entry.id.as_u32()));
            let mut remote =
                describe_remote_target(terminal, &target, &terminal_id, window_pane.id).await?;
            if remote.agent_id.is_none() {
                if let Some(command) = remote.foreground_command.as_deref() {
                    remote.agent_id = agent_ids
                        .get_or_insert_with(list_agent_ids)
                        .contains(command)
                        .then(|| command.to_owned());
                }
            }
            let created_at = inner
                .sessions
                .lock()
                .expect("terminal index lock")
                .get(&terminal_id)
                .map(|record| record.descriptor.created_at)
                .unwrap_or_else(Utc::now);
            let binding = RuntimeBinding::new(
                daemon_instance.clone(),
                target.session.clone(),
                remote.pane_id,
                remote.generation,
            );
            result.push(LiveTerminal {
                descriptor: TerminalDescriptor {
                    terminal_id,
                    backend_instance_id: inner.backend_instance_id.clone(),
                    folder_id,
                    ownership,
                    title: remote.title,
                    initial_cwd: remote.initial_cwd,
                    shell: remote.shell,
                    status: remote.status,
                    process_id: remote.process_id,
                    created_at,
                    exited_at: remote.exited_at,
                    agent_id: remote.agent_id,
                    agent_signal: remote.agent_signal,
                    foreground_command: remote.foreground_command,
                    launch_inputs: remote.launch_inputs,
                    cwd: remote.cwd,
                    tail: None,
                    target_ref: super::model::encode_target_ref(&binding),
                },
                target,
                binding,
                sequence: remote.sequence,
                session_id: remote.session_id,
            });
        }
    }
    Ok(result)
}

async fn describe_remote_target(
    terminal: &Terminal,
    target: &TerminalTarget,
    terminal_id: &str,
    listed_pane_id: PaneId,
) -> Result<RemoteDescriptor, berth_term_sdk::berth::TerminalError> {
    let pane = pane_for_target(terminal, target).await?;
    describe_remote_pane(&pane, terminal_id, listed_pane_id).await
}

async fn describe_remote_pane(
    pane: &berth_term_sdk::berth::Pane,
    terminal_id: &str,
    listed_pane_id: PaneId,
) -> Result<RemoteDescriptor, berth_term_sdk::berth::TerminalError> {
    let info = pane.info().await?;
    let pane_info = info.panes.first();
    let pane_id = pane_info.map_or(listed_pane_id, |pane| pane.id);
    let generation = pane_info.map_or(UNOBSERVED_PANE_GENERATION, |pane| pane.generation);
    let process_id = pane_info.and_then(|pane| match pane.process {
        PaneProcessState::Running { pid } => pid,
        _ => None,
    });
    let (status, exited_at) = match pane_info.map(|pane| &pane.process) {
        Some(PaneProcessState::Exited) => (TerminalStatus::Exited, Some(Utc::now())),
        _ => (TerminalStatus::Running, None),
    };
    let initial_cwd = pane_info
        .and_then(|pane| pane.working_directory.clone())
        .or_else(|| {
            info.sessions
                .first()
                .and_then(|session| session.working_directory.clone())
        })
        .unwrap_or_default();
    let command = pane_info.and_then(|pane| pane.command.as_ref());
    let command0 = command.and_then(|cmd| cmd.first()).map(String::as_str);
    let shell = command0.map(str::to_owned).unwrap_or_else(resolve_shell);
    let process_name = resolve_process_name(command.map(Vec::as_slice), &shell);
    let window_name = info
        .windows
        .first()
        .and_then(|window| window.name.clone())
        .filter(|name| !name.is_empty());
    let title = readable_terminal_title(
        terminal_id,
        window_name.as_deref(),
        None,
        &shell,
        &initial_cwd,
        Some(&process_name),
    );
    Ok(RemoteDescriptor {
        title,
        initial_cwd,
        shell,
        status,
        process_id,
        exited_at,
        sequence: pane_info
            .map(|pane| pane.output_sequence)
            .unwrap_or_default(),
        pane_id,
        generation,
        agent_id: command.and_then(|cmd| berth_tool_core::paths::launch_tool_id(cmd)),
        session_id: command.and_then(|cmd| berth_tool_core::paths::launch_session_id(cmd)),
        launch_inputs: command.and_then(|cmd| berth_tool_core::paths::launch_inputs(cmd)),
        agent_signal: pane_info.and_then(|pane| agent_signal(&pane.agent)),
        foreground_command: pane_info.and_then(|pane| pane.foreground_command.clone()),
        cwd: pane_info.and_then(|pane| pane.foreground_path.clone()),
    })
}

/// 前台进程名按 Agent 工具 id 匹配：契约约定工具目录名即命令名；launch `program`
/// 统一是 `berth-cli`（经 launch.js），不能用来匹配。
fn list_agent_ids() -> HashSet<String> {
    crate::tool::profile::list_agent_profiles()
        .into_iter()
        .map(|profile| profile.id)
        .collect()
}

/// 旧 daemon 不认识 `pane_agent_state`，展开为空串，此时不报告状态。
fn agent_signal(signal: &PaneAgentSignal) -> Option<TerminalAgentSignal> {
    (!signal.state.is_empty()).then(|| TerminalAgentSignal {
        state: signal.state.clone(),
        notification: Some(signal.notification.clone()).filter(|text| !text.is_empty()),
        state_changed_at: signal.changed_at,
        progress_state: signal.progress_state.clone(),
        progress: signal.progress,
    })
}

pub(super) async fn folder_session_name(
    inner: &TerminalSessionManagerInner,
    folder_id: i32,
) -> Result<SessionName, berth_term_sdk::berth::TerminalError> {
    let (namespace, conn, _) = inner
        .project_database
        .get()
        .ok_or_else(|| project_catalog_error("project database is not configured"))?;
    let projects = list_catalog(conn, CatalogScope::All)
        .await
        .map_err(|error| project_catalog_error(error.to_string()))?;
    let project = projects
        .iter()
        .find(|project| project.id == folder_id)
        .ok_or_else(|| project_catalog_error(format!("project {folder_id} is not registered")))?;
    let key = project_session_key(namespace, &project.project_runtime_id)
        .map_err(|error| project_catalog_error(error.to_string()))?;
    SessionName::new(key).map_err(|error| project_catalog_error(error.to_string()))
}

fn project_catalog_error(message: impl Into<String>) -> berth_term_sdk::berth::TerminalError {
    berth_term_sdk::berth::TerminalError::protocol(ProtocolError::invalid_target(
        "project catalog",
        message,
    ))
}

pub(super) fn resolve_process_name(command: Option<&[String]>, shell: &str) -> String {
    let Some(cmd) = command.filter(|c| !c.is_empty()) else {
        return short_process_name(shell);
    };
    // Agent 启动（`berth-cli tools launch <tools>/<id>/launch.js`）显示插件声明的名字。
    if let Some(id) = berth_tool_core::paths::launch_tool_id(cmd) {
        return tool_display_name(&id);
    }
    let first = &cmd[0];
    let short_first = short_process_name(first);

    let is_interpreter = matches!(
        short_first.as_str(),
        "python" | "python3" | "node" | "bun" | "deno" | "ruby" | "perl" | "bash" | "sh" | "zsh"
    ) || short_first.starts_with("python3.");

    if is_interpreter && cmd.len() > 1 {
        for arg in &cmd[1..] {
            if arg.starts_with('-') {
                continue;
            }
            let script_base = short_process_name(arg);
            if !script_base.is_empty()
                && (script_base.ends_with(".py")
                    || script_base.ends_with(".js")
                    || script_base.ends_with(".ts")
                    || script_base.ends_with(".sh"))
            {
                return script_base;
            }
        }
    }

    short_first
}

/// 标签名取插件 `tool.json` 的 `identity.name`；读不到时用工具 id。不按 Agent 名分支。
fn tool_display_name(tool_id: &str) -> String {
    crate::tool::profile::load_agent_profile(tool_id)
        .ok()
        .flatten()
        .map(|profile| profile.name)
        .unwrap_or_else(|| tool_id.to_owned())
}

/// Build a human label for GUI tabs / descriptors without changing the wire
/// window name (which remains `terminal_id` for stable attach targets).
pub(super) fn readable_terminal_title(
    terminal_id: &str,
    window_name: Option<&str>,
    pane_title: Option<&str>,
    shell: &str,
    cwd: &str,
    command0: Option<&str>,
) -> String {
    let window_name = window_name.map(str::trim).filter(|value| !value.is_empty());
    let pane_title = pane_title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| !looks_like_terminal_id(value));

    // Explicit human rename of the Berth terminal window wins.
    if let Some(name) = window_name {
        if !looks_like_terminal_id(name) && name != terminal_id {
            return name.to_owned();
        }
    }
    if let Some(title) = pane_title {
        let is_generic = title == "Terminal"
            || title.starts_with("python3 ·")
            || title.starts_with("python ·")
            || title.starts_with("bash ·")
            || title.starts_with("sh ·")
            || title.starts_with("zsh ·")
            || title.starts_with("node ·");
        if !is_generic {
            return title.to_owned();
        }
    }

    let process = command0
        .or(Some(shell))
        .map(short_process_name)
        .filter(|value| !value.is_empty());
    let dir = path_basename(cwd);
    match (process, dir) {
        (Some(process), Some(dir)) if process != dir => format!("{process} · {dir}"),
        (Some(process), _) => process,
        (None, Some(dir)) => dir,
        (None, None) => "Terminal".to_owned(),
    }
}

fn short_process_name(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'');
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_owned()
}

fn path_basename(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn looks_like_terminal_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() == 36
        && [8usize, 13, 18, 23]
            .into_iter()
            .all(|index| bytes.get(index) == Some(&b'-'))
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8usize, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit()))
        || (bytes.len() == 32 && bytes.iter().all(u8::is_ascii_hexdigit))
}

fn terminal_session_name(terminal_id: &str) -> Result<SessionName, String> {
    let component = terminal_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    SessionName::new(format!("berth-terminal-{component}")).map_err(|error| error.to_string())
}
