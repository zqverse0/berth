use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use crate::agent::AgentType;
use crate::entities::folder;
use crate::entities::folder::FolderKind;
use crate::error::DbError;
use crate::service::folder::{FolderDetail, FolderHistoryEntry};

/// Theme color sentinel stored in the DB. The frontend leaves the folder group
/// unscoped so it inherits the app-wide appearance theme color.
pub const DEFAULT_FOLDER_COLOR: &str = "inherit";

fn to_entry(m: folder::Model) -> FolderHistoryEntry {
    FolderHistoryEntry {
        id: m.id,
        path: m.path,
        name: m.name,
        last_opened_at: m.last_opened_at,
    }
}

fn parse_agent_type(s: &Option<String>) -> Option<AgentType> {
    s.as_deref()
        .and_then(|v| serde_json::from_value(serde_json::Value::String(v.to_string())).ok())
}

fn to_detail(m: folder::Model) -> FolderDetail {
    let default_agent_type = parse_agent_type(&m.default_agent_type);
    FolderDetail {
        id: m.id,
        name: m.name,
        path: m.path,
        project_runtime_id: m.project_runtime_id,
        git_branch: m.git_branch,
        default_agent_type,
        last_opened_at: m.last_opened_at,
        sort_order: m.sort_order,
        color: m.color,
        parent_id: m.parent_id,
        kind: m.kind,
        alias: m.alias,
        pinned_at: m.pinned_at,
    }
}

pub async fn get_folder_by_id(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    Ok(row.map(to_detail))
}

/// How [`add_folder_inner`] writes the `parent_id` column. The two callers want
/// different semantics on reopen of an existing path, which a bare `Option<i32>`
/// could not express (it conflates "no parent" with "don't touch the parent").
enum ParentWrite {
    /// Plain open: leave an existing row's `parent_id` untouched (insert NULL).
    /// A plain reopen must never clear a worktree's recorded root.
    Preserve,
    /// Worktree open: write this exact value on both insert and reopen — so the
    /// stored relationship always reflects the latest call (including `None` to
    /// demote to a top-level folder) and can never go stale.
    Set(Option<i32>),
}

pub async fn add_folder(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_inner(conn, path, ParentWrite::Preserve).await
}

/// Like [`add_folder`] but authoritatively sets `parent_id` — the *root* folder
/// this path was created under (used by the worktree flow so a worktree folder
/// remembers its originating repo folder). The value is written on both insert
/// and reopen, so it always reflects the latest worktree relationship and never
/// a stale one.
pub async fn add_folder_with_parent(
    conn: &DatabaseConnection,
    path: &str,
    parent_id: Option<i32>,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_inner(conn, path, ParentWrite::Set(parent_id)).await
}

/// Parse `git worktree list --porcelain` into `(worktree_path, branch)` pairs.
/// Each porcelain block starts with a `worktree <path>` line and is terminated
/// by a blank line; a `branch refs/heads/<name>` line carries the checked-out
/// branch (absent for detached/bare worktrees → `None`). Trailing blocks with
/// no terminating blank line are flushed at EOF.
pub fn parse_worktrees(stdout: &str) -> Vec<(String, Option<String>)> {
    // prunable 条目（目录已删、元数据未 prune）不是可用的 worktree，一律跳过。
    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut prunable = false;
    let mut flush = |path: Option<String>, branch: Option<String>, prunable: bool| {
        if let Some(path) = path.filter(|_| !prunable) {
            entries.push((path, branch));
        }
    };

    for line in stdout.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // Defensive flush in case a block wasn't blank-line terminated.
            flush(current_path.take(), current_branch.take(), prunable);
            current_path = Some(p.trim().to_string());
            prunable = false;
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(b.trim().to_string());
        } else if line == "prunable" || line.starts_with("prunable ") {
            prunable = true;
        } else if line.is_empty() {
            flush(current_path.take(), current_branch.take(), prunable);
            prunable = false;
        }
    }
    flush(current_path.take(), current_branch.take(), prunable);
    entries
}

fn canonical_or_raw(path: &str) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path))
}

async fn open_detail(
    conn: &DatabaseConnection,
    path: &std::path::Path,
    parent: ParentWrite,
) -> Result<FolderDetail, DbError> {
    let entry = add_folder_inner(conn, &path.to_string_lossy(), parent).await?;
    get_folder_by_id(conn, entry.id)
        .await?
        .ok_or_else(|| DbError::NotFound("Folder not found after add".into()))
}

/// 添加（打开）项目：GUI「添加项目」与无 GUI 时的 `berth project add` 共用。
///
/// git 仓库按 worktree 家族登记：主 worktree 是唯一的根，其余 linked worktree 挂在它下面，
/// 选中家族任一成员都得到同一组。已归组的项目、普通目录（含非 git）只做普通打开：切换到
/// 已有项目保持便宜稳定，worktree 发现只在首次添加时做；顶层的旧 linked worktree 借此入组一次。
pub async fn open_project(conn: &DatabaseConnection, path: &str) -> Result<FolderDetail, DbError> {
    let canonical = canonical_or_raw(path);
    let registered = list_all_folder_details(conn)
        .await?
        .into_iter()
        .find(|folder| canonical_or_raw(&folder.path) == canonical);
    let linked_worktree = canonical.join(".git").is_file();
    if registered.is_some_and(|folder| folder.parent_id.is_some() || !linked_worktree)
        || !canonical.join(".git").exists()
    {
        return open_detail(conn, &canonical, ParentWrite::Preserve).await;
    }

    let output = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&canonical)
        .stdin(std::process::Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(DbError::Io(std::io::Error::other(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))));
    }
    let worktrees = parse_worktrees(&String::from_utf8_lossy(&output.stdout));
    let Some((main_path, _)) = worktrees.first() else {
        return open_detail(conn, &canonical, ParentWrite::Set(None)).await;
    };

    // git porcelain 先列主 worktree：登记为根，其余 linked worktree 平铺挂在它下面。
    let main = canonical_or_raw(main_path);
    let root = open_detail(conn, &main, ParentWrite::Set(None)).await?;
    let mut selected = (main == canonical).then(|| root.clone());
    for (worktree, _) in worktrees.iter().skip(1) {
        let worktree = canonical_or_raw(worktree);
        let detail = open_detail(conn, &worktree, ParentWrite::Set(Some(root.id))).await?;
        if worktree == canonical {
            selected = Some(detail);
        }
    }
    selected.ok_or_else(|| {
        DbError::NotFound("Selected folder was not present in git worktree list".into())
    })
}

async fn add_folder_inner(
    conn: &DatabaseConnection,
    path: &str,
    parent: ParentWrite,
) -> Result<FolderHistoryEntry, DbError> {
    let now = Utc::now();
    // 目录别名不是项目身份：软链与真实路径必须复用同一 ID / runtime UUID。
    // 不存在的历史路径保留原值，不能凭名字猜测搬迁目标。
    let canonical = std::fs::canonicalize(path).ok();
    let normalized = canonical.as_ref().map(|p| p.to_string_lossy().into_owned());
    let path = normalized.as_deref().unwrap_or(path);
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let mut existing = folder::Entity::find()
        .filter(folder::Column::Path.eq(path))
        .one(conn)
        .await?;

    if existing.is_none() {
        if let Some(canonical) = &canonical {
            existing = folder::Entity::find()
                .filter(folder::Column::DeletedAt.is_null())
                .filter(folder::Column::Kind.eq(FolderKind::Regular))
                .order_by_asc(folder::Column::Id)
                .all(conn)
                .await?
                .into_iter()
                .find(|row| std::fs::canonicalize(&row.path).ok().as_ref() == Some(canonical));
        }
    }

    let model = if let Some(row) = existing {
        let mut active = row.into_active_model();
        active.path = Set(path.to_string());
        active.name = Set(name);
        active.last_opened_at = Set(now);
        active.updated_at = Set(now);
        active.deleted_at = Set(None);
        active.is_open = Set(true);
        // Plain reopen leaves the relationship as-is; the worktree flow writes
        // the authoritative value (including NULL) so it can never go stale.
        if let ParentWrite::Set(parent_id) = parent {
            active.parent_id = Set(parent_id);
        }
        active.update(conn).await?
    } else {
        let max_order = folder::Entity::find()
            .order_by_desc(folder::Column::SortOrder)
            .one(conn)
            .await?
            .map(|m| m.sort_order)
            .unwrap_or(0);
        let active = folder::ActiveModel {
            id: NotSet,
            name: Set(name.clone()),
            path: Set(path.to_string()),
            project_runtime_id: Set(uuid::Uuid::new_v4().to_string()),
            git_branch: Set(None),
            default_agent_type: Set(None),
            last_opened_at: Set(now),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
            is_open: Set(true),
            sort_order: Set(max_order + 1),
            color: Set(DEFAULT_FOLDER_COLOR.to_string()),
            parent_id: Set(match parent {
                ParentWrite::Preserve => None,
                ParentWrite::Set(parent_id) => parent_id,
            }),
            kind: Set(FolderKind::Regular),
            alias: Set(None),
            pinned_at: Set(None),
        };
        active.insert(conn).await?
    };

    ensure_distinct_folder_aliases(conn).await?;
    Ok(to_entry(model))
}

/// 同名项目统一填充普通别名；已有别名不覆盖，自动发现和手动添加走同一规则。
pub async fn ensure_distinct_folder_aliases(conn: &DatabaseConnection) -> Result<(), DbError> {
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE folder SET alias = name || ' · ' || id, updated_at = ? \
         WHERE alias IS NULL AND deleted_at IS NULL AND kind = 'regular' \
         AND name IN (SELECT name FROM folder WHERE deleted_at IS NULL AND kind = 'regular' \
         GROUP BY name HAVING COUNT(*) > 1)",
        [Utc::now().into()],
    ))
    .await?;
    Ok(())
}

/// Create a dedicated hidden folder backing a single chat-mode conversation.
///
/// Unlike [`add_folder`], the display name is a fixed sentinel ("Chat") rather
/// than derived from the path, and `kind = chat` is set so the frontend routes
/// this folder's conversations to the sidebar "Chat" group and hides
/// folder-bound chrome. `path` is a freshly generated per-conversation scratch dir, so it
/// never collides on the `UNIQUE(path)` constraint. Returns the full
/// [`FolderDetail`] so the caller can hand it straight to the frontend.
pub async fn add_chat_folder(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderDetail, DbError> {
    let now = Utc::now();
    let max_order = folder::Entity::find()
        .order_by_desc(folder::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(0);
    let active = folder::ActiveModel {
        id: NotSet,
        name: Set("Chat".to_string()),
        path: Set(path.to_string()),
        project_runtime_id: Set(uuid::Uuid::new_v4().to_string()),
        git_branch: Set(None),
        default_agent_type: Set(None),
        last_opened_at: Set(now),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        is_open: Set(true),
        sort_order: Set(max_order + 1),
        color: Set(DEFAULT_FOLDER_COLOR.to_string()),
        parent_id: Set(None),
        kind: Set(FolderKind::Chat),
        alias: Set(None),
        pinned_at: Set(None),
    };
    let model = active.insert(conn).await?;
    Ok(to_detail(model))
}

/// Sets (or clears) a folder's display alias. `alias = None` clears it; callers
/// are expected to have already normalized empty/whitespace input to `None`.
///
/// `pinned = Some(true)` stamps `pinned_at` to now; `Some(false)` clears it.
/// `None` leaves the pin state unchanged. Pinning is a view preference and
/// reuses this command so the folders command surface does not grow.
pub async fn update_folder_alias(
    conn: &DatabaseConnection,
    folder_id: i32,
    alias: Option<String>,
    update_alias: bool,
    pinned: Option<bool>,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let mut active = row.into_active_model();
    if update_alias {
        active.alias = Set(alias);
    }
    if let Some(pinned) = pinned {
        active.pinned_at = Set(if pinned { Some(Utc::now()) } else { None });
    }
    active.updated_at = Set(Utc::now());
    let updated = active.update(conn).await?;
    Ok(Some(to_detail(updated)))
}

/// 目录搬家（worktree 改名）后改写路径、名字与分支，保留 id：会话、tab、别名都按 id 挂着。
pub async fn update_folder_path(
    conn: &DatabaseConnection,
    folder_id: i32,
    path: &str,
    git_branch: Option<String>,
) -> Result<Option<FolderDetail>, DbError> {
    let Some(row) = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?
    else {
        return Ok(None);
    };
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let mut active = row.into_active_model();
    active.path = Set(path.to_string());
    active.name = Set(name);
    active.git_branch = Set(git_branch);
    active.updated_at = Set(Utc::now());
    Ok(Some(to_detail(active.update(conn).await?)))
}

pub async fn update_folder_default_agent(
    conn: &DatabaseConnection,
    folder_id: i32,
    default_agent_type: Option<AgentType>,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    // Serialize AgentType to its snake_case wire form (e.g. "claude_code").
    // Mirrors `parse_agent_type`'s round-trip through serde_json.
    let serialized = default_agent_type
        .map(|t| serde_json::to_value(t).ok())
        .and_then(|v| v.and_then(|val| val.as_str().map(|s| s.to_string())));

    let mut active = row.into_active_model();
    active.default_agent_type = Set(serialized);
    active.updated_at = Set(Utc::now());
    let updated = active.update(conn).await?;
    Ok(Some(to_detail(updated)))
}

pub async fn list_folders(conn: &DatabaseConnection) -> Result<Vec<FolderHistoryEntry>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        // Only regular folders are user-facing in folder history / open-folder
        // pickers — hidden chat folders (and future engine-created kinds) are an
        // implementation detail.
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_entry).collect())
}

pub async fn remove_folder(conn: &DatabaseConnection, path: &str) -> Result<(), DbError> {
    let now = Utc::now();
    let row = folder::Entity::find()
        .filter(folder::Column::Path.eq(path))
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    if let Some(row) = row {
        let mut active = row.into_active_model();
        active.deleted_at = Set(Some(now));
        active.updated_at = Set(now);
        active.update(conn).await?;
    }
    Ok(())
}

/// Forget a project registration without deleting data linked to its folder id.
///
/// The old row remains as a hidden foreign-key anchor, but its real path is
/// replaced so adding that path again creates a new folder/runtime identity.
pub async fn forget_folder<C: ConnectionTrait>(
    conn: &C,
    folder_id: i32,
) -> Result<String, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("Folder {folder_id} not found")))?;

    let path = row.path.clone();
    let now = Utc::now();
    let mut active = row.into_active_model();
    let tombstone = uuid::Uuid::new_v4();
    active.name = Set("forgotten".to_string());
    active.path = Set(format!("berth-forgotten://{tombstone}"));
    active.project_runtime_id = Set(tombstone.to_string());
    active.deleted_at = Set(Some(now));
    active.is_open = Set(false);
    active.git_branch = Set(None);
    active.default_agent_type = Set(None);
    active.parent_id = Set(None);
    active.alias = Set(None);
    active.pinned_at = Set(None);
    active.updated_at = Set(now);
    active.update(conn).await?;

    Ok(path)
}

pub async fn set_folder_open(
    conn: &DatabaseConnection,
    folder_id: i32,
    is_open: bool,
) -> Result<(), DbError> {
    let row = folder::Entity::find_by_id(folder_id).one(conn).await?;

    if let Some(row) = row {
        let mut active = row.into_active_model();
        active.is_open = Set(is_open);
        active.updated_at = Set(Utc::now());
        active.update(conn).await?;
    }
    Ok(())
}

pub async fn list_open_folders(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderHistoryEntry>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_entry).collect())
}

pub async fn list_open_folder_details(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderDetail>, DbError> {
    // Excludes hidden chat folders from the workspace "open folders" surface.
    // `list_all_folder_details` (below) intentionally keeps them so the frontend
    // can still resolve an active chat conversation's cwd / active folder by id.
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_asc(folder::Column::SortOrder)
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_detail).collect())
}

pub async fn list_all_folder_details(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderDetail>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .order_by_asc(folder::Column::SortOrder)
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_detail).collect())
}

/// Paths of all *live* (non-deleted) chat scratch folders. Consumed by the
/// startup orphan-scratch-dir GC to spare directories still bound to a chat
/// conversation, while reclaiming pre-send drafts (no row at all) and
/// post-delete dirs (soft-deleted row → `DeletedAt` set → excluded here).
pub async fn list_live_chat_folder_paths(
    conn: &DatabaseConnection,
) -> Result<Vec<String>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::Kind.eq(FolderKind::Chat))
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(|m| m.path).collect())
}

pub async fn reorder_folders(conn: &DatabaseConnection, ids: Vec<i32>) -> Result<(), DbError> {
    if ids.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    let now_str = now.format("%Y-%m-%d %H:%M:%S %:z").to_string();
    let case_expr = ids
        .iter()
        .enumerate()
        .map(|(idx, id)| format!("WHEN {} THEN {}", id, idx + 1))
        .collect::<Vec<_>>()
        .join(" ");
    let id_list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "UPDATE folder SET sort_order = CASE id {case_expr} END, updated_at = '{now_str}' WHERE id IN ({id_list})"
    );
    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_worktrees;

    #[test]
    fn parse_worktrees_extracts_path_branch_pairs() {
        // Main tree + a linked worktree + a detached worktree, trailing blank line.
        let stdout = "\
worktree /repo/main
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /repo/wt-feature
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature-x

worktree /repo/wt-detached
HEAD cccccccccccccccccccccccccccccccccccccccc
detached

";
        let entries = parse_worktrees(stdout);
        assert_eq!(
            entries,
            vec![
                ("/repo/main".to_string(), Some("main".to_string())),
                (
                    "/repo/wt-feature".to_string(),
                    Some("feature-x".to_string())
                ),
                ("/repo/wt-detached".to_string(), None),
            ]
        );
    }

    #[test]
    fn parse_worktrees_flushes_trailing_block_without_blank_line() {
        // No terminating blank line on the last block (git omits it at EOF here).
        let stdout = "\
worktree /repo/main
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main";
        let entries = parse_worktrees(stdout);
        assert_eq!(
            entries,
            vec![("/repo/main".to_string(), Some("main".to_string()))]
        );
    }

    #[test]
    fn parse_worktrees_skips_prunable_entries() {
        let stdout = "\
worktree /repo/main
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /repo/wt-gone
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/gone
prunable gitdir file points to non-existent location

";
        assert_eq!(
            parse_worktrees(stdout),
            vec![("/repo/main".to_string(), Some("main".to_string()))]
        );
    }

    #[test]
    fn parse_worktrees_handles_empty_and_bare() {
        assert!(parse_worktrees("").is_empty());
        // A bare repo entry carries no branch.
        let entries = parse_worktrees("worktree /repo/bare\nbare\n\n");
        assert_eq!(entries, vec![("/repo/bare".to_string(), None)]);
    }
}
