//! GUI 与 CLI 共用的启动环境投影；路径由宿主解析，不读取项目库或修改 shell 配置。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::{Result, TerminalError};
use berth_term_proto::TerminalError as ProtocolError;

/// 从宿主已解析路径生成的环境，不保存第二份项目或终端归属事实。
#[derive(Debug)]
pub struct TerminalLaunchEnvironment {
    variables: HashMap<String, String>,
    cli_directory: Option<PathBuf>,
}

impl TerminalLaunchEnvironment {
    /// 接收实际库名及路径；cli_command 必须是宿主已解析的真实 berth 命令。
    pub fn from_resolved_paths(
        data_dir: &Path,
        data_file: &str,
        gui_endpoint: &Path,
        terminal_tmpdir: &Path,
        home: &Path,
        cli_command: Option<&Path>,
        path: Option<String>,
    ) -> Result<Self> {
        let mut variables = HashMap::new();
        for (name, value) in [
            ("BERTH_DATA_DIR", data_dir),
            ("BERTH_GUI_ENDPOINT", gui_endpoint),
            ("BERTH_TMPDIR", terminal_tmpdir),
            ("BERTH_HOME", home),
        ] {
            let value = value
                .to_str()
                .filter(|value| !value.contains('\0'))
                .ok_or_else(|| {
                    environment_error(format!(
                        "{name} cannot be encoded as a UTF-8 environment value"
                    ))
                })?;
            variables.insert(name.to_owned(), value.to_owned());
        }
        if data_file.is_empty() || data_file.contains('\0') {
            return Err(environment_error("invalid BERTH_DATA_FILE"));
        }
        // 总是发送实际库名，不能沿用 daemon 或旧 session 的实例值。
        variables.insert("BERTH_DATA_FILE".to_owned(), data_file.to_owned());
        variables.insert("PATH".to_owned(), path.unwrap_or_default());
        let cli_directory = cli_command
            .filter(|command| {
                let name = command.file_name().and_then(|name| name.to_str());
                if cfg!(windows) {
                    name.is_some_and(|name| {
                        name.eq_ignore_ascii_case("berth.exe")
                            || name.eq_ignore_ascii_case("berth.cmd")
                    })
                } else {
                    name == Some("berth")
                }
            })
            .and_then(Path::parent)
            .map(Path::to_path_buf);
        Ok(Self {
            variables,
            cli_directory,
        })
    }

    /// 覆盖宿主保留变量，保留 caller 的其他值及 PATH，再前置实际 CLI 目录。
    pub fn merge(
        &self,
        environment: Option<HashMap<String, String>>,
    ) -> Result<HashMap<String, String>> {
        let mut environment = environment.unwrap_or_default();
        let path = environment
            .get("PATH")
            .or_else(|| {
                environment.iter().find_map(|(key, value)| {
                    (cfg!(windows) && key.eq_ignore_ascii_case("PATH")).then_some(value)
                })
            })
            .or_else(|| self.variables.get("PATH"))
            .cloned()
            .unwrap_or_default();
        let path = if let Some(directory) = self.cli_directory.as_deref() {
            prepend_dir_to_path(directory, (!path.is_empty()).then_some(path.as_str())).ok_or_else(
                || environment_error("terminal PATH cannot include the CLI directory"),
            )?
        } else {
            path
        };
        #[cfg(windows)]
        environment.retain(|key, _| {
            !self
                .variables
                .keys()
                .any(|owned| key.eq_ignore_ascii_case(owned))
        });
        environment.extend(
            self.variables
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
        environment.insert("PATH".to_owned(), path);
        Ok(environment)
    }
}

fn environment_error(message: impl Into<String>) -> TerminalError {
    TerminalError::protocol(ProtocolError::invalid_target(
        "terminal environment",
        message,
    ))
}

/// 前置一个命令目录并移除它的重复项；不丢弃无法无损编码的路径。
pub fn prepend_dir_to_path(dir: &Path, current: Option<&str>) -> Option<String> {
    let mut parts = vec![dir.as_os_str().to_os_string()];
    if let Some(current) = current {
        for item in std::env::split_paths(current) {
            if item != dir {
                parts.push(item.into_os_string());
            }
        }
    }
    std::env::join_paths(parts).ok()?.into_string().ok()
}

/// 两宿主共用的默认 shell 选择；实际执行前仍由宿主校验可执行文件。
pub fn resolve_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "cmd.exe".to_owned())
    }
    #[cfg(not(windows))]
    {
        if let Ok(value) = std::env::var("SHELL") {
            if !value.trim().is_empty() {
                return value;
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if Path::new(candidate).is_file() {
                return candidate.to_owned();
            }
        }
        "/bin/sh".to_owned()
    }
}
