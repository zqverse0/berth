//! 工作区终端的 SDK 薄适配；只有显式 create 可启动 daemon，发现与已知 ref 操作只连接。

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use berth_control_proto::{excerpt_tail, ProjectScope, TargetBindingRef, WorkspaceExcerptParams};
pub(crate) use berth_group::{Input, PaneProbe};
use berth_project_core::instance::DataInstance;
use berth_project_core::runtime::{classify_session, project_session_key, SessionOwnership};
use berth_term_sdk::berth::{
    resolve_shell, verify, BindingFacts, CreateTerminal, Pane, PaneId, PaneProcessState,
    ProcessSpec, ProtocolError, RuntimeBinding, SessionName, Terminal, TerminalClientBuilder,
    TerminalError, TerminalLaunchEnvironment, TerminalSizeSpec,
};
use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    CliError, EXIT_DAEMON_UNAVAILABLE, EXIT_INCOMPATIBLE, EXIT_OPERATION_TIMEOUT, EXIT_REJECTED,
    EXIT_TARGET_NOT_FOUND, EXIT_USER_ERROR,
};

const OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

fn failure(
    code: u8,
    kind: &'static str,
    message: impl Into<String>,
    json_mode: bool,
    unknown: bool,
) -> CliError {
    let message = message.into();
    let json_message = json_mode.then(|| {
        let mut value = json!({ "error": { "kind": kind, "message": message } });
        if unknown {
            value["error"]["outcome"] = json!("unknown");
        }
        value.to_string()
    });
    CliError {
        exit_code: code,
        message,
        json_message,
    }
}

fn sdk_failure(error: TerminalError, json_mode: bool, sending: bool) -> CliError {
    let message = error.to_string();
    match error {
        TerminalError::Unsupported { .. } => failure(
            EXIT_INCOMPATIBLE,
            "incompatible_version",
            message,
            json_mode,
            false,
        ),
        TerminalError::PaneNotFound { .. } => failure(
            EXIT_TARGET_NOT_FOUND,
            "stale_target",
            message,
            json_mode,
            false,
        ),
        TerminalError::Protocol {
            source: ProtocolError::PaneBindingInvalid { .. } | ProtocolError::SessionNotFound(_),
            ..
        } => failure(
            EXIT_TARGET_NOT_FOUND,
            "stale_target",
            message,
            json_mode,
            false,
        ),
        TerminalError::Transport { source, .. }
            if matches!(
                source.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) =>
        {
            failure(
                EXIT_OPERATION_TIMEOUT,
                "timeout",
                message,
                json_mode,
                sending,
            )
        }
        TerminalError::Transport { .. } => failure(
            EXIT_DAEMON_UNAVAILABLE,
            "daemon_unavailable",
            message,
            json_mode,
            sending,
        ),
        _ => failure(EXIT_REJECTED, "rejected", message, json_mode, sending),
    }
}

/// `--project` 参数（ID、名称、路径或名称唯一前缀）解析为项目 ID。
pub(crate) async fn resolve_project_id(query: &str, json_mode: bool) -> Result<i32, CliError> {
    let instance = crate::project::resolve_instance(json_mode)?;
    let catalog = crate::project::catalog_entries(&instance, ProjectScope::All)
        .await
        .map_err(|state| CliError::from_instance(state, json_mode))?;
    crate::project::match_project(&catalog, query)
        .map(|entry| entry.id)
        .map_err(|(code, message)| project_failure(code, message, json_mode))
}

fn project_failure(code: u8, message: String, json_mode: bool) -> CliError {
    let kind = if code == EXIT_TARGET_NOT_FOUND {
        "not_found"
    } else {
        "invalid_params"
    };
    failure(code, kind, message, json_mode, false)
}

/// 终端短名：`项目:编号`，编号是 `terminal ls` 里的 pane 编号（终端存活期间不变）。
fn terminal_handle(project_name: &str, pane_id: u32) -> String {
    format!("{project_name}:{pane_id}")
}

/// `-t` 参数：target_ref 原样解码；`项目:编号` 先在该项目的 live 终端里找到对应 ref；
/// 只写编号时在调用者自己的项目（`BERTH_TARGET_REF` 的会话）里找，不在终端里则要求全局唯一。
async fn resolve_target(
    socket: &Path,
    reference: &str,
    json_mode: bool,
) -> Result<RuntimeBinding, CliError> {
    if reference.starts_with("v1.") {
        return parse_binding(reference, json_mode);
    }
    let (project, pane) = match reference.rsplit_once(':') {
        Some((project, pane)) => (Some(project), pane),
        None => (None, reference),
    };
    let pane_id = pane.parse::<u32>().map_err(|_| {
        failure(
            EXIT_USER_ERROR,
            "invalid_params",
            format!(
                "invalid terminal '{reference}'; expected NUMBER or PROJECT:NUMBER from `berth terminal ls`"
            ),
            json_mode,
            false,
        )
    })?;
    let instance = crate::project::resolve_instance(json_mode)?;
    let project_id = match project {
        Some(project) => {
            let catalog = crate::project::catalog_entries(&instance, ProjectScope::All)
                .await
                .map_err(|state| CliError::from_instance(state, json_mode))?;
            Some(
                crate::project::match_project(&catalog, project)
                    .map_err(|(code, message)| project_failure(code, message, json_mode))?
                    .id,
            )
        }
        None => None,
    };
    let own_session = project
        .is_none()
        .then(|| std::env::var("BERTH_TARGET_REF").ok())
        .flatten()
        .and_then(|own| TargetBindingRef::decode(&own).ok())
        .map(|own| own.session);
    let matches: Vec<String> = list_entries(&instance, socket, project_id, json_mode)
        .await?
        .into_iter()
        .filter(|entry| entry.pane_id == pane_id)
        .filter(|entry| own_session.as_ref().is_none_or(|own| &entry.session == own))
        .filter_map(|entry| entry.target_ref)
        .collect();
    match matches.as_slice() {
        [target_ref] => parse_binding(target_ref, json_mode),
        [] => Err(failure(
            EXIT_TARGET_NOT_FOUND,
            "not_found",
            format!("no live terminal '{reference}'; see `berth terminal ls`"),
            json_mode,
            false,
        )),
        _ => Err(failure(
            EXIT_USER_ERROR,
            "invalid_params",
            format!(
                "terminal '{reference}' is ambiguous; use PROJECT:NUMBER from `berth terminal ls`"
            ),
            json_mode,
            false,
        )),
    }
}

fn parse_binding(reference: &str, json_mode: bool) -> Result<RuntimeBinding, CliError> {
    let decoded = TargetBindingRef::decode(reference)
        .map_err(|message| failure(EXIT_USER_ERROR, "invalid_params", message, json_mode, false))?;
    // SessionName::new 会重写部分字符；从 wire 解码后必须保持原字节身份。
    let session: SessionName = serde_json::from_value(json!(decoded.session)).map_err(|_| {
        failure(
            EXIT_USER_ERROR,
            "invalid_params",
            "invalid target ref session",
            json_mode,
            false,
        )
    })?;
    if session.as_str() != decoded.session {
        return Err(failure(
            EXIT_USER_ERROR,
            "invalid_params",
            "non-canonical target ref session",
            json_mode,
            false,
        ));
    }
    Ok(RuntimeBinding::new(
        decoded.daemon_instance,
        session,
        PaneId::new(decoded.pane_id),
        decoded.generation,
    ))
}

/// 终端引用属于另一个 Berth 实例（如正式版与 dev 同开）：本实例的 termd 看不到它，不能据此判它已退出。
/// 解析不了或读不到本实例身份时按本实例处理，交给 probe 判定。
pub(crate) fn foreign_target(reference: &str) -> bool {
    let Ok(binding) = parse_binding(reference, false) else {
        return false;
    };
    let Some(key) = berth_project_core::runtime::parse_project_session_key(binding.session.as_str())
    else {
        return false;
    };
    crate::project::resolve_instance(false)
        .ok()
        .and_then(|instance| instance.namespace_key().ok())
        .is_some_and(|namespace| namespace != key.data_instance_key)
}

/// 从终端引用的 session 持久身份解析项目，不读取前台 cwd、不按任务猜测。
pub(crate) async fn session_project_path(reference: &str) -> Result<PathBuf, CliError> {
    let binding = parse_binding(reference, false)?;
    let instance = crate::project::resolve_instance(false)?;
    let namespace = instance
        .namespace_key()
        .map_err(|state| CliError::from_instance(state, false))?;
    let catalog = crate::project::catalog_entries(&instance, ProjectScope::All)
        .await
        .map_err(|state| CliError::from_instance(state, false))?;
    match classify_session(binding.session.as_str(), &namespace, &catalog) {
        SessionOwnership::Project(project) => Ok(PathBuf::from(&project.path)),
        _ => Err(failure(
            EXIT_USER_ERROR,
            "unresolved_session",
            "Current session has no proven project owner; do not infer it from cwd",
            false,
            false,
        )),
    }
}

async fn bound_pane(
    terminal: &Terminal,
    binding: RuntimeBinding,
    json_mode: bool,
) -> Result<Pane, CliError> {
    let observed = terminal
        .daemon_instance()
        .await
        .map_err(|error| sdk_failure(error, json_mode, false))?;
    let verdict = match observed.as_deref() {
        Some(epoch) => verify(
            &binding,
            BindingFacts::DaemonObserved {
                daemon_instance: epoch,
            },
        ),
        None => verify(&binding, BindingFacts::DaemonUnverifiable),
    };
    if !verdict.allows_pane_address() {
        return Err(failure(
            EXIT_TARGET_NOT_FOUND,
            "stale_target",
            format!("terminal binding expired: {verdict:?}"),
            json_mode,
            false,
        ));
    }
    terminal
        .session(binding.session.clone())
        .await
        .map_err(|error| sdk_failure(error, json_mode, false))?
        // window/pane 槽仅为无效占位；SDK 每次按捕获的稳定 pane id 寻址。
        .pane_handle_by_id(binding.pane_id, 0, 0)
        .guard_generation_if_supported(binding.generation)
        .await
        .map_err(|error| sdk_failure(error, json_mode, false))
}

async fn connect_existing(socket: &Path, json_mode: bool) -> Result<Terminal, CliError> {
    tokio::time::timeout(
        OPERATION_TIMEOUT,
        TerminalClientBuilder::new()
            .unix_socket(socket.to_path_buf())
            .default_timeout(OPERATION_TIMEOUT)
            .connect(),
    )
    .await
    .map_err(|_| {
        failure(
            EXIT_DAEMON_UNAVAILABLE,
            "daemon_unavailable",
            "terminal daemon connection timed out",
            json_mode,
            false,
        )
    })?
    .map_err(|error| {
        let mapped = sdk_failure(error, json_mode, false);
        if mapped.exit_code == EXIT_OPERATION_TIMEOUT {
            failure(
                EXIT_DAEMON_UNAVAILABLE,
                "daemon_unavailable",
                mapped.message,
                json_mode,
                false,
            )
        } else {
            mapped
        }
    })
}

#[derive(Debug, Serialize)]
struct ListedTerminal {
    ownership: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    session: String,
    pane_id: u32,
    title: Option<String>,
    cwd: Option<String>,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_ref: Option<String>,
}

async fn list_entries(
    instance: &DataInstance,
    socket: &Path,
    project_id: Option<i32>,
    json_mode: bool,
) -> Result<Vec<ListedTerminal>, CliError> {
    let catalog = crate::project::catalog_entries(instance, ProjectScope::All)
        .await
        .map_err(|state| CliError::from_instance(state, json_mode))?;
    let namespace = instance
        .namespace_key()
        .map_err(|state| CliError::from_instance(state, json_mode))?;
    if project_id.is_some_and(|id| !catalog.iter().any(|entry| entry.id == id)) {
        return Err(failure(
            EXIT_TARGET_NOT_FOUND,
            "not_found",
            "project is not registered in this data instance",
            json_mode,
            false,
        ));
    }
    let terminal = connect_existing(socket, json_mode).await?;
    tokio::time::timeout(OPERATION_TIMEOUT, async {
        let epoch = terminal
            .daemon_instance()
            .await
            .map_err(|error| sdk_failure(error, json_mode, false))?;
        let sessions = terminal
            .list_sessions()
            .await
            .map_err(|error| sdk_failure(error, json_mode, false))?;
        let mut entries = Vec::new();
        for session in sessions {
            let (ownership, project) =
                match classify_session(session.as_str(), &namespace, &catalog) {
                    SessionOwnership::Project(project) => ("project", Some(project)),
                    SessionOwnership::Foreign => continue,
                    SessionOwnership::LegacyUnresolved => ("legacy_unresolved", None),
                    SessionOwnership::Independent => ("independent", None),
                };
            if project_id.is_some_and(|id| project.map(|entry| entry.id) != Some(id)) {
                continue;
            }
            // 在探测 pane 前排除其他实例；其余元数据复用 SDK 已有的同次库存。
            let panes = terminal
                .find_panes()
                .session(session.as_str())
                .all()
                .await
                .map_err(|error| sdk_failure(error, json_mode, false))?;
            for pane in panes {
                let target_ref = if project.is_some() {
                    Some(
                        TargetBindingRef {
                            version: 1,
                            daemon_instance: epoch.clone(),
                            session: session.as_str().to_owned(),
                            pane_id: pane.pane_id.as_u32(),
                            generation: pane.generation,
                        }
                        .encode()
                        .map_err(|message| {
                            failure(EXIT_REJECTED, "rejected", message, json_mode, false)
                        })?,
                    )
                } else {
                    None
                };
                entries.push(ListedTerminal {
                    ownership,
                    project_id: project.map(|entry| entry.id),
                    project_name: project.map(|entry| entry.name.clone()),
                    session: session.as_str().to_owned(),
                    pane_id: pane.pane_id.as_u32(),
                    title: pane.title,
                    cwd: pane.working_directory,
                    status: match pane.process {
                        PaneProcessState::Running { .. } => "running",
                        PaneProcessState::Exited => "exited",
                        _ => "unknown",
                    },
                    target_ref,
                });
            }
        }
        entries.sort_by(|left, right| {
            (left.project_id, &left.session, left.pane_id).cmp(&(
                right.project_id,
                &right.session,
                right.pane_id,
            ))
        });
        Ok(entries)
    })
    .await
    .map_err(|_| {
        failure(
            EXIT_OPERATION_TIMEOUT,
            "timeout",
            "terminal discovery timed out",
            json_mode,
            false,
        )
    })?
}

pub(crate) async fn list(
    socket: &Path,
    project_id: Option<i32>,
    json_mode: bool,
) -> Result<(), CliError> {
    let instance = crate::project::resolve_instance(json_mode)?;
    let entries = list_entries(&instance, socket, project_id, json_mode).await?;
    if json_mode {
        println!("{}", json!({ "terminals": entries }));
    } else {
        // 人读表格只给短名；target_ref 留在 --json 里给 Agent。
        println!("{:<24} {:<8} TITLE", "TERMINAL", "STATUS");
        for entry in entries {
            let handle = match &entry.project_name {
                Some(name) => terminal_handle(name, entry.pane_id),
                None => format!("{} ({})", entry.session, entry.ownership),
            };
            println!(
                "{handle:<24} {:<8} {}",
                entry.status,
                entry.title.as_deref().unwrap_or("-"),
            );
        }
    }
    Ok(())
}

/// 明确项目的一次性创建；预检完成前不连接或启动 daemon。
/// `agent` 为 (tool id, 启动输入)，与 GUI 启动栏同一 argv。
pub(crate) async fn create(
    socket: &Path,
    gui_override: Option<&OsString>,
    project_id: i32,
    agent: Option<(String, BTreeMap<String, Value>)>,
    provider_id: Option<i32>,
    model_id: Option<&str>,
    cwd_override: Option<&Path>,
    json_mode: bool,
) -> Result<(), CliError> {
    let created = create_terminal(
        socket,
        gui_override,
        project_id,
        agent,
        provider_id,
        model_id,
        cwd_override,
        json_mode,
    )
    .await?;
    if json_mode {
        println!("{}", json!({ "terminal": created }));
    } else {
        // 人类输出也直接给可复用 ref，不要求再 list 或拼地址。
        println!("{}", created["target_ref"].as_str().unwrap_or_default());
    }
    Ok(())
}

/// [`create`] 的核心：返回 `terminal` 对象（含 `target_ref`），不打印。`berth group spawn` 也用它。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_terminal(
    socket: &Path,
    gui_override: Option<&OsString>,
    project_id: i32,
    agent: Option<(String, BTreeMap<String, Value>)>,
    provider_id: Option<i32>,
    model_id: Option<&str>,
    cwd_override: Option<&Path>,
    json_mode: bool,
) -> Result<Value, CliError> {
    let instance = crate::project::resolve_instance(json_mode)?;
    let catalog = crate::project::catalog_entries(&instance, ProjectScope::All)
        .await
        .map_err(|state| CliError::from_instance(state, json_mode))?;
    let project = catalog
        .iter()
        .find(|entry| entry.id == project_id)
        .ok_or_else(|| {
            failure(
                EXIT_TARGET_NOT_FOUND,
                "not_found",
                "project is not registered in this data instance",
                json_mode,
                false,
            )
        })?;
    let namespace = instance
        .namespace_key()
        .map_err(|state| CliError::from_instance(state, json_mode))?;
    let invalid =
        |message: String| failure(EXIT_USER_ERROR, "invalid_params", message, json_mode, false);
    let project_path = Path::new(&project.path);
    if !project_path.is_absolute() || !project_path.is_dir() {
        return Err(invalid(
            "registered project directory is unavailable".into(),
        ));
    }
    let root = std::fs::canonicalize(project_path)
        .map_err(|error| invalid(format!("project directory is unavailable: {error}")))?;
    let cwd = match cwd_override {
        Some(requested) => project_cwd(&root, requested).map_err(&invalid)?,
        None => root,
    };
    let cwd = lossless_path(&cwd).map_err(&invalid)?;
    let session = project_session_key(&namespace, &project.project_runtime_id)
        .map_err(|error| invalid(error.to_string()))?;
    let session = SessionName::new(&session).map_err(|error| invalid(error.to_string()))?;
    let shell = which::which(resolve_shell())
        .map_err(|error| invalid(format!("shell is unavailable: {error}")))?;
    let shell = lossless_path(&shell).map_err(&invalid)?;
    let gui = crate::gui_client::resolve_gui_endpoint(gui_override)
        .map_err(|error| invalid(error.to_string()))?;
    let home = std::path::absolute(berth_tool_core::paths::berth_home_dir())
        .map_err(|error| invalid(error.to_string()))?;
    // TMPDIR 继续由既有 IPC 默认解析；实际 -S/-L 由 daemon 为子进程注入 BERTH。
    let tmpdir = launch_tmpdir().map_err(|error| invalid(error.to_string()))?;
    let host = TerminalLaunchEnvironment::from_resolved_paths(
        instance.data_dir(),
        instance.db_file_name(),
        gui.as_path(),
        &tmpdir,
        &home,
        cli_command().as_deref(),
        std::env::var("PATH").ok(),
    )
    .map_err(|error| invalid(error.to_string()))?;
    let mut provider_injected = false;
    let (argv, launch_env) = match &agent {
        Some((id, inputs)) => {
            berth_tool_core::plugins::ensure_enabled(id)
                .map_err(|error| invalid(error.to_string()))?;
            let (mut argv, payload) =
                agent_argv(&berth_tool_core::paths::tools_root(), id, inputs).map_err(&invalid)?;
            // 与 GUI 同一注入：`--berth-provider <启动档案>` 追加在启动输入之后。
            let provider_args =
                crate::provider_launch::resolve(&instance, id, provider_id, model_id, false)
                    .await
                    .map_err(&invalid)?;
            if provider_args.iter().any(|arg| arg.contains('\0')) {
                return Err(invalid("provider arguments must not contain NUL".into()));
            }
            provider_injected = !provider_args.is_empty();
            argv.extend(provider_args);
            let env = HashMap::from([("BERTH_LAUNCH_INPUTS".to_owned(), payload)]);
            (argv, Some(env))
        }
        None => (vec![shell], None),
    };
    let mut environment = host
        .merge(launch_env)
        .map_err(|error| invalid(error.to_string()))?
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>();
    environment.sort();
    let mut process = ProcessSpec::argv(argv);
    process.environment = Some(environment);
    let terminal_id = uuid::Uuid::new_v4().to_string();
    let request = CreateTerminal {
        session,
        window_name: terminal_id.clone(),
        cwd: cwd.clone(),
        process,
        size: TerminalSizeSpec::new(120, 32),
        detached: true,
        keep_on_failed_exit: agent.is_some(),
    };
    let terminal = tokio::time::timeout(
        OPERATION_TIMEOUT,
        TerminalClientBuilder::new()
            .unix_socket(socket.to_path_buf())
            .default_timeout(OPERATION_TIMEOUT)
            .connect_or_start(),
    )
    .await
    .map_err(|_| {
        failure(
            EXIT_DAEMON_UNAVAILABLE,
            "daemon_unavailable",
            "terminal daemon startup timed out",
            json_mode,
            false,
        )
    })?
    .map_err(|error| sdk_failure(error, json_mode, false))?;
    let created = tokio::time::timeout(OPERATION_TIMEOUT, terminal.create_terminal(request))
        .await
        .map_err(|_| creation_unknown("terminal creation timed out", json_mode))?
        .map_err(|error| match error {
            TerminalError::Unsupported { .. } => sdk_failure(error, json_mode, false),
            _ => creation_unknown(error.to_string(), json_mode),
        })?;
    let binding = created.binding;
    let target_ref = TargetBindingRef {
        version: 1,
        daemon_instance: binding.daemon_instance,
        session: binding.session.as_str().to_owned(),
        pane_id: binding.pane_id.as_u32(),
        generation: binding.generation,
    }
    .encode()
    .map_err(|message| creation_unknown(message, json_mode))?;
    Ok(json!({
        "terminal_id": terminal_id, "project_id": project_id,
        "session": binding.session.as_str(), "pane_id": binding.pane_id.as_u32(),
        "cwd": cwd, "status": "created", "target_ref": target_ref,
        "agent": agent.as_ref().map(|(id, _)| id),
        "provider_injected": provider_injected,
    }))
}

/// GUI 同款 Agent argv（契约在 `berth_tool_core::paths::launch_script`）：
/// `<本 CLI> tools launch <tools>/<id>/launch.js --berth-launch-inputs <json>`。
/// 返回 (argv, 输入 JSON)；启动脚本必须留在 tools 根内。
pub(crate) fn agent_argv(
    tools_root: &Path,
    id: &str,
    inputs: &BTreeMap<String, Value>,
) -> Result<(Vec<String>, String), String> {
    let (script, payload) = berth_tool_core::paths::launch_script(tools_root, id, inputs.clone())?
        .ok_or_else(|| {
            format!(
                "no launch.js for agent '{id}' under {}",
                tools_root.display()
            )
        })?;
    let cli = std::env::current_exe().map_err(|error| format!("berth-cli: {error}"))?;
    let mut argv = vec![lossless_path(&cli)?, "tools".to_owned(), "launch".to_owned()];
    argv.extend([lossless_path(&script)?, "--berth-launch-inputs".to_owned(), payload.clone()]);
    Ok((argv, payload))
}

/// `--cwd` 只允许项目根、其子目录，或与项目共享 git common dir 的 worktree。
fn project_cwd(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    let cwd = std::fs::canonicalize(requested)
        .map_err(|error| format!("--cwd {}: {error}", requested.display()))?;
    if !cwd.is_dir() {
        return Err(format!("--cwd {} is not a directory", cwd.display()));
    }
    if cwd.starts_with(root) {
        return Ok(cwd);
    }
    match (git_common_dir(root), git_common_dir(&cwd)) {
        (Some(project), Some(worktree)) if project == worktree => Ok(cwd),
        _ => Err(format!(
            "--cwd {} is outside the project and not one of its git worktrees",
            cwd.display()
        )),
    }
}

fn git_common_dir(directory: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["rev-parse", "--git-common-dir"])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let raw = String::from_utf8(output.stdout).ok()?;
    // 旧版 git 输出相对路径：相对于 -C 目录。
    std::fs::canonicalize(directory.join(raw.trim())).ok()
}

fn creation_unknown(message: impl Into<String>, json_mode: bool) -> CliError {
    failure(
        EXIT_OPERATION_TIMEOUT,
        "outcome_unknown",
        message,
        json_mode,
        true,
    )
}

fn lossless_path(path: &Path) -> Result<String, String> {
    path.to_str()
        .filter(|path| !path.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| "launch path cannot be encoded as UTF-8".to_owned())
}

fn cli_command() -> Option<PathBuf> {
    let name = if cfg!(windows) { "berth.exe" } else { "berth" };
    std::env::current_exe()
        .ok()
        .and_then(|binary| binary.parent().map(|directory| directory.join(name)))
        .and_then(|command| which::which(command).ok())
        .or_else(|| which::which("berth").ok())
}

fn launch_tmpdir() -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        let endpoint = berth_term_ipc::default_endpoint()?;
        let root = endpoint
            .as_path()
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| std::io::Error::other("terminal endpoint has no socket root"))?;
        std::path::absolute(root)
    }
    #[cfg(not(unix))]
    {
        std::path::absolute(
            std::env::var_os("BERTH_TMPDIR")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir),
        )
    }
}

/// 观测一个已知 pane；stale 目标返回 `EXIT_TARGET_NOT_FOUND`。
pub(crate) async fn probe(socket: &Path, reference: &str) -> Result<PaneProbe, CliError> {
    let binding = resolve_target(socket, reference, false).await?;
    let terminal = connect_existing(socket, false).await?;
    probe_with(&terminal, binding).await
}

async fn probe_with(terminal: &Terminal, binding: RuntimeBinding) -> Result<PaneProbe, CliError> {
    tokio::time::timeout(OPERATION_TIMEOUT, async {
        let pane = bound_pane(terminal, binding.clone(), false).await?;
        let info = pane
            .info()
            .await
            .map_err(|error| sdk_failure(error, false, false))?;
        let Some(pane) = info.pane(binding.pane_id) else {
            return Err(failure(
                EXIT_TARGET_NOT_FOUND,
                "stale_target",
                "pane is no longer listed",
                false,
                false,
            ));
        };
        Ok(PaneProbe {
            pane_id: binding.pane_id.as_u32(),
            expert: pane
                .command
                .as_deref()
                .and_then(berth_tool_core::paths::launch_command_expert),
            session_id: pane
                .command
                .as_deref()
                .and_then(berth_tool_core::paths::launch_session_id),
            session_project_path: None,
            agent_state: pane_agent_state(&pane.process, &pane.agent.state),
            // 进度条状态名同 tmux `pane_pb_state`：hidden 是一轮已结束（或从没报告过）。
            busy: !matches!(pane.agent.progress_state.as_str(), "" | "hidden"),
            notification: Some(pane.agent.notification.clone()).filter(|text| !text.is_empty()),
            launch_agent: pane
                .command
                .as_deref()
                .and_then(berth_tool_core::paths::launch_tool_id),
            foreground_command: pane.foreground_command.clone(),
            cwd: pane
                .foreground_path
                .clone()
                .or_else(|| pane.working_directory.clone()),
        })
    })
    .await
    .map_err(|_| {
        failure(
            EXIT_OPERATION_TIMEOUT,
            "timeout",
            "terminal probe timed out",
            false,
            false,
        )
    })?
}

/// 指定项目下全部 live pane 的观测（群组后台进程派生成员用）；单个 pane 观测失败就跳过它。
pub(crate) async fn project_panes(
    socket: &Path,
    project_ids: &[i32],
) -> Result<Vec<(String, PaneProbe)>, CliError> {
    let instance = crate::project::resolve_instance(false)?;
    let catalog = crate::project::catalog_entries(&instance, ProjectScope::All)
        .await
        .map_err(|state| CliError::from_instance(state, false))?;
    let entries = list_entries(&instance, socket, None, false).await?;
    let terminal = connect_existing(socket, false).await?;
    let mut out = Vec::new();
    for entry in entries {
        if !entry.project_id.is_some_and(|id| project_ids.contains(&id)) {
            continue;
        }
        let Some(target_ref) = entry.target_ref else {
            continue;
        };
        let Ok(binding) = parse_binding(&target_ref, false) else {
            continue;
        };
        if let Ok(mut probe) = probe_with(&terminal, binding).await {
            probe.session_project_path = entry
                .project_id
                .and_then(|id| catalog.iter().find(|project| project.id == id))
                .map(|project| project.path.clone());
            out.push((target_ref, probe));
        }
    }
    Ok(out)
}

pub(crate) async fn capture(
    socket: &Path,
    reference: &str,
    lines: Option<u32>,
    json_mode: bool,
) -> Result<(), CliError> {
    let (line_limit, byte_limit) = WorkspaceExcerptParams { lines }
        .limits()
        .map_err(|message| failure(EXIT_USER_ERROR, "invalid_params", message, json_mode, false))?;
    let binding = resolve_target(socket, reference, json_mode).await?;
    let terminal = connect_existing(socket, json_mode).await?;
    let (captured, agent_state, notification, agent) =
        tokio::time::timeout(OPERATION_TIMEOUT, async {
            let pane = bound_pane(&terminal, binding.clone(), json_mode).await?;
            let captured = pane
                .capture_pane()
                .start(-i64::from(line_limit))
                .await
                .map_err(|error| sdk_failure(error, json_mode, false))?;
            // 门铃据此判断目标是否空闲；同一次绑定校验，不另开查询入口。
            let info = pane
                .info()
                .await
                .map_err(|error| sdk_failure(error, json_mode, false))?;
            let pane_info = info.pane(binding.pane_id);
            let agent_state =
                pane_info.and_then(|pane| pane_agent_state(&pane.process, &pane.agent.state));
            // 最近一条 OSC 9 / 777 通知（格式变量 pane_agent_notification）。
            let notification = pane_info
                .map(|pane| pane.agent.notification.clone())
                .filter(|text| !text.is_empty());
            // 经 tools/<id>/launch.js 启动的 Agent pane；门铃只往这类 pane 粘贴正文，shell 只收固定指针行。
            let agent = pane_info
                .and_then(|pane| pane.command.as_deref())
                .and_then(berth_tool_core::paths::launch_tool_id);
            Ok::<_, CliError>((captured, agent_state, notification, agent))
        })
        .await
        .map_err(|_| {
            failure(
                EXIT_OPERATION_TIMEOUT,
                "timeout",
                "terminal capture timed out",
                json_mode,
                false,
            )
        })??;
    let body = String::from_utf8_lossy(&captured.stdout);
    let (content, truncated) = capture_excerpt(&body, line_limit, byte_limit);
    if json_mode {
        println!(
            "{}",
            json!({
                "content": content, "output_sequence": captured.output_sequence,
                "truncated": truncated, "agent_state": agent_state,
                "agent_notification": notification, "agent": agent,
            })
        );
    } else {
        print!("{content}");
    }
    Ok(())
}

/// termd 的 `pane_agent_state`；进程已退出记为 `exited`，旧 daemon 不认识该变量时为 `None`。
fn pane_agent_state(process: &PaneProcessState, state: &str) -> Option<&'static str> {
    if matches!(process, PaneProcessState::Exited) {
        return Some("exited");
    }
    match state {
        "attention" => Some("attention"),
        "working" => Some("working"),
        "idle" => Some("idle"),
        _ => None,
    }
}

fn capture_excerpt(text: &str, lines: u32, bytes: usize) -> (String, bool) {
    // 仅丢弃终端屏幕底部的空白行；正文行末空格、内部空行和文档原文都保留。
    let padding: usize = text
        .split_inclusive('\n')
        .rev()
        .take_while(|line| {
            line.bytes()
                .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        })
        .map(str::len)
        .sum();
    excerpt_tail(&text[..text.len() - padding], lines, bytes)
}


fn parse_input(
    text: Option<String>,
    key: Option<String>,
    json_mode: bool,
) -> Result<Input, CliError> {
    match (text, key) {
        (Some(text), None) if text.len() <= 256 * 1024 => Ok(Input::Text(text)),
        (None, Some(key)) if !key.is_empty() && key.len() <= 64 => Ok(Input::Key(key)),
        _ => Err(failure(
            EXIT_USER_ERROR,
            "invalid_params",
            "specify exactly one bounded --text or --key",
            json_mode,
            false,
        )),
    }
}

pub(crate) async fn send(
    socket: &Path,
    reference: &str,
    text: Option<String>,
    key: Option<String>,
    paste: bool,
    json_mode: bool,
) -> Result<(), CliError> {
    let input = parse_input(text, key, json_mode)?;
    send_input(socket, reference, input, paste, json_mode).await?;
    if json_mode {
        println!("{}", json!({ "sent": true }));
    }
    Ok(())
}

/// `terminal close`：关闭终端所在窗口（最后一个窗口时连同会话），与 GUI 关闭终端同一个 daemon 操作；
/// 代际校验与关闭在 daemon 同一把锁内完成，过期的引用不会误关新终端。GUI 随 termd 清单移除该终端。
pub(crate) async fn close(socket: &Path, reference: &str, json_mode: bool) -> Result<(), CliError> {
    let binding = resolve_target(socket, reference, json_mode).await?;
    let terminal = connect_existing(socket, json_mode).await?;
    tokio::time::timeout(OPERATION_TIMEOUT, async {
        let pane = bound_pane(&terminal, binding, json_mode).await?;
        pane.close_guarded_window()
            .await
            .map_err(|error| sdk_failure(error, json_mode, true))
    })
    .await
    .map_err(|_| {
        failure(
            EXIT_OPERATION_TIMEOUT,
            "timeout",
            "terminal close timed out",
            json_mode,
            true,
        )
    })??;
    if json_mode {
        println!("{}", json!({ "closed": true }));
    }
    Ok(())
}

/// 向已知 pane 写入（群组送达与 `terminal send` 共用）。stale 目标返回 `EXIT_TARGET_NOT_FOUND`。
pub(crate) async fn send_input(
    socket: &Path,
    reference: &str,
    input: Input,
    paste: bool,
    json_mode: bool,
) -> Result<(), CliError> {
    let binding = resolve_target(socket, reference, json_mode).await?;
    let terminal = connect_existing(socket, json_mode).await?;
    tokio::time::timeout(OPERATION_TIMEOUT, async {
        let pane = bound_pane(&terminal, binding.clone(), json_mode).await?;
        let result = match input {
            Input::Text(text) if paste => {
                let info = pane
                    .info()
                    .await
                    .map_err(|error| sdk_failure(error, json_mode, false))?;
                let slot = info.pane(binding.pane_id).and_then(|pane| {
                    info.window(pane.window_id)
                        .map(|window| (window.index, pane.index))
                });
                let Some((window, index)) = slot else {
                    return Err(failure(
                        EXIT_TARGET_NOT_FOUND,
                        "stale_target",
                        "pane is no longer listed",
                        json_mode,
                        false,
                    ));
                };
                let target = berth_term_proto::PaneTarget::with_window(
                    binding.session.clone(),
                    window,
                    index,
                );
                return paste_text(socket, target, text, json_mode);
            }
            Input::Text(text) => pane.send_text(text).await,
            Input::Key(key) => pane.send_key(key).await,
        };
        result.map_err(|error| sdk_failure(error, json_mode, true))
    })
    .await
    .map_err(|_| {
        failure(
            EXIT_OPERATION_TIMEOUT,
            "timeout",
            "terminal send timed out",
            json_mode,
            true,
        )
    })??;
    Ok(())
}

/// 经 termd `paste-buffer` 以括号粘贴写入正文（不含 Enter）。pane 未开启括号粘贴时拒绝：
/// 否则多行正文的换行会被逐行提交，调用方应改投单行文本。
fn paste_text(
    socket: &Path,
    target: berth_term_proto::PaneTarget,
    text: String,
    json_mode: bool,
) -> Result<(), CliError> {
    use berth_term_proto::{
        DisplayMessageRequest, PasteBufferRequest, Request, Response, SetBufferRequest, Target,
    };
    let mut connection = crate::attach_client::connect(socket).map_err(|error| {
        failure(
            EXIT_DAEMON_UNAVAILABLE,
            "daemon_unavailable",
            error.to_string(),
            json_mode,
            false,
        )
    })?;
    let mut call = |request: Request| match connection.roundtrip(&request) {
        Ok(Response::Error(error)) => Err(failure(
            EXIT_REJECTED,
            "rejected",
            error.error.to_string(),
            json_mode,
            true,
        )),
        Ok(response) => Ok(response),
        Err(error) => Err(failure(
            EXIT_DAEMON_UNAVAILABLE,
            "daemon_unavailable",
            error.to_string(),
            json_mode,
            true,
        )),
    };
    let flag = call(Request::DisplayMessage(DisplayMessageRequest {
        target: Some(Target::Pane(target.clone())),
        print: true,
        message: Some("#{bracket_paste_flag}".to_owned()),
        empty_target_context: false,
    }))?;
    let enabled = matches!(&flag, Response::DisplayMessage(response)
        if response.output.as_ref().is_some_and(|output| output.stdout.starts_with(b"1")));
    if !enabled {
        return Err(failure(
            EXIT_REJECTED,
            "paste_unsupported",
            "pane has not enabled bracketed paste",
            json_mode,
            false,
        ));
    }
    let name = format!("berth-paste-{}", uuid::Uuid::new_v4());
    call(Request::SetBuffer(SetBufferRequest {
        name: Some(name.clone()),
        content: text.into_bytes(),
        append: false,
        new_name: None,
        set_clipboard: false,
    }))?;
    call(Request::PasteBuffer(Box::new(PasteBufferRequest {
        name: Some(name),
        target,
        delete_after: true,
        separator: None,
        linefeed: true,
        raw: true,
        bracketed: true,
    })))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn cli_result<T>(result: Result<T, CliError>) -> Result<T, std::io::Error> {
        result.map_err(|error| std::io::Error::other(error.message))
    }

    #[test]
    fn creation_unknown_is_one_error_without_a_success_ref() {
        let error = creation_unknown("creation reply was lost", true);
        assert_eq!(error.exit_code, EXIT_OPERATION_TIMEOUT);
        let value: serde_json::Value =
            serde_json::from_str(error.json_message.as_deref().unwrap()).unwrap();
        assert_eq!(
            value,
            json!({ "error": {
                "kind": "outcome_unknown",
                "message": "creation reply was lost",
                "outcome": "unknown"
            }})
        );
        assert!(creation_unknown("creation reply was lost", false)
            .json_message
            .is_none());
    }

    #[test]
    fn agent_argv_matches_gui_launch_and_stays_inside_tools() {
        let tools = tempfile::tempdir().unwrap();
        std::fs::create_dir(tools.path().join("demo")).unwrap();
        std::fs::write(tools.path().join("demo/launch.js"), "").unwrap();
        let inputs = BTreeMap::from([("model".to_owned(), json!("m1"))]);
        let (argv, payload) = agent_argv(tools.path(), "demo", &inputs).unwrap();
        assert_eq!(payload, r#"{"model":"m1"}"#);
        assert_eq!(&argv[1..3], ["tools", "launch"]);
        assert!(argv[3].ends_with("/demo/launch.js"));
        assert_eq!(&argv[4..], ["--berth-launch-inputs", payload.as_str()]);
        assert!(agent_argv(tools.path(), "missing", &inputs).is_err());
        assert!(agent_argv(tools.path(), "../demo", &inputs).is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("launch.js"), "").unwrap();
            std::os::unix::fs::symlink(outside.path(), tools.path().join("escape")).unwrap();
            assert!(agent_argv(tools.path(), "escape", &inputs)
                .unwrap_err()
                .contains("escapes"));
        }
    }

    #[test]
    fn cwd_allows_project_subdirs_and_its_worktrees_only() {
        let git = |dir: &Path, args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(args)
                .output()
                .unwrap()
                .status;
            assert!(status.success(), "git {args:?}");
        };
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("repo");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let worktree = base.path().join("repo-feature");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                worktree.to_str().unwrap(),
            ],
        );
        let other = base.path().join("other");
        std::fs::create_dir(&other).unwrap();
        git(&other, &["init", "-q"]);
        let root = std::fs::canonicalize(&root).unwrap();

        assert_eq!(
            project_cwd(&root, &root.join("sub")).unwrap(),
            root.join("sub")
        );
        assert_eq!(
            project_cwd(&root, &worktree).unwrap(),
            std::fs::canonicalize(&worktree).unwrap()
        );
        assert!(project_cwd(&root, &other).is_err());
        assert!(project_cwd(&root, base.path()).is_err());
        assert!(project_cwd(&root, &base.path().join("absent")).is_err());
    }

    #[test]
    fn capture_excerpt_removes_only_terminal_bottom_padding() {
        let screen = "第一行\n\nready 🌍  \n\n   \n\t\n";
        assert_eq!(
            capture_excerpt(screen, 1, 8192),
            ("ready 🌍  \n".into(), true)
        );
        assert_eq!(
            capture_excerpt(screen, 80, 8192),
            ("第一行\n\nready 🌍  \n".into(), false)
        );
        assert_eq!(
            capture_excerpt("\n \n\t\n", 1, 8192),
            (String::new(), false)
        );
        assert_eq!(capture_excerpt("界界", 1, 4), ("界".into(), true));
        // 共用的文档摘录不受终端 padding 处理影响。
        assert_eq!(excerpt_tail("notes\n\n", 80, 8192).0, "notes\n\n");
    }

    #[test]
    fn agent_state_prefers_exit_and_hides_unknown_values() {
        assert_eq!(
            pane_agent_state(&PaneProcessState::Exited, "idle"),
            Some("exited")
        );
        assert_eq!(
            pane_agent_state(&PaneProcessState::default(), "working"),
            Some("working")
        );
        assert_eq!(pane_agent_state(&PaneProcessState::default(), ""), None);
    }

    #[test]
    fn literal_text_and_explicit_key_never_guess_from_contents() {
        assert_eq!(
            parse_input(Some("Enter".into()), None, false).unwrap(),
            Input::Text("Enter".into())
        );
        assert_eq!(
            parse_input(None, Some("Enter".into()), false).unwrap(),
            Input::Key("Enter".into())
        );
        let multiline = "第一行\n第二行🌍";
        assert_eq!(
            parse_input(Some(multiline.into()), None, false).unwrap(),
            Input::Text(multiline.into())
        );
        let error = parse_input(Some("x".into()), Some("Enter".into()), true).unwrap_err();
        assert_eq!(error.exit_code, EXIT_USER_ERROR);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&error.json_message.unwrap()).unwrap()
                ["error"]["kind"],
            "invalid_params"
        );
    }

    #[test]
    fn target_ref_rejects_bad_versions_and_rewritten_sessions() {
        let good = TargetBindingRef {
            version: 1,
            daemon_instance: Some("epoch".into()),
            session: "work".into(),
            pane_id: 17,
            generation: 3,
        }
        .encode()
        .unwrap();
        assert_eq!(parse_binding(&good, true).unwrap().pane_id.as_u32(), 17);
        assert_eq!(
            parse_binding("v2.invalid", true).unwrap_err().exit_code,
            EXIT_USER_ERROR
        );
        let rewritten = TargetBindingRef {
            version: 1,
            daemon_instance: None,
            session: "bad:name".into(),
            pane_id: 1,
            generation: 1,
        }
        .encode()
        .unwrap();
        assert_eq!(
            parse_binding(&rewritten, true).unwrap_err().exit_code,
            EXIT_USER_ERROR
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_is_headless_owned_and_preserves_legacy_without_refs(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::attach_client::test_support::{start_server, TestHarness};
        use berth_project_core::open::open_or_upgrade;
        use berth_project_core::runtime::project_session_key;
        use berth_project_core::service::folder_service;
        use berth_term_sdk::berth::EnsureSession;

        let data = tempfile::tempdir()?;
        let owner = DataInstance::create_if_missing(data.path(), "berth.db");
        let (connection, state) = open_or_upgrade(&owner).await;
        assert!(state.is_ready());
        let connection = connection.expect("synthetic catalog");
        for name in ["project-a", "project-b"] {
            folder_service::add_folder(&connection, &format!("/tmp/{name}")).await?;
        }
        connection.close().await?;
        let instance = DataInstance::existing_only(data.path(), "berth.db");
        let catalog = crate::project::catalog_entries(&instance, ProjectScope::All)
            .await
            .map_err(|state| std::io::Error::other(state.message()))?;
        let namespace = instance
            .namespace_key()
            .map_err(|state| std::io::Error::other(state.message()))?;
        let owned: Vec<_> = catalog
            .iter()
            .map(|entry| project_session_key(&namespace, &entry.project_runtime_id))
            .collect::<Result<_, _>>()?;
        let foreign = project_session_key(&"f".repeat(64), &catalog[0].project_runtime_id)?;
        let unresolved = project_session_key(&namespace, "00000000-0000-4000-8000-000000000001")?;
        let harness = TestHarness::new("workspace-list");
        let mut server = start_server(&harness)?;
        let terminal = cli_result(connect_existing(harness.socket_path(), true).await)?;
        for name in owned.iter().map(String::as_str).chain([
            foreign.as_str(),
            unresolved.as_str(),
            "1",
            "berth-terminal-personal",
        ]) {
            EnsureSession::named(SessionName::new(name)?)
                .create_only()
                .working_directory("/tmp")
                .window_name("duplicate-title")
                .argv([
                    "/bin/sh",
                    "-c",
                    "while IFS= read -r input; do printf 'D0_LIST_%s\\n' \"$input\"; done",
                ])
                .ensure(&terminal)
                .await?;
        }
        let before = std::fs::read(instance.db_path())?;
        let entries = cli_result(list_entries(&instance, harness.socket_path(), None, true).await)?;
        assert_eq!(entries.len(), 5);
        assert!(!entries.iter().any(|entry| entry.session == foreign));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.ownership == "project")
                .count(),
            2
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.ownership == "legacy_unresolved")
                .count(),
            2
        );
        for entry in &entries {
            let encoded = serde_json::to_value(entry)?;
            assert!(encoded.get("content").is_none());
            assert!(encoded.get("command").is_none());
            if entry.ownership != "project" {
                assert!(encoded.get("target_ref").is_none());
                assert!(entry.project_id.is_none());
            }
        }
        let filtered = cli_result(
            list_entries(&instance, harness.socket_path(), Some(catalog[1].id), true).await,
        )?;
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].project_id, Some(catalog[1].id));
        let reference = filtered[0].target_ref.as_deref().expect("owned target ref");
        let captured =
            parse_binding(reference, true).map_err(|e| std::io::Error::other(e.message))?;
        assert!(
            captured.generation > 0,
            "SDK must retain the observed generation"
        );
        cli_result(
            send(
                harness.socket_path(),
                reference,
                Some("B_ONLY".into()),
                None,
                false,
                true,
            )
            .await,
        )?;
        cli_result(
            send(
                harness.socket_path(),
                reference,
                None,
                Some("Enter".into()),
                false,
                true,
            )
            .await,
        )?;
        let pane = cli_result(bound_pane(&terminal, captured, true).await)?;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let captured = pane.capture_pane().start(-80).await?;
                if String::from_utf8_lossy(&captured.stdout).contains("D0_LIST_B_ONLY") {
                    break Ok::<_, TerminalError>(());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await??;
        // 读循环没开括号粘贴：拒绝，免得多行正文被逐行提交。
        let refused = send(
            harness.socket_path(),
            reference,
            Some("P1\nP2".into()),
            None,
            true,
            true,
        )
        .await
        .expect_err("paste needs bracketed paste mode");
        assert_eq!(refused.exit_code, EXIT_REJECTED);
        assert!(refused
            .json_message
            .unwrap()
            .contains("\"kind\":\"paste_unsupported\""));
        let other = entries
            .iter()
            .find(|entry| entry.project_id == Some(catalog[0].id))
            .unwrap();
        let other = cli_result(parse_binding(other.target_ref.as_deref().unwrap(), true))?;
        let pane = cli_result(bound_pane(&terminal, other, true).await)?;
        assert!(
            !String::from_utf8_lossy(&pane.capture_pane().start(-80).await?.stdout)
                .contains("B_ONLY")
        );
        assert_eq!(
            std::fs::read(instance.db_path())?,
            before,
            "listing must not change the catalog"
        );

        let missing_project = list_entries(&instance, harness.socket_path(), Some(i32::MAX), true)
            .await
            .expect_err("unknown project is not an empty live list");
        assert_eq!(missing_project.exit_code, EXIT_TARGET_NOT_FOUND);
        server.shutdown()?;
        let offline = list_entries(&instance, harness.socket_path(), None, true)
            .await
            .expect_err("listing cannot start the daemon");
        assert_eq!(offline.exit_code, EXIT_DAEMON_UNAVAILABLE);
        Ok(())
    }

    #[tokio::test]
    async fn listing_rejects_a_missing_catalog_without_starting_any_process() {
        let data = tempfile::tempdir().unwrap();
        let instance = DataInstance::existing_only(data.path(), "missing.db");
        let error = list_entries(&instance, &data.path().join("absent.sock"), None, true)
            .await
            .expect_err("missing is not an empty catalog");
        assert_eq!(error.exit_code, crate::EXIT_GUI_UNAVAILABLE);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(error.json_message.as_deref().unwrap())
                .unwrap()["error"]["kind"],
            "instance_unavailable"
        );
        assert!(!instance.db_path().exists());
        assert!(!data.path().join("absent.sock").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn isolated_daemon_accepts_bound_input_and_rejects_expired_refs(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::attach_client::test_support::{start_server, TestHarness};
        use berth_term_sdk::berth::EnsureSession;

        let harness = TestHarness::new("workspace-bind");
        let mut server = start_server(&harness)?;
        let terminal = cli_result(connect_existing(harness.socket_path(), false).await)?;
        let session = EnsureSession::named(SessionName::new("workspace-bind")?)
            .create_only()
            .working_directory("/tmp")
            .argv([
                "/bin/sh",
                "-c",
                "while IFS= read -r input; do printf 'D0_%s\\n' \"$input\"; done",
            ])
            .ensure(&terminal)
            .await?;
        let pane = session.pane(0, 0);
        let info = pane.info().await?;
        let current = info.panes.first().expect("synthetic pane");
        let binding = TargetBindingRef {
            version: 1,
            daemon_instance: terminal.daemon_instance().await?,
            session: session.name().as_str().to_owned(),
            pane_id: current.id.as_u32(),
            generation: current.generation,
        };
        assert!(
            binding.daemon_instance.is_some(),
            "fixture advertises a daemon epoch"
        );
        let reference = binding.encode()?;

        cli_result(
            send(
                harness.socket_path(),
                &reference,
                Some("SYNTHETIC_OUTPUT".into()),
                None,
                false,
                false,
            )
            .await,
        )?;
        cli_result(
            send(
                harness.socket_path(),
                &reference,
                None,
                Some("Enter".into()),
                false,
                false,
            )
            .await,
        )?;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let captured = pane.capture_pane().start(-80).await?;
                if String::from_utf8_lossy(&captured.stdout).contains("D0_SYNTHETIC_OUTPUT") {
                    assert!(captured.output_sequence > 0);
                    break Ok::<_, TerminalError>(());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await??;
        cli_result(capture(harness.socket_path(), &reference, None, true).await)?;

        for expired in [
            TargetBindingRef {
                generation: binding.generation + 1,
                ..binding.clone()
            },
            TargetBindingRef {
                daemon_instance: Some("other-instance".into()),
                ..binding.clone()
            },
            TargetBindingRef {
                daemon_instance: None,
                ..binding.clone()
            },
        ] {
            let error = send(
                harness.socket_path(),
                &expired.encode()?,
                Some("DO_NOT_SEND".into()),
                None,
                false,
                true,
            )
            .await
            .expect_err("expired target must not receive input");
            assert_eq!(error.exit_code, EXIT_TARGET_NOT_FOUND);
        }

        server.shutdown()?;
        let error = capture(harness.socket_path(), &reference, None, true)
            .await
            .expect_err("no implicit daemon startup");
        assert_eq!(error.exit_code, EXIT_DAEMON_UNAVAILABLE);
        Ok(())
    }
}
