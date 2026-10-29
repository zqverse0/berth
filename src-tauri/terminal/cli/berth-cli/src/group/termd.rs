//! [`berth_group::Terminals`] 的 termd 实现：直接调本 crate 的终端代码，不起子进程。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use berth_control_proto::ProjectScope;
use berth_group::{CreateAgent, Fail, Input, PaneProbe, Terminals};

use crate::workspace_terminal;
use crate::{CliError, EXIT_TARGET_NOT_FOUND};

fn fail(error: CliError) -> Fail {
    if error.exit_code == EXIT_TARGET_NOT_FOUND {
        Fail::Stale
    } else {
        Fail::Unavailable(error.message)
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical(a) == canonical(b)
}

pub(crate) struct Termd {
    socket: PathBuf,
    gui: Option<OsString>,
    runtime: tokio::runtime::Runtime,
}

impl Termd {
    pub(crate) fn new(socket: &Path, gui: Option<OsString>) -> Option<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        Some(Self {
            socket: socket.to_path_buf(),
            gui,
            runtime,
        })
    }

    fn project_ids(&self, roots: &[PathBuf]) -> Result<Vec<(i32, String)>, String> {
        let instance = crate::project::resolve_instance(false).map_err(|error| error.message)?;
        let catalog = self
            .runtime
            .block_on(crate::project::catalog_entries(&instance, ProjectScope::All))
            .map_err(|state| CliError::from_instance(state, false).message)?;
        Ok(catalog
            .into_iter()
            .filter(|entry| roots.iter().any(|root| same_dir(Path::new(&entry.path), root)))
            .map(|entry| (entry.id, entry.path))
            .collect())
    }
}

impl Terminals for Termd {
    fn probe(&self, target_ref: &str) -> Result<PaneProbe, Fail> {
        self.runtime
            .block_on(workspace_terminal::probe(&self.socket, target_ref))
            .map_err(fail)
    }

    fn foreign(&self, target_ref: &str) -> bool {
        workspace_terminal::foreign_target(target_ref)
    }

    fn send(&self, target_ref: &str, input: Input, paste: bool) -> Result<(), Fail> {
        self.runtime
            .block_on(workspace_terminal::send_input(
                &self.socket,
                target_ref,
                input,
                paste,
                false,
            ))
            .map_err(fail)
    }

    fn panes_under(&self, roots: &[PathBuf]) -> Result<Vec<(String, PaneProbe)>, Fail> {
        let ids: Vec<i32> = self
            .project_ids(roots)
            .map_err(Fail::Unavailable)?
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.runtime
            .block_on(workspace_terminal::project_panes(&self.socket, &ids))
            .map_err(fail)
    }

    fn ensure_project(&self, path: &Path) -> Result<i32, String> {
        if let Some((id, _)) = self.project_ids(&[path.to_path_buf()])?.into_iter().next() {
            return Ok(id);
        }
        // GUI 还没对账到新 worktree 时先注册；GUI 不在（无显示的服务器）就直接写库。
        let path = path.to_string_lossy().into_owned();
        let entry = match crate::gui_client::project_ensure(self.gui.as_ref(), path.clone()) {
            Err(error) if error.exit_code == crate::EXIT_GUI_UNAVAILABLE => {
                crate::project::add_entry(&path, false).map_err(|error| error.message)
            }
            result => result.map_err(|error| error.message),
        }
        .map_err(|message| format!("berth project add failed: {message}"))?;
        i32::try_from(entry.id).map_err(|error| error.to_string())
    }

    fn create_agent(&self, request: CreateAgent<'_>) -> Result<String, String> {
        let created = self
            .runtime
            .block_on(workspace_terminal::create_terminal(
                &self.socket,
                self.gui.as_ref(),
                request.project_id,
                Some((request.agent.to_owned(), request.inputs)),
                request.provider_id,
                request.model_id,
                Some(request.cwd),
                false,
            ))
            .map_err(|error| error.message)?;
        created["target_ref"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "terminal create returned no target_ref".to_owned())
    }
}
