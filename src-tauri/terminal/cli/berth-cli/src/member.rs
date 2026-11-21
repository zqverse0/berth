//! `berth project <项目> member ls|add|rm`：项目成员。代码成员（main 与各 worktree）来自 git，
//! 由 GUI 列成员时登记；`add` / `rm` 只管参考成员。`ls` 只读，与 launch.js 的 `ctx.project` 同一份视图。

use std::path::{Path, PathBuf};

use berth_project_core::service::folder::{ProjectView, RunningAgent};
use clap::Subcommand;

use crate::{CliError, EXIT_TARGET_NOT_FOUND};

#[derive(Debug, Clone, Subcommand)]
pub(crate) enum MemberCommand {
    /// 列出成员：每个检出的路径、分支、在跑的 Agent，以及参考目录（只读）。
    Ls {
        /// 输出一个机器可读的 JSON 对象（与 launch.js 的 `ctx.project` 相同）。
        #[arg(long)]
        json: bool,
    },
    /// 加入参考目录（参考项目、资料）；同一目录可进多个项目。
    Add {
        path: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// 移除参考目录（不动磁盘上的文件）。
    Rm {
        path: PathBuf,
        #[arg(long)]
        json: bool,
    },
}

fn runtime() -> Result<tokio::runtime::Runtime, CliError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)
}

fn not_in_project(dir: &Path) -> CliError {
    CliError {
        exit_code: EXIT_TARGET_NOT_FOUND,
        message: format!(
            "{} is not inside a registered project; see `berth project ls`",
            dir.display()
        ),
        json_message: None,
    }
}

/// `dir` 所在项目的视图，检出带在跑的 Agent（按终端启动目录归到最深的检出）。
/// 终端服务不可达时没有 Agent 信息，不报错。
pub(crate) async fn view_at(
    dir: &Path,
    socket: Option<&Path>,
) -> Result<Option<ProjectView>, CliError> {
    let instance = crate::project::resolve_instance(false)?;
    let Some(mut view) = crate::project::project_view_at(&instance, dir)
        .await
        .map_err(|state| CliError::from_instance(state, false))?
    else {
        return Ok(None);
    };
    let terminals = match socket {
        Some(socket) => crate::workspace_terminal::list_entries(&instance, socket, None, false)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    for terminal in &terminals {
        let Some((agent, handle, cwd)) = terminal.running_agent() else {
            continue;
        };
        let cwd = Path::new(cwd);
        if let Some(checkout) = view
            .checkouts
            .iter_mut()
            .filter(|checkout| cwd.starts_with(&checkout.path))
            .max_by_key(|checkout| checkout.path.len())
        {
            checkout.agents.push(RunningAgent {
                agent: agent.to_owned(),
                terminal: handle,
            });
        }
    }
    Ok(Some(view))
}

/// launch.js 的 `ctx.project`：当前目录所在项目的视图；不在项目里或读不到时为 null，不挡启动。
pub(crate) fn current_view_json() -> serde_json::Value {
    let lookup = || -> Option<serde_json::Value> {
        let dir = std::env::current_dir().ok()?;
        let socket = berth_term_ipc::resolve_endpoint(None, None)
            .ok()
            .map(berth_term_ipc::LocalEndpoint::into_path)
            .filter(|path| path.exists());
        let view = runtime()
            .ok()?
            .block_on(view_at(&dir, socket.as_deref()))
            .ok()??;
        serde_json::to_value(view).ok()
    };
    lookup().unwrap_or(serde_json::Value::Null)
}

pub(crate) fn run(command: MemberCommand, socket: Option<&Path>) -> Result<(), CliError> {
    let dir = std::env::current_dir().map_err(CliError::from_runtime)?;
    match command {
        MemberCommand::Ls { json } => {
            let view = runtime()?
                .block_on(view_at(&dir, socket))?
                .ok_or_else(|| not_in_project(&dir))?;
            print_view(&view, json);
            Ok(())
        }
        MemberCommand::Add { path, json } => edit(&dir, path, true, json),
        MemberCommand::Rm { path, json } => edit(&dir, path, false, json),
    }
}

fn edit(dir: &Path, path: PathBuf, add: bool, json: bool) -> Result<(), CliError> {
    let path = dir.join(path);
    if add && !path.is_dir() {
        return Err(CliError::not_found(format!(
            "{} is not an existing directory",
            path.display()
        )));
    }
    let instance = crate::project::writable_instance()
        .map_err(|state| CliError::from_instance(state, json))?;
    let (project, changed) = runtime()?
        .block_on(crate::project::edit_reference(
            &instance,
            dir,
            &path.to_string_lossy(),
            add,
        ))
        .map_err(|state| CliError::from_instance(state, json))?
        .ok_or_else(|| not_in_project(dir))?;
    if json {
        println!(
            "{}",
            serde_json::json!({ "project": project, "path": path, "changed": changed })
        );
    } else {
        let verb = match (add, changed) {
            (true, true) => "已加入",
            (true, false) => "已在",
            (false, true) => "已移除",
            (false, false) => "不在",
        };
        println!("{verb}项目 {project} 的参考目录：{}", path.display());
    }
    Ok(())
}

fn print_view(view: &ProjectView, json: bool) {
    if json {
        match serde_json::to_string(view) {
            Ok(encoded) => println!("{encoded}"),
            Err(error) => eprintln!("berth: failed to encode project JSON: {error}"),
        }
        return;
    }
    println!("项目 {}（主成员 {}）", view.name, view.home);
    println!("检出：");
    for checkout in &view.checkouts {
        let mut notes = Vec::new();
        if checkout.main {
            notes.push("主成员".to_owned());
        }
        if checkout.stale {
            notes.push("失效".to_owned());
        }
        if checkout.temporary {
            notes.push("临时".to_owned());
        }
        notes.extend(
            checkout
                .agents
                .iter()
                .map(|agent| format!("{} 在跑（{}）", agent.agent, agent.terminal)),
        );
        println!(
            "  {}  ⎇ {}{}",
            checkout.path,
            checkout.branch.as_deref().unwrap_or("-"),
            if notes.is_empty() {
                String::new()
            } else {
                format!("  {}", notes.join("，"))
            }
        );
    }
    if view.references.is_empty() {
        println!("参考目录：无（`berth project . member add <目录>` 加入）");
    } else {
        println!("参考目录（只读）：");
        for reference in &view.references {
            println!("  {}", reference.path);
        }
    }
}
