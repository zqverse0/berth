use std::path::PathBuf;

use crate::app_error::AppCommandError;
use crate::commands::git::{git_command_error, parse_worktrees, WorktreeResolution};
use crate::db::AppDatabase;
use crate::event_bridge::EventEmitter;
use crate::git::repo::{ensure_git_repo, is_git_repo};
use crate::models::{FolderDetail, FolderHistoryEntry};
use berth_project_core::error::DbError;
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
    // 列表只暴露仍存在的目录；历史记录保留，不改数据库。
    folder_service::list_open_folder_details(&db.conn)
        .await
        .map(|rows| {
            rows.into_iter()
                .filter(|row| PathBuf::from(&row.path).is_dir())
                .collect()
        })
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

/// 以 folder 所属 worktree 家族为单位，与 `git worktree list` 对账：
///
/// - git 现存、DB 家族缺失的 worktree → 登记为 root 的子 folder
///   （`add_folder_with_parent` upsert，重开旧记录也刷新 parent）。
/// - git 已无（含 prunable）的 DB 家族成员 → 移除：走完整删除（关 tabs / PTY）。
///   worktree 成员以 git 为唯一事实，目录是否仍在不影响判定。
///
/// `emitter` / `terminal_manager` 为 `None`（纯 core / 测试）时删除降级为
/// 软删 + 关 open，不做 tab/PTY 清理。
///
/// 返回对账后的家族详情（root + 全部 worktree，含刚登记或移除后仍在的）。
/// 对账是幂等的：git 侧无变化时重复调用不改 DB。
///
/// 宽容语义（对账是辅助能力，绝不因前置状态炸 UI / console）：
/// folder 不存在、父 folder 缺失、非 git 仓库、git 命令暂不可用
/// （目录刚删 / 并发）都返回 `Ok(现状)`，静默不做任何改动。
pub async fn reconcile_worktree_family_core(
    db: &AppDatabase,
    emitter: Option<&EventEmitter>,
    terminal_manager: Option<&crate::terminal::manager::TerminalSessionManager>,
    folder_id: i32,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    let folder = folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    let Some(folder) = folder else {
        // 触发方持有的 folder 已删除（列表刷新竞态）——无可对账。
        return Ok(Vec::new());
    };
    // parent 指向的 root 已不在（孤儿 worktree）→ 以自身为 root 对账。
    let root_id = match folder.parent_id {
        Some(parent_id) => {
            let parent = folder_service::get_folder_by_id(&db.conn, parent_id)
                .await
                .map_err(AppCommandError::from)?;
            match parent {
                Some(_) => parent_id,
                None => folder.id,
            }
        }
        None => folder.id,
    };
    let root = if root_id == folder.id {
        folder
    } else {
        folder_service::get_folder_by_id(&db.conn, root_id)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| AppCommandError::not_found(format!("Root folder {root_id} not found")))?
    };

    if !is_git_repo(std::path::Path::new(&root.path)) {
        return Ok(vec![root]);
    }

    let output = crate::platform::process::tokio_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&root.path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !output.status.success() {
        // git 暂不可用（目录刚删 / 权限）——返回现状，不做增删。
        return Ok(vec![root]);
    }
    let live_paths: Vec<String> = parse_worktrees(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .map(|(path, _)| {
            std::fs::canonicalize(&path)
                .unwrap_or_else(|_| PathBuf::from(&path))
                .to_string_lossy()
                .into_owned()
        })
        .collect();

    let family = folder_service::list_all_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)?
        .into_iter()
        .filter(|f| f.id == root_id || f.parent_id == Some(root_id))
        .collect::<Vec<_>>();

    let canonical_of = |path: &str| {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| PathBuf::from(path))
            .to_string_lossy()
            .into_owned()
    };

    // 登记 git 现存、家族缺失的 worktree（main worktree 即 root 自身）。
    for live in &live_paths {
        let registered = family.iter().find(|f| canonical_of(&f.path) == *live);
        // 软链仍可访问不代表存储路径仍正确；重用原身份刷新到 Git 的真实路径。
        if registered.is_none_or(|f| f.path != *live) {
            let is_root_path = canonical_of(&root.path) == *live;
            open_single_folder(db, live.clone(), (!is_root_path).then_some(root_id)).await?;
        }
    }

    // 移除 git 已无的家族成员（root 自身除外）。
    for member in &family {
        if member.id == root_id {
            continue;
        }
        let member_canonical = canonical_of(&member.path);
        if live_paths.iter().any(|live| live == &member_canonical) {
            continue;
        }
        match (emitter, terminal_manager) {
            (Some(emitter), Some(manager)) => {
                remove_folder_from_workspace_core(emitter, db, member.id, Some(manager)).await?
            }
            _ => {
                // 无清理能力时降级：关 open + 软删（列表不再显示）。
                folder_service::set_folder_open(&db.conn, member.id, false)
                    .await
                    .map_err(AppCommandError::from)?;
                folder_service::remove_folder(&db.conn, &member.path)
                    .await
                    .map_err(AppCommandError::from)?;
            }
        }
    }

    let result = folder_service::list_all_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)?
        .into_iter()
        .filter(|f| f.id == root_id || f.parent_id == Some(root_id))
        .collect();
    Ok(result)
}

async fn open_single_folder(
    db: &AppDatabase,
    path: String,
    parent_id: Option<i32>,
) -> Result<FolderDetail, AppCommandError> {
    let entry = folder_service::add_folder_with_parent(&db.conn, &path, parent_id)
        .await
        .map_err(AppCommandError::from)?;
    folder_service::get_folder_by_id(&db.conn, entry.id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found after add"))
}

/// Open a freshly created git worktree directory as a folder, recording the
/// *root* folder it descends from. Parents are flattened: a worktree created
/// from another worktree still records the original root, so every worktree of a
/// repo groups under that one repo folder. An unknown / non-positive
/// `source_folder_id` degrades to a top-level folder (`parent_id = None`) rather
/// than erroring.
pub async fn open_worktree_folder_core(
    db: &AppDatabase,
    path: String,
    source_folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    let parent_id = if source_folder_id > 0 {
        folder_service::get_folder_by_id(&db.conn, source_folder_id)
            .await
            .map_err(AppCommandError::from)?
            .map(|src| src.parent_id.unwrap_or(src.id))
    } else {
        None
    };
    let entry = folder_service::add_folder_with_parent(&db.conn, &path, parent_id)
        .await
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
    folder_service::set_folder_open(&db.conn, folder_id, true)
        .await
        .map_err(AppCommandError::from)?;
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
    let source_path = folder.path;

    // 移除项目 = 移除整个 worktree 家族：先移除挂在 root 下的成员，
    // 否则它们会以孤儿身份浮到顶层。只从列表移除，不动磁盘上的 worktree。
    if folder.parent_id.is_none() {
        let children = folder_service::list_all_folder_details(&db.conn)
            .await
            .map_err(AppCommandError::from)?
            .into_iter()
            .filter(|f| f.parent_id == Some(folder_id));
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

async fn remove_worktree_directory_core(
    db: &AppDatabase,
    terminal_manager: &crate::terminal::manager::TerminalSessionManager,
    folder_id: i32,
) -> Result<(), AppCommandError> {
    let folder = get_folder_core(db, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    let parent_id = folder.parent_id.ok_or_else(|| {
        AppCommandError::invalid_input("Only a registered worktree can be deleted")
    })?;
    let parent = get_folder_core(db, parent_id)
        .await
        .map_err(AppCommandError::from)?;

    let status = crate::platform::process::tokio_command("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(&folder.path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !status.status.success() {
        return Err(git_command_error("status", &status.stderr));
    }
    if !status.stdout.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Worktree has uncommitted changes and cannot be deleted",
        ));
    }

    terminal_manager
        .terminate_and_remove_folder(folder_id)
        .await
        .map_err(AppCommandError::from)?;

    let output = crate::platform::process::tokio_command("git")
        .args(["worktree", "remove", "--"])
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
        return Err(AppCommandError::invalid_input(format!("Invalid name: {name}")));
    }
    let folder = get_folder_core(db, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    let parent_id = folder.parent_id.ok_or_else(|| {
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

    let new_branch = renamed_branch.map(|_| name.to_owned()).or(old_branch.clone());
    let detail = folder_service::update_folder_path(
        &db.conn,
        folder_id,
        &to.to_string_lossy(),
        new_branch,
    )
    .await
    .map_err(AppCommandError::from)?
    .ok_or_else(|| AppCommandError::not_found("Folder not found"))?;

    // 群环境跟着走；目录已经改好，这一步失败只记日志，下次对账会把新目录当新群。
    if let Ok(berth_project_core::tasks::Scope { main, .. }) = berth_project_core::tasks::resolve(&to) {
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
pub async fn open_folder_in_workspace(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
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
pub async fn remove_folder_from_workspace(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, crate::terminal::manager::TerminalManager>,
    folder_id: i32,
    delete_worktree: Option<bool>,
) -> Result<(), AppCommandError> {
    if delete_worktree.unwrap_or(false) {
        remove_worktree_directory_core(&db, &manager, folder_id).await?;
    }
    remove_folder_from_workspace_core(&EventEmitter::Tauri(app), &db, folder_id, Some(&manager))
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
pub async fn reconcile_worktree_family(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, crate::terminal::manager::TerminalManager>,
    folder_id: i32,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    reconcile_worktree_family_core(
        &db,
        Some(&EventEmitter::Tauri(app)),
        Some(&manager),
        folder_id,
    )
    .await
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

    let folders = folder_service::list_all_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    let folder_id = folders
        .into_iter()
        .find(|f| {
            let canon = std::fs::canonicalize(&f.path).unwrap_or_else(|_| PathBuf::from(&f.path));
            canon == canonical_wt
        })
        .map(|f| f.id);

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
        folder_service::add_folder_with_parent(&db.conn, "/tmp/berth-family-wt", Some(root.id))
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
                sort_order: 0,
                color: "inherit".to_string(),
                parent_id: Some(1),
                kind: FolderKind::Regular,
                alias: None,
                pinned_at: None,
            },
        );

        let evt = rx.try_recv().expect("folder upsert should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, FOLDER_CHANGED_EVENT);
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["folder"]["id"], 7);
        assert_eq!(p["folder"]["parent_id"], 1);
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
        assert_eq!(pinned.alias.as_deref(), Some("alias"));
        assert!(pinned.pinned_at.is_some(), "pin must stamp pinned_at");

        let unpinned = update_folder_alias_core(
            &db,
            entry.id,
            Some("stale alias".into()),
            Some(false),
            Some(false),
        )
        .await
        .expect("unpin folder");
        assert_eq!(
            unpinned.alias.as_deref(),
            Some("alias"),
            "pin updates must preserve the current alias"
        );
        assert!(unpinned.pinned_at.is_none(), "unpin must clear pinned_at");
    }

    #[tokio::test]
    async fn add_folder_to_history_core_upserts_on_duplicate_path() {
        let db = fresh_in_memory_db().await;
        let path = "/tmp/codeg-dup-test".to_string();
        let first = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 1st");
        let second = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 2nd");
        assert_eq!(first.id, second.id, "duplicate path must reuse id");

        let history = load_folder_history_core(&db).await.expect("history");
        assert_eq!(
            history.iter().filter(|f| f.path == path).count(),
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
        // Either the not_found wrapper (when set_folder_open returns Ok(()) on no-op)
        // or the underlying DbError propagates — both are acceptable for "missing".
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
            .find(|folder| folder.parent_id.is_none())
            .expect("root folder");
        assert_eq!(selected.parent_id, Some(root_folder.id));
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
        assert_eq!(root.parent_id, None, "root folder has no parent");

        let wt = open_worktree_folder_core(&db, "/tmp/codeg-wt-a".into(), root.id)
            .await
            .expect("open worktree");
        assert_eq!(
            wt.parent_id,
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
        assert_eq!(child.parent_id, Some(root.id));
        assert_eq!(
            grandchild.parent_id,
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
            wt.parent_id, None,
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
        assert_eq!(wt.parent_id, Some(root.id));
        // A plain reopen of the same path must not clear the recorded parent.
        let reopened = open_folder_core(&db, "/tmp/codeg-wt-preserve".into())
            .await
            .expect("reopen plain");
        assert_eq!(
            reopened.parent_id,
            Some(root.id),
            "plain open_folder must preserve an existing worktree parent"
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_unknown_source_demotes_existing_to_root() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-demote-root".into())
            .await
            .expect("open root");
        let path = "/tmp/codeg-wt-demote".to_string();
        let wt = open_worktree_folder_core(&db, path.clone(), root.id)
            .await
            .expect("open worktree");
        assert_eq!(wt.parent_id, Some(root.id));
        // Reopening the same path as a worktree with an unknown source writes the
        // authoritative value (top-level) rather than keeping the stale parent.
        let demoted = open_worktree_folder_core(&db, path, 0)
            .await
            .expect("reopen worktree with no source");
        assert_eq!(
            demoted.parent_id, None,
            "explicit worktree open with unknown source demotes to top-level"
        );
    }

    #[tokio::test]
    async fn reconcile_registers_worktrees_added_after_discovery() {
        let db = fresh_in_memory_db().await;
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("main");
        let linked = temp.path().join("feature");
        let third = temp.path().join("chore");
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
        // 家族外再 add 一个 worktree —— 对账前不出现。
        run_git(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "chore",
                third.to_str().expect("utf8 path"),
            ],
        );
        let family = reconcile_worktree_family_core(&db, None, None, selected.id)
            .await
            .expect("reconcile");
        assert_eq!(family.len(), 3, "reconcile must register the new worktree");
        assert!(
            family.iter().any(|f| {
                std::fs::canonicalize(&f.path).expect("canonical")
                    == std::fs::canonicalize(&third).expect("canonical third")
            }),
            "family must contain the third worktree path"
        );
    }

    #[tokio::test]
    async fn reconcile_removes_worktrees_deleted_outside_berth() {
        let db = fresh_in_memory_db().await;
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("main");
        let linked = temp.path().join("feature");
        let stale = temp.path().join("stale");
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

        run_git(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "stale",
                stale.to_str().expect("utf8 path"),
            ],
        );

        let selected = open_folder_core(&db, linked.to_string_lossy().into_owned())
            .await
            .expect("open linked worktree");
        assert_eq!(
            reconcile_worktree_family_core(&db, None, None, selected.id)
                .await
                .expect("reconcile")
                .len(),
            3
        );

        // 手工删目录未 prune：git 标记 prunable，同样视为已不存在。
        std::fs::remove_dir_all(&stale).expect("rm stale worktree");

        // git 侧删掉 worktree（目录随之消失）——对账后家族只剩 root。
        run_git(
            &root,
            &[
                "worktree",
                "remove",
                "--force",
                linked.to_str().expect("utf8 path"),
            ],
        );
        let family = reconcile_worktree_family_core(&db, None, None, selected.id)
            .await
            .expect("reconcile after remove");
        assert_eq!(
            family.len(),
            1,
            "removed worktree folder must leave the family"
        );
        assert_eq!(family[0].parent_id, None, "only the root remains");
    }

    #[tokio::test]
    async fn reconcile_missing_folder_is_a_silent_noop() {
        // 触发方持有已删除 folder（列表刷新竞态）——必须 Ok(空) 而非报错，
        // 否则每次竞态都会刷一条 console error。
        let db = fresh_in_memory_db().await;
        let family = reconcile_worktree_family_core(&db, None, None, 99_999)
            .await
            .expect("missing folder must not error");
        assert!(family.is_empty(), "no family for a missing folder");
    }

    #[tokio::test]
    async fn reconcile_is_idempotent() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-idem-root".into())
            .await
            .expect("open root");
        let first = reconcile_worktree_family_core(&db, None, None, root.id)
            .await
            .expect("reconcile 1");
        let second = reconcile_worktree_family_core(&db, None, None, root.id)
            .await
            .expect("reconcile 2");
        assert_eq!(first.len(), second.len(), "no-op reconcile must be stable");
        let rows = folder_service::list_all_folder_details(&db.conn)
            .await
            .expect("list");
        assert_eq!(
            rows.iter()
                .filter(|f| f.id == root.id || f.parent_id == Some(root.id))
                .count(),
            first.len(),
            "no duplicate rows after repeated reconcile"
        );
    }

    #[tokio::test]
    async fn update_folder_default_agent_core_set_then_clear() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-agent-test".into())
            .await
            .expect("add");
        let set = update_folder_default_agent_core(&db, entry.id, Some(AgentType::new("claude_code")))
            .await
            .expect("set agent");
        assert_eq!(set.default_agent_type, Some(AgentType::new("claude_code")));
        let cleared = update_folder_default_agent_core(&db, entry.id, None)
            .await
            .expect("clear agent");
        assert_eq!(cleared.default_agent_type, None);
    }
}
