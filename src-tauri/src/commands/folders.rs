use std::path::PathBuf;

use crate::app_error::AppCommandError;
use crate::commands::git::{git_command_error, parse_worktrees, WorktreeResolution};
use crate::db::AppDatabase;
use crate::event_bridge::EventEmitter;
use crate::git::repo::ensure_git_repo;
use crate::models::{FolderDetail, FolderHistoryEntry};
use berth_project_core::error::DbError;
use berth_project_core::service::folder::ProjectMember;
use berth_project_core::service::folder_service;
use sea_orm::TransactionTrait;

// ---------------------------------------------------------------------------

pub async fn get_folder_core(db: &AppDatabase, folder_id: i32) -> Result<FolderDetail, DbError> {
    folder_service::get_folder_by_id(&db.conn, folder_id)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Folder {} not found", folder_id)))
}

/// Emit a `folder://changed` Upsert so every client inserts-or-replaces the
/// folder in its workspace list in real time. Used by headless producers — the
/// automation engine minting a per-run worktree — whose folders no client would
/// otherwise learn about until the next full `fetchFolders` (leaving any
/// conversation produced inside them unplaceable in the sidebar). Best-effort:
/// the folder is already persisted, so a dropped event reconciles on the next
/// refresh / WS reconnect.
///
/// Unlike [`open_folder_in_workspace_core`], this ONLY syncs the folder list — it
/// never opens or focuses a tab — so a background emitter can't steal focus.
pub(crate) fn emit_folder_upsert(emitter: &EventEmitter, detail: FolderDetail) {
    crate::event_bridge::emit_event(
        emitter,
        crate::event_bridge::FOLDER_CHANGED_EVENT,
        crate::event_bridge::FolderChange::Upsert {
            folder: Box::new(detail),
        },
    );
}

pub async fn load_folder_history_core(
    db: &AppDatabase,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    // 列表只暴露仍存在的目录；历史记录保留，不改数据库。
    folder_service::list_folders(&db.conn)
        .await
        .map(|rows| {
            rows.into_iter()
                .filter(|row| PathBuf::from(&row.path).is_dir())
                .collect()
        })
        .map_err(AppCommandError::from)
}

pub async fn add_folder_to_history_core(
    db: &AppDatabase,
    path: String,
) -> Result<FolderHistoryEntry, DbError> {
    folder_service::add_folder(&db.conn, &path).await
}

pub async fn remove_folder_from_history_core(
    db: &AppDatabase,
    path: String,
) -> Result<(), AppCommandError> {
    folder_service::remove_folder(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_open_folders_core(
    db: &AppDatabase,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    // 列表只暴露仍存在的目录；历史记录保留，不改数据库。
    folder_service::list_open_folders(&db.conn)
        .await
        .map(|rows| {
            rows.into_iter()
                .filter(|row| PathBuf::from(&row.path).is_dir())
                .collect()
        })
        .map_err(AppCommandError::from)
}

pub async fn list_open_folder_details_core(
    db: &AppDatabase,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    folder_service::list_open_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_all_folder_details_core(
    db: &AppDatabase,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    // 列表只暴露仍存在的目录；历史记录保留，不改数据库。
    folder_service::list_all_folder_details(&db.conn)
        .await
        .map(|rows| {
            rows.into_iter()
                .filter(|row| PathBuf::from(&row.path).is_dir())
                .collect()
        })
        .map_err(AppCommandError::from)
}

/// 打开一个目录为 folder。若是 git 仓库则确保其 worktree 家族完整：
/// 该目录是 linked worktree（`.git` 为文件）时，按 `git worktree list`
/// 登记主工作树（root）与全部 worktree，并把选中目录挂到 root 下。
pub async fn open_folder_core(
    db: &AppDatabase,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    // 与无 GUI 时的 `berth project add` 同一实现（worktree 家族登记）。
    folder_service::open_project(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)
}

/// 项目成员列表（侧栏展开、当前项目的 worktree 指纹变化时现读）：群组 worktree 的登记与失效 / 临时标记
/// 在 `folder_service::discover_members`（git 新出现的检出不登记），这里只补一件宿主侧的事——想法、知识库只在主项目有一份，
/// 其他仍在的 checkout 去掉副本（没有副本时只是两次 stat）。项目不存在时返回空。
pub async fn list_project_members_core(
    db: &AppDatabase,
    project_id: i32,
) -> Result<Vec<ProjectMember>, AppCommandError> {
    let members = folder_service::discover_members(&db.conn, project_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(members)
}

/// 把刚建好的 git worktree 目录登记为来源 folder 所属项目的成员。来源未知 / 非正数 /
/// 不属于项目时退化为自成一个项目，不报错。
pub async fn open_worktree_folder_core(
    db: &AppDatabase,
    path: String,
    source_folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    let project_id = if source_folder_id > 0 {
        folder_service::get_folder_by_id(&db.conn, source_folder_id)
            .await
            .map_err(AppCommandError::from)?
            .and_then(|src| src.project_id)
    } else {
        None
    };
    let entry = match project_id {
        Some(project_id) => {
            folder_service::add_folder_to_project(&db.conn, &path, project_id).await
        }
        None => folder_service::add_folder(&db.conn, &path).await,
    }
    .map_err(AppCommandError::from)?;
    folder_service::get_folder_by_id(&db.conn, entry.id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found after add"))
}

/// Open a folder into the workspace and announce it so the workspace window
/// can surface it. Used by the project launcher, which lives in its own
/// window/tab and can't reach the workspace's React state directly. Emitting
/// through the shared `EventEmitter` routes the signal correctly in every
/// runtime — Tauri events (desktop), the WebSocket broadcaster (server), and
/// the remote server's broadcaster (remote desktop) — so only windows talking
/// to this same backend react.
pub async fn open_folder_in_workspace_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let detail = open_folder_core(db, path).await?;
    crate::event_bridge::emit_event(emitter, "folder://open-in-workspace", &detail);
    Ok(detail)
}

pub async fn open_folder_by_id_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("Folder {folder_id} not found")))
}

pub async fn remove_folder_from_workspace_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
    terminal_manager: Option<&crate::terminal::manager::TerminalSessionManager>,
) -> Result<(), AppCommandError> {
    use crate::db::service::tab_service;

    // Capture the folder path before flipping it closed, so we can stop any
    // office watch preview servers rooted under it — belt-and-suspenders over
    // the frontend's per-tab unmount teardown.
    let folder = folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("Folder {folder_id} not found")))?;
    let is_main = folder.is_main();
    let source_path = folder.path;

    // 移除主成员 = 移除整个项目：先移除其余成员，否则主成员会改指到它们、项目仍留在列表。
    // 只从列表移除，不动磁盘上的 worktree。
    if let Some(project_id) = folder.project_id.filter(|_| is_main) {
        let children = folder_service::list_project_members(&db.conn, project_id)
            .await
            .map_err(AppCommandError::from)?
            .into_iter()
            .filter(|f| f.id != folder_id);
        for child in children {
            Box::pin(remove_folder_from_workspace_core(
                emitter,
                db,
                child.id,
                terminal_manager,
            ))
            .await?;
        }
    }

    // Folder removal is an explicit terminal lifecycle boundary. Stop and
    // remove every associated PTY before deleting its primary tabs so a failed
    // termination cannot silently leave a hidden process behind.
    if let Some(manager) = terminal_manager {
        manager
            .terminate_and_remove_folder(folder_id)
            .await
            .map_err(AppCommandError::from)?;
    }

    // Delete every primary tab owned by this folder and bump the version as a
    // CAS barrier against concurrent stale saves.
    let inv = tab_service::delete_folder_tabs_and_bump(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    if let Some(tabs) = inv.emit {
        crate::event_bridge::emit_event(
            emitter,
            crate::event_bridge::TABS_CHANGED_EVENT,
            crate::event_bridge::TabsChanged {
                version: inv.version,
                origin: "server".to_string(),
                tabs,
            },
        );
        if let Some(primary_tabs) = inv.primary_emit {
            crate::commands::primary_tabs::emit_primary_tabs_changed(
                emitter,
                inv.version,
                primary_tabs,
                "server".to_string(),
            );
        }
    }

    let txn = db
        .conn
        .begin()
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::from)?;
    crate::sessions::forget_project_index(&txn, &source_path)
        .await
        .map_err(AppCommandError::from)?;
    folder_service::forget_folder(&txn, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    txn.commit()
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::from)?;

    crate::preview_watch::stop_preview_watches_under_root(&source_path);
    Ok(())
}

/// 非主成员所属项目的主成员（worktree 的 git 命令在那里跑）；主成员或不属于项目时为 `None`。
fn main_of(folder: &FolderDetail) -> Option<i32> {
    folder
        .project
        .as_ref()
        .map(|project| project.main_folder_id)
        .filter(|&main| main != folder.id)
}

/// 删除 worktree 目录（分支保留）。有未提交改动时拒绝，除非 `force`（用户已在确认框里同意丢弃）。
async fn remove_worktree_directory_core(
    db: &AppDatabase,
    terminal_manager: &crate::terminal::manager::TerminalSessionManager,
    folder_id: i32,
    force: bool,
) -> Result<(), AppCommandError> {
    let folder = get_folder_core(db, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    // git 命令在主成员里跑；主成员自己不能删。
    let parent_id = main_of(&folder).ok_or_else(|| {
        AppCommandError::invalid_input("Only a registered worktree can be deleted")
    })?;
    let parent = get_folder_core(db, parent_id)
        .await
        .map_err(AppCommandError::from)?;

    // 失效成员（目录已不在，或已不是 git 检出）：只清掉 git 里的登记，不碰磁盘；
    // 否则下次列成员又会登记回来。
    if !std::path::Path::new(&folder.path).join(".git").exists() {
        let output = crate::platform::process::tokio_command("git")
            .args(["worktree", "prune"])
            .current_dir(&parent.path)
            .output()
            .await
            .map_err(AppCommandError::io)?;
        if !output.status.success() {
            return Err(git_command_error("worktree prune", &output.stderr));
        }
        return Ok(());
    }

    let status = crate::platform::process::tokio_command("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(&folder.path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !status.status.success() {
        return Err(git_command_error("status", &status.stderr));
    }
    if !force && !status.stdout.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Worktree has uncommitted changes and cannot be deleted",
        ));
    }

    terminal_manager
        .terminate_and_remove_folder(folder_id)
        .await
        .map_err(AppCommandError::from)?;

    let mut remove = crate::platform::process::tokio_command("git");
    remove.args(["worktree", "remove"]);
    if force {
        remove.arg("--force");
    }
    let output = remove
        .arg("--")
        .arg(&folder.path)
        .current_dir(&parent.path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !output.status.success() {
        return Err(git_command_error("worktree remove", &output.stderr));
    }
    Ok(())
}

async fn git_in(dir: &std::path::Path, args: &[&str]) -> Result<String, AppCommandError> {
    let output = crate::platform::process::tokio_command("git")
        .args(args)
        .current_dir(dir)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !output.status.success() {
        return Err(git_command_error(&args.join(" "), &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// 重命名 worktree：目录与当前分支一起改名（`git branch -m` + `git worktree move`），保留项目 id，
/// 同步 Berth 群环境（群按目录路径认）。目录里还有终端在跑时拒绝，由用户先关掉。
pub async fn rename_worktree_core(
    db: &AppDatabase,
    terminal_manager: &crate::terminal::manager::TerminalSessionManager,
    folder_id: i32,
    name: &str,
) -> Result<FolderDetail, AppCommandError> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid name: {name}"
        )));
    }
    let folder = get_folder_core(db, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    let parent_id = main_of(&folder).ok_or_else(|| {
        AppCommandError::invalid_input("Only a registered worktree can be renamed")
    })?;
    let parent = get_folder_core(db, parent_id)
        .await
        .map_err(AppCommandError::from)?;
    let from = PathBuf::from(&folder.path);
    let to = from
        .parent()
        .ok_or_else(|| AppCommandError::invalid_input("Worktree has no parent directory"))?
        .join(name);
    if to != from && to.exists() {
        return Err(AppCommandError::invalid_input(format!(
            "{} already exists",
            to.display()
        )));
    }
    let running: Vec<String> = terminal_manager
        .sessions_started_under(&from)
        .into_iter()
        .filter(|t| t.status == crate::terminal::protocol::TerminalStatus::Running)
        .map(|t| t.title)
        .collect();
    if !running.is_empty() {
        return Err(AppCommandError::invalid_input(format!(
            "Close the terminals running in this worktree first: {}",
            running.join(", ")
        )));
    }

    // 分离 HEAD 没有分支可改，只改目录。
    let old_branch = Some(git_in(&from, &["rev-parse", "--abbrev-ref", "HEAD"]).await?)
        .filter(|branch| branch != "HEAD");
    let renamed_branch = old_branch.as_deref().filter(|old| *old != name);
    if let Some(old) = renamed_branch {
        git_in(&from, &["branch", "-m", old, name]).await?;
    }
    if to != from {
        let moved = git_in(
            std::path::Path::new(&parent.path),
            &["worktree", "move", &folder.path, &to.to_string_lossy()],
        )
        .await;
        if let Err(error) = moved {
            if let Some(old) = renamed_branch {
                // 目录没搬成：分支改回去，不留半截状态。
                let _ = git_in(&from, &["branch", "-m", name, old]).await;
            }
            return Err(error);
        }
    }

    let new_branch = renamed_branch
        .map(|_| name.to_owned())
        .or(old_branch.clone());
    let detail =
        folder_service::update_folder_path(&db.conn, folder_id, &to.to_string_lossy(), new_branch)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| AppCommandError::not_found("Folder not found"))?;

    // 群环境跟着走；目录已经改好，这一步失败只记日志，下次对账会把新目录当新群。
    if let Ok(berth_project_core::tasks::Scope { main, .. }) =
        berth_project_core::tasks::resolve(&to)
    {
        let branch = renamed_branch.map(|old| (old, name));
        if let Err(error) =
            berth_project_core::tasks::group::move_checkout(&main, &from, &to, branch)
        {
            tracing::warn!("rename worktree: group env not updated: {}", error.message);
        }
    }
    Ok(detail)
}

pub async fn reorder_folders_core(db: &AppDatabase, ids: Vec<i32>) -> Result<(), AppCommandError> {
    folder_service::reorder_folders(&db.conn, ids)
        .await
        .map_err(AppCommandError::from)
}

pub async fn update_folder_alias_core(
    db: &AppDatabase,
    folder_id: i32,
    alias: Option<String>,
    update_alias: Option<bool>,
    pinned: Option<bool>,
) -> Result<FolderDetail, AppCommandError> {
    // Empty / whitespace-only input clears the alias (stored as NULL).
    let normalized = alias
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    folder_service::update_folder_alias(
        &db.conn,
        folder_id,
        normalized,
        update_alias.unwrap_or(true),
        pinned,
    )
    .await
    .map_err(AppCommandError::from)?
    .ok_or_else(|| AppCommandError::not_found("Folder not found"))
}

pub async fn update_folder_default_agent_core(
    db: &AppDatabase,
    folder_id: i32,
    default_agent_type: Option<crate::models::agent::AgentType>,
) -> Result<FolderDetail, AppCommandError> {
    folder_service::update_folder_default_agent(&db.conn, folder_id, default_agent_type)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))
}

// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_folder(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<FolderDetail, DbError> {
    get_folder_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn load_folder_history(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    load_folder_history_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remove_folder_from_history(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<(), AppCommandError> {
    remove_folder_from_history_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_open_folder_details(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    list_open_folder_details_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_all_folder_details(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    list_all_folder_details_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    open_folder_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_worktree_folder(
    db: tauri::State<'_, AppDatabase>,
    path: String,
    source_folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    open_worktree_folder_core(&db, path, source_folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder_in_workspace<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let emitter = EventEmitter::tauri(app);
    open_folder_in_workspace_core(&emitter, &db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder_by_id(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    open_folder_by_id_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remove_folder_from_workspace<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, crate::terminal::manager::TerminalManager>,
    folder_id: i32,
    delete_worktree: Option<bool>,
    force: Option<bool>,
) -> Result<(), AppCommandError> {
    if delete_worktree.unwrap_or(false) {
        remove_worktree_directory_core(&db, &manager, folder_id, force.unwrap_or(false)).await?;
    }
    remove_folder_from_workspace_core(&EventEmitter::tauri(app), &db, folder_id, Some(&manager))
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn rename_worktree(
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, crate::terminal::manager::TerminalManager>,
    folder_id: i32,
    name: String,
) -> Result<FolderDetail, AppCommandError> {
    rename_worktree_core(&db, &manager, folder_id, &name).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_project_members(
    db: tauri::State<'_, AppDatabase>,
    project_id: i32,
) -> Result<Vec<ProjectMember>, AppCommandError> {
    list_project_members_core(&db, project_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn reorder_folders(
    db: tauri::State<'_, AppDatabase>,
    ids: Vec<i32>,
) -> Result<(), AppCommandError> {
    reorder_folders_core(&db, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_alias(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    alias: Option<String>,
    update_alias: Option<bool>,
    pinned: Option<bool>,
) -> Result<FolderDetail, AppCommandError> {
    update_folder_alias_core(&db, folder_id, alias, update_alias, pinned).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_default_agent(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    default_agent_type: Option<crate::models::agent::AgentType>,
) -> Result<FolderDetail, AppCommandError> {
    update_folder_default_agent_core(&db, folder_id, default_agent_type).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_folder_directory(path: String) -> Result<(), AppCommandError> {
    std::fs::create_dir_all(&path).map_err(AppCommandError::io)
}

/// Resolve where `branch` is checked out and which registered folder owns that
/// directory. Canonicalizes both the worktree path (from git) and every folder
/// path (from the DB) so symlinked / non-canonical paths still match — this
/// can only be done on the host that runs git, which is why it lives in the
/// backend rather than the webview.
pub async fn resolve_worktree_folder_core(
    db: &AppDatabase,
    repo_path: String,
    branch: String,
) -> Result<WorktreeResolution, AppCommandError> {
    ensure_git_repo(&repo_path)?;

    let output = crate::platform::process::tokio_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !output.status.success() {
        return Err(git_command_error("worktree list", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let wt_path = parse_worktrees(&stdout)
        .into_iter()
        .find(|(_, b)| b.as_deref() == Some(branch.as_str()))
        .map(|(p, _)| p);

    let Some(wt_path) = wt_path else {
        // Branch is not checked out in any worktree → caller checks it out in root.
        return Ok(WorktreeResolution {
            path: None,
            folder_id: None,
        });
    };

    let canonical_wt = std::fs::canonicalize(&wt_path).unwrap_or_else(|_| PathBuf::from(&wt_path));

    let same = |path: &str| {
        std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)) == canonical_wt
    };
    let folders = folder_service::list_all_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    let mut folder_id = folders.into_iter().find(|f| same(&f.path)).map(|f| f.id);
    // 还没登记的 worktree（群组 / 任务刚建的）：登记进仓库所在的项目。
    if folder_id.is_none() && canonical_wt.is_dir() {
        if let Some(project) =
            folder_service::project_for_dir(&db.conn, std::path::Path::new(&repo_path))
                .await
                .map_err(AppCommandError::from)?
        {
            let entry = folder_service::add_folder_to_project(
                &db.conn,
                &canonical_wt.to_string_lossy(),
                project.id,
            )
            .await
            .map_err(AppCommandError::from)?;
            folder_id = Some(entry.id);
        }
    }

    Ok(WorktreeResolution {
        path: Some(canonical_wt.to_string_lossy().to_string()),
        folder_id,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn resolve_worktree_folder(
    db: tauri::State<'_, AppDatabase>,
    repo_path: String,
    branch: String,
) -> Result<WorktreeResolution, AppCommandError> {
    resolve_worktree_folder_core(&db, repo_path, branch).await
}

/// Accumulates a commit's file changes, merging the `--raw` (status) and
/// `--numstat` (+/-) lines that describe the same path. Shared by git_log's
/// per-commit builder and the standalone git_commit_files command.
#[cfg(test)]
mod tests {

    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::agent::AgentType;

    #[tokio::test]
    async fn forget_project_preserves_disk_files_and_readd_identity() {
        let db = fresh_in_memory_db().await;
        let project = tempfile::tempdir().expect("project dir");
        let file_path = project.path().join("SKILL.md");
        std::fs::write(&file_path, "# keep this file\n").expect("write fixture");
        let path = project.path().to_string_lossy().into_owned();
        let old = folder_service::add_folder(&db.conn, &path)
            .await
            .expect("add project");
        let before = std::fs::read(&file_path).expect("read before removal");

        remove_folder_from_workspace_core(&EventEmitter::Noop, &db, old.id, None)
            .await
            .expect("forget project");

        assert_eq!(
            std::fs::read(&file_path).expect("read after removal"),
            before
        );
        let new = folder_service::add_folder(&db.conn, &path)
            .await
            .expect("re-add project");
        assert_ne!(new.id, old.id);
    }

    #[tokio::test]
    async fn removing_root_forgets_its_worktree_family() {
        let db = fresh_in_memory_db().await;
        let root = folder_service::add_folder(&db.conn, "/tmp/berth-family-root")
            .await
            .expect("add root");
        open_worktree_folder_core(&db, "/tmp/berth-family-wt".into(), root.id)
            .await
            .expect("add worktree");

        remove_folder_from_workspace_core(&EventEmitter::Noop, &db, root.id, None)
            .await
            .expect("remove root");

        let rows = folder_service::list_all_folder_details(&db.conn)
            .await
            .expect("list");
        assert!(
            rows.is_empty(),
            "worktree must not survive as an orphan: {rows:?}"
        );
    }

    #[test]
    fn emit_folder_upsert_broadcasts_on_folder_channel() {
        // A headlessly-created folder must reach every client on
        // `folder://changed` carrying its full detail, so the sidebar can place a
        // conversation produced inside it without a re-fetch.
        use crate::event_bridge::{TestEventBus, FOLDER_CHANGED_EVENT};
        use berth_project_core::entities::folder::FolderKind;
        use std::sync::Arc;

        let broadcaster = Arc::new(TestEventBus::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_with_bus(broadcaster.clone());

        emit_folder_upsert(
            &emitter,
            FolderDetail {
                id: 7,
                project_runtime_id: "4eef9c5a-72e7-4b88-a6dd-7f0e9bd2a710".to_string(),
                name: "repo-automation-3-run-9".to_string(),
                path: "/home/me/repo-automation-3-run-9".to_string(),
                git_branch: Some("automation/3/run-9".to_string()),
                default_agent_type: None,
                last_opened_at: chrono::Utc::now(),
                project_id: Some(1),
                project: None,
                kind: FolderKind::Regular,
            },
        );

        let evt = rx.try_recv().expect("folder upsert should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, FOLDER_CHANGED_EVENT);
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["folder"]["id"], 7);
        assert_eq!(p["folder"]["project_id"], 1);
        assert!(p["folder"].get("project_runtime_id").is_none());
    }

    #[tokio::test]
    async fn add_folder_to_history_core_derives_name_from_path() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-test-project".into())
            .await
            .expect("add folder");
        assert_eq!(entry.name, "codeg-test-project");
        assert_eq!(entry.path, "/tmp/codeg-test-project");
    }

    #[tokio::test]
    async fn update_folder_alias_core_can_pin_without_clearing_alias() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-pin-folder".into())
            .await
            .expect("add folder");
        let pinned =
            update_folder_alias_core(&db, entry.id, Some("alias".into()), Some(true), Some(true))
                .await
                .expect("pin folder");
        let project = pinned.project.expect("project");
        assert_eq!(project.name, "alias");
        assert!(project.pinned_at.is_some(), "pin must stamp pinned_at");

        let unpinned = update_folder_alias_core(
            &db,
            entry.id,
            Some("stale alias".into()),
            Some(false),
            Some(false),
        )
        .await
        .expect("unpin folder");
        let project = unpinned.project.expect("project");
        assert_eq!(
            project.name, "alias",
            "pin updates must preserve the current name"
        );
        assert!(project.pinned_at.is_none(), "unpin must clear pinned_at");
    }

    #[tokio::test]
    async fn add_folder_to_history_core_upserts_on_duplicate_path() {
        let db = fresh_in_memory_db().await;
        // 历史列表只返回仍存在的目录，所以用真实的临时目录。
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().to_string_lossy().into_owned();
        let first = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 1st");
        let second = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 2nd");
        assert_eq!(first.id, second.id, "duplicate path must reuse id");

        let history = load_folder_history_core(&db).await.expect("history");
        // 比返回的 path：服务端会规范化路径，macOS 上 /var 是 /private/var 的软链。
        assert_eq!(
            history.iter().filter(|f| f.path == first.path).count(),
            1,
            "no duplicate rows for same path"
        );
    }

    #[tokio::test]
    async fn remove_folder_from_history_core_soft_deletes() {
        let db = fresh_in_memory_db().await;
        let path = "/tmp/codeg-remove-test".to_string();
        add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add");
        remove_folder_from_history_core(&db, path.clone())
            .await
            .expect("remove");
        let history = load_folder_history_core(&db).await.expect("history");
        assert!(
            history.iter().all(|f| f.path != path),
            "soft-deleted folder must not appear in list"
        );
    }

    #[tokio::test]
    async fn open_folder_by_id_core_errors_when_missing() {
        let db = fresh_in_memory_db().await;
        let err = open_folder_by_id_core(&db, 99_999)
            .await
            .expect_err("missing id should error");
        // Either the not_found wrapper or the underlying DbError propagates —
        // both are acceptable for "missing".
        let msg = format!("{err:?}");
        assert!(
            msg.to_lowercase().contains("not found") || msg.to_lowercase().contains("99999"),
            "expected not-found-ish error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn opening_any_worktree_registers_one_fixed_family() {
        let db = fresh_in_memory_db().await;
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("main");
        let linked = temp.path().join("feature");
        std::fs::create_dir(&root).expect("create root");

        let run_git = |cwd: &std::path::Path, args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&root, &["init", "-b", "main"]);
        std::fs::write(root.join("README.md"), "test").expect("write fixture");
        run_git(&root, &["add", "README.md"]);
        run_git(
            &root,
            &[
                "-c",
                "user.name=Berth Test",
                "-c",
                "user.email=test@berth.invalid",
                "commit",
                "-m",
                "init",
            ],
        );
        run_git(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                linked.to_str().expect("utf8 path"),
            ],
        );

        let selected = open_folder_core(&db, linked.to_string_lossy().into_owned())
            .await
            .expect("open linked worktree");
        let folders = list_open_folder_details_core(&db)
            .await
            .expect("list family");
        assert_eq!(folders.len(), 2);
        let root_folder = folders
            .iter()
            .find(|folder| folder.is_main())
            .expect("root folder");
        assert_eq!(main_of(&selected), Some(root_folder.id));
        assert_eq!(
            std::fs::canonicalize(&root_folder.path).expect("canonical root"),
            std::fs::canonicalize(&root).expect("fixture root")
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_records_parent_as_root() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-root".into())
            .await
            .expect("open root");
        assert_eq!(main_of(&root), None, "root folder has no parent");

        let wt = open_worktree_folder_core(&db, "/tmp/codeg-wt-a".into(), root.id)
            .await
            .expect("open worktree");
        assert_eq!(
            main_of(&wt),
            Some(root.id),
            "worktree records its source root folder"
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_flattens_nested_worktrees() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-flat-root".into())
            .await
            .expect("open root");
        let child = open_worktree_folder_core(&db, "/tmp/codeg-wt-flat-1".into(), root.id)
            .await
            .expect("open child worktree");
        // A worktree created *from* the child must still point at the root, not
        // the intermediate child.
        let grandchild = open_worktree_folder_core(&db, "/tmp/codeg-wt-flat-2".into(), child.id)
            .await
            .expect("open grandchild worktree");
        assert_eq!(main_of(&child), Some(root.id));
        assert_eq!(
            main_of(&grandchild),
            Some(root.id),
            "worktree of a worktree flattens to the original root"
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_unknown_source_is_root() {
        let db = fresh_in_memory_db().await;
        let wt = open_worktree_folder_core(&db, "/tmp/codeg-wt-orphan".into(), 0)
            .await
            .expect("open worktree with no source");
        assert_eq!(
            main_of(&wt),
            None,
            "non-positive / unknown source degrades to a top-level folder"
        );
    }

    #[tokio::test]
    async fn open_folder_core_preserves_existing_worktree_parent() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-preserve-root".into())
            .await
            .expect("open root");
        let wt = open_worktree_folder_core(&db, "/tmp/codeg-wt-preserve".into(), root.id)
            .await
            .expect("open worktree");
        assert_eq!(main_of(&wt), Some(root.id));
        // A plain reopen of the same path must not clear the recorded parent.
        let reopened = open_folder_core(&db, "/tmp/codeg-wt-preserve".into())
            .await
            .expect("reopen plain");
        assert_eq!(
            main_of(&reopened),
            Some(root.id),
            "plain open_folder must preserve an existing worktree parent"
        );
    }

    #[tokio::test]
    async fn update_folder_default_agent_core_set_then_clear() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-agent-test".into())
            .await
            .expect("add");
        let set =
            update_folder_default_agent_core(&db, entry.id, Some(AgentType::new("claude_code")))
                .await
                .expect("set agent");
        assert_eq!(set.default_agent_type, Some(AgentType::new("claude_code")));
        let cleared = update_folder_default_agent_core(&db, entry.id, None)
            .await
            .expect("clear agent");
        assert_eq!(cleared.default_agent_type, None);
    }
}
