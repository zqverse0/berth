//! Pure input validation and normalization for terminal launches.

use std::collections::HashMap;
#[cfg(all(test, unix))]
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::terminal::error::TerminalError;

const MAX_TERMINAL_ID_LENGTH: usize = 256;
const MIN_TERMINAL_ROWS: u16 = 1;
const MIN_TERMINAL_COLS: u16 = 1;
const MAX_TERMINAL_ROWS: u16 = 200;
const MAX_TERMINAL_COLS: u16 = 500;

use berth_term_sdk::berth::prepend_dir_to_path;
pub use berth_term_sdk::berth::resolve_shell;
pub(super) use berth_term_sdk::berth::TerminalLaunchEnvironment;

pub(super) fn validate_shell(value: Option<&str>) -> Result<String, TerminalError> {
    let shell = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(resolve_shell);
    if which::which(&shell).is_err() {
        return Err(TerminalError::ShellNotFound(shell));
    }
    Ok(shell)
}

pub(super) fn validate_cwd(value: &str) -> Result<String, TerminalError> {
    let trimmed = value.trim();
    if !Path::new(trimmed).is_dir() {
        return Err(TerminalError::InvalidWorkingDirectory(value.to_string()));
    }
    Ok(std::fs::canonicalize(trimmed)
        .unwrap_or_else(|_| PathBuf::from(trimmed))
        .to_string_lossy()
        .into_owned())
}

pub(super) fn normalize_terminal_id(value: Option<String>) -> Result<String, TerminalError> {
    let value = value
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if value.len() > MAX_TERMINAL_ID_LENGTH || value.contains('\0') {
        return Err(TerminalError::SpawnFailed(
            "terminal id is invalid".to_string(),
        ));
    }
    Ok(value)
}

pub(super) fn validate_direct_command(
    executable: Option<&str>,
    args: &[String],
) -> Result<(), TerminalError> {
    if executable
        .is_some_and(|executable| executable.trim().is_empty() || executable.contains('\0'))
        || args.iter().any(|arg| arg.contains('\0'))
    {
        return Err(TerminalError::SpawnFailed(
            "managed command argv is invalid".to_string(),
        ));
    }
    Ok(())
}

/// 把裸命令名解析成 GUI 进程 PATH 上的绝对路径，并把其所在目录前置进 PATH。
///
/// Agent 契约写的是 `codex` 这类名字。daemon pane 清环境后只用 session PATH，
/// 找不到 nvm 包装器时就会变成 `No such file or directory`。在 GUI 侧解析，
/// 可执行文件和 `#!/usr/bin/env node` 的解释器都能对上。
pub(super) fn resolve_direct_executable(
    executable: Option<String>,
    extra_env: Option<HashMap<String, String>>,
) -> (Option<String>, Option<HashMap<String, String>>) {
    let Some(command) = executable else {
        return (None, extra_env);
    };
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return (Some(command), extra_env);
    }
    let path = Path::new(trimmed);
    if path.components().count() > 1 || path.is_absolute() {
        return (Some(trimmed.to_owned()), extra_env);
    }
    let Ok(resolved) = which::which(trimmed) else {
        return (Some(trimmed.to_owned()), extra_env);
    };
    let resolved_command = resolved.to_string_lossy().into_owned();
    let Some(dir) = resolved.parent() else {
        return (Some(resolved_command), extra_env);
    };
    let mut env = extra_env.unwrap_or_default();
    let current = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok());
    if let Some(path_value) = prepend_dir_to_path(dir, current.as_deref()) {
        env.insert("PATH".to_owned(), path_value);
    }
    (Some(resolved_command), Some(env))
}

pub(super) fn clamp_grid(rows: u16, cols: u16) -> (u16, u16) {
    (
        rows.clamp(MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
        cols.clamp(MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
    )
}

pub(super) fn input_text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

pub(super) fn environment_to_vec(
    environment: Option<HashMap<String, String>>,
) -> Option<Vec<String>> {
    let mut values = environment?.into_iter().collect::<Vec<_>>();
    values.sort_by(|left, right| left.0.cmp(&right.0));
    Some(
        values
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_environment_projects_actual_database_and_explicit_empty_path() {
        let root = tempfile::tempdir().expect("synthetic paths");
        let instance = berth_project_core::instance::DataInstance::create_if_missing(
            root.path().join("data"),
            "custom.db",
        );
        let environment = TerminalLaunchEnvironment::from_resolved_paths(
            instance.data_dir(),
            instance.db_file_name(),
            &root.path().join("gui.sock"),
            &root.path().join("sockets"),
            &root.path().join("assets"),
            None,
            None,
        )
        .expect("resolved paths");
        let values = environment.merge(None).expect("projected environment");
        assert_eq!(values["BERTH_DATA_FILE"], "custom.db");
        assert_eq!(values["PATH"], "");
        assert_eq!(values.len(), 6);
        assert!(
            !instance.db_path().exists(),
            "projection must not open a database"
        );
    }

    #[test]
    fn launch_environment_sidecar_name_does_not_claim_a_berth_command() {
        let root = tempfile::tempdir().expect("synthetic paths");
        let instance =
            berth_project_core::instance::DataInstance::create_if_missing(root.path(), "berth.db");
        let sidecar = root.path().join(if cfg!(windows) {
            "berth-cli.exe"
        } else {
            "berth-cli"
        });
        let environment = TerminalLaunchEnvironment::from_resolved_paths(
            instance.data_dir(),
            instance.db_file_name(),
            &root.path().join("gui.sock"),
            root.path(),
            root.path(),
            Some(&sidecar),
            None,
        )
        .expect("resolved paths");
        assert_eq!(environment.merge(None).unwrap()["PATH"], "");
        assert!(!sidecar.exists(), "projection must not install a command");
    }

    #[cfg(unix)]
    #[test]
    fn launch_environment_rejects_lossy_instance_paths() {
        use std::os::unix::ffi::OsStringExt;

        let root = tempfile::tempdir().expect("synthetic paths");
        let data = root.path().join(OsString::from_vec(b"data-\xff".to_vec()));
        let instance =
            berth_project_core::instance::DataInstance::create_if_missing(data, "berth.db");
        let result = TerminalLaunchEnvironment::from_resolved_paths(
            instance.data_dir(),
            instance.db_file_name(),
            &root.path().join("gui.sock"),
            root.path(),
            root.path(),
            None,
            None,
        );
        assert!(result.unwrap_err().to_string().contains("BERTH_DATA_DIR"));
    }

    #[test]
    fn launch_environment_missing_caller_values_use_host_defaults() {
        let root = tempfile::tempdir().expect("synthetic paths");
        let instance = berth_project_core::instance::DataInstance::create_if_missing(
            root.path().join("data"),
            "berth.db",
        );
        let command = root
            .path()
            .join(if cfg!(windows) { "berth.exe" } else { "berth" });
        let host = TerminalLaunchEnvironment::from_resolved_paths(
            instance.data_dir(),
            instance.db_file_name(),
            &root.path().join("gui.sock"),
            root.path(),
            root.path(),
            Some(&command),
            None,
        )
        .expect("resolved paths");
        let environment = host.merge(None).expect("explicit defaults");
        assert_eq!(environment["BERTH_DATA_FILE"], "berth.db");
        assert_eq!(
            std::env::split_paths(&environment["PATH"]).collect::<Vec<_>>(),
            [root.path()]
        );
    }

    #[test]
    fn launch_environment_without_cli_alias_keeps_caller_path_and_other_values() {
        let root = tempfile::tempdir().expect("synthetic paths");
        let instance =
            berth_project_core::instance::DataInstance::create_if_missing(root.path(), "berth.db");
        let host = TerminalLaunchEnvironment::from_resolved_paths(
            instance.data_dir(),
            instance.db_file_name(),
            &root.path().join("gui.sock"),
            root.path(),
            root.path(),
            None,
            Some("host-path".to_owned()),
        )
        .expect("resolved paths");
        let environment = host
            .merge(Some(HashMap::from([
                ("PATH".to_owned(), "caller-path".to_owned()),
                ("BERTH_DATA_FILE".to_owned(), "old.db".to_owned()),
                ("KEEP".to_owned(), "exact=value".to_owned()),
            ])))
            .expect("merged environment");
        assert_eq!(environment["PATH"], "caller-path");
        assert_eq!(environment["BERTH_DATA_FILE"], "berth.db");
        assert_eq!(environment["KEEP"], "exact=value");
        assert_eq!(host.merge(None).unwrap()["PATH"], "host-path");
    }

    #[cfg(windows)]
    #[test]
    fn launch_environment_windows_removes_case_aliases_of_host_keys() {
        let root = tempfile::tempdir().expect("synthetic paths");
        let instance =
            berth_project_core::instance::DataInstance::create_if_missing(root.path(), "berth.db");
        let host = TerminalLaunchEnvironment::from_resolved_paths(
            instance.data_dir(),
            instance.db_file_name(),
            &root.path().join("gui.pipe"),
            root.path(),
            root.path(),
            None,
            Some("host-path".to_owned()),
        )
        .expect("resolved paths");
        let environment = host
            .merge(Some(HashMap::from([
                ("Path".to_owned(), "caller-path".to_owned()),
                ("berth_data_file".to_owned(), "old.db".to_owned()),
            ])))
            .expect("merged environment");
        assert_eq!(environment["PATH"], "caller-path");
        assert_eq!(environment["BERTH_DATA_FILE"], "berth.db");
        assert!(!environment.contains_key("Path"));
        assert!(!environment.contains_key("berth_data_file"));
    }

    #[test]
    fn resolve_direct_executable_keeps_absolute_paths() {
        let extra = HashMap::from([("GIT_CONFIG_COUNT".to_owned(), "1".to_owned())]);
        let (command, env) =
            resolve_direct_executable(Some("/usr/bin/env".to_owned()), Some(extra.clone()));
        assert_eq!(command.as_deref(), Some("/usr/bin/env"));
        assert_eq!(env, Some(extra));
    }

    #[test]
    fn resolve_direct_executable_keeps_unknown_bare_names() {
        let (command, env) =
            resolve_direct_executable(Some("berth-missing-agent-binary".to_owned()), None);
        assert_eq!(command.as_deref(), Some("berth-missing-agent-binary"));
        assert!(env.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_direct_executable_resolves_sh_and_prepends_dir() {
        let (command, env) = resolve_direct_executable(Some("sh".to_owned()), None);
        let command = command.expect("sh resolves");
        assert!(
            Path::new(&command).is_absolute(),
            "expected absolute path, got {command}"
        );
        assert_eq!(
            Path::new(&command)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("sh")
        );
        let path = env
            .expect("PATH injected")
            .remove("PATH")
            .expect("PATH value");
        let dir = Path::new(&command).parent().expect("parent");
        let first = std::env::split_paths(&path)
            .next()
            .expect("PATH has a first entry");
        assert_eq!(first, dir);
    }
}
