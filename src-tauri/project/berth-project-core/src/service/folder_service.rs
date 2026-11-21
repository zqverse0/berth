use std::collections::HashMap;

use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use crate::agent::AgentType;
use crate::entities::folder::FolderKind;
use crate::entities::{automation_run, folder, project};
use crate::error::DbError;
use crate::service::folder::{
    CheckoutView, FolderDetail, FolderHistoryEntry, ProjectMember, ProjectSummary, ProjectView,
    UntrackedCheckout,
};

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

async fn projects_by_id<C: ConnectionTrait>(
    conn: &C,
) -> Result<HashMap<i32, project::Model>, DbError> {
    Ok(project::Entity::find()
        .all(conn)
        .await?
        .into_iter()
        .map(|p| (p.id, p))
        .collect())
}

fn to_detail(m: folder::Model, projects: &HashMap<i32, project::Model>) -> FolderDetail {
    let default_agent_type = parse_agent_type(&m.default_agent_type);
    FolderDetail {
        id: m.id,
        project_id: m.project_id,
        project: m
            .project_id
            .and_then(|id| projects.get(&id))
            .map(|p| ProjectSummary {
                name: p.name.clone(),
                main_folder_id: p.main_folder_id,
                pinned_at: p.pinned_at,
                sort_order: p.sort_order,
                dir: crate::space::dir_of(p.id).map(|dir| dir.to_string_lossy().into_owned()),
            }),
        name: m.name,
        path: m.path,
        project_runtime_id: m.project_runtime_id,
        git_branch: m.git_branch,
        default_agent_type,
        last_opened_at: m.last_opened_at,
        kind: m.kind,
    }
}

async fn detail_of<C: ConnectionTrait>(
    conn: &C,
    m: folder::Model,
) -> Result<FolderDetail, DbError> {
    let projects = match m.project_id {
        Some(id) => project::Entity::find_by_id(id)
            .one(conn)
            .await?
            .into_iter()
            .map(|p| (p.id, p))
            .collect(),
        None => HashMap::new(),
    };
    Ok(to_detail(m, &projects))
}

pub async fn get_folder_by_id(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;
    match row {
        Some(row) => Ok(Some(detail_of(conn, row).await?)),
        None => Ok(None),
    }
}

pub async fn get_project(
    conn: &DatabaseConnection,
    project_id: i32,
) -> Result<Option<project::Model>, DbError> {
    Ok(project::Entity::find_by_id(project_id).one(conn).await?)
}

/// 项目的代码成员（未删除的 folder 行），主成员排第一。
pub async fn list_project_members(
    conn: &DatabaseConnection,
    project_id: i32,
) -> Result<Vec<FolderDetail>, DbError> {
    let mut members: Vec<FolderDetail> = list_all_folder_details(conn)
        .await?
        .into_iter()
        .filter(|f| f.project_id == Some(project_id))
        .collect();
    members.sort_by_key(|f| !f.is_main());
    Ok(members)
}

/// 主成员的 `git worktree list`（跳过 `prunable`）：(规范化路径, 分支)。主成员不是 git checkout
/// 根目录（项目是仓库子目录时 git 列的是仓库根）或 git 不可用时为 `None`。
fn live_checkouts(main: &std::path::Path) -> Option<Vec<(std::path::PathBuf, Option<String>)>> {
    if !main.join(".git").exists() {
        return None;
    }
    let output = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(main)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    Some(
        parse_worktrees(&String::from_utf8_lossy(&output.stdout))
            .into_iter()
            .map(|(path, branch)| (canonical_or_raw(&path), branch))
            .collect(),
    )
}

/// GUI 列成员：先登记 Berth 自己建的 worktree 群目录（群组在 CLI 侧建 worktree，不写库），再同
/// [`read_members`]。成员以手动为准，Berth 之外用 git 建的检出不登记，只在 [`untracked_checkouts`] 提示。
pub async fn discover_members(
    conn: &DatabaseConnection,
    project_id: i32,
) -> Result<Vec<ProjectMember>, DbError> {
    let members = list_project_members(conn, project_id).await?;
    let Some(main) = members.first() else {
        return Ok(Vec::new());
    };
    let groups = crate::tasks::group_worktrees(std::path::Path::new(&main.path));
    if !groups.is_empty() {
        // ponytail: 用户移出过的群目录（墓碑）下次仍会被登记回来；要记住移出再加排除表
        let registered: Vec<std::path::PathBuf> = list_all_folder_details(conn)
            .await?
            .iter()
            .filter(|f| f.project_id.is_some())
            .map(|f| canonical_or_raw(&f.path))
            .collect();
        for dir in groups {
            let dir = canonical_or_raw(&dir.to_string_lossy());
            if dir.is_dir() && !registered.contains(&dir) {
                add_folder_to_project(conn, &dir.to_string_lossy(), project_id).await?;
            }
        }
    }
    read_members(conn, project_id).await
}

/// 列出项目的代码成员（主成员在前）与失效 / 临时 / 分支。成员以手动为准：只在添加项目、
/// 新建 worktree、用户加入 / 改挂时登记，这里不登记也不删；git 新出现的检出见 [`untracked_checkouts`]。
pub async fn read_members(
    conn: &DatabaseConnection,
    project_id: i32,
) -> Result<Vec<ProjectMember>, DbError> {
    let members = list_project_members(conn, project_id).await?;
    let Some(main) = members.first() else {
        return Ok(Vec::new());
    };
    let live = live_checkouts(std::path::Path::new(&main.path));
    member_states(conn, project_id, live).await
}

/// 失效：目录不在（成员可来自别的仓库，不按主成员的 git 列表判）。
/// 临时：自动化运行的 worktree、任务都已结束的群。
async fn member_states(
    conn: &DatabaseConnection,
    project_id: i32,
    live: Option<Vec<(std::path::PathBuf, Option<String>)>>,
) -> Result<Vec<ProjectMember>, DbError> {
    let members = list_project_members(conn, project_id).await?;
    let Some(main) = members.first().cloned() else {
        return Ok(Vec::new());
    };
    let ids: Vec<i32> = members.iter().map(|f| f.id).collect();
    let run_worktrees: std::collections::HashSet<i32> = automation_run::Entity::find()
        .filter(automation_run::Column::WorktreeFolderId.is_in(ids))
        .all(conn)
        .await?
        .into_iter()
        .filter_map(|run| run.worktree_folder_id)
        .collect();
    let ended: Vec<std::path::PathBuf> =
        crate::tasks::ended_group_worktrees(std::path::Path::new(&main.path))
            .iter()
            .map(|path| canonical_or_raw(&path.to_string_lossy()))
            .collect();
    Ok(members
        .into_iter()
        .map(|folder| {
            let dir = canonical_or_raw(&folder.path);
            let is_main = folder.id == main.id;
            let listed = live
                .as_ref()
                .map(|live| live.iter().find(|(path, _)| *path == dir));
            let stale = !dir.is_dir();
            let temporary =
                !is_main && (run_worktrees.contains(&folder.id) || ended.contains(&dir));
            let branch = match listed {
                Some(hit) => hit.and_then(|(_, branch)| branch.clone()),
                None => folder.git_branch.clone(),
            };
            ProjectMember {
                folder,
                branch,
                stale,
                temporary,
            }
        })
        .collect())
}

/// 主成员的 `git worktree list` 里还没登记进任何项目的检出（只提示，由用户决定加入）。
/// 用户移出过的检出也会在这里出现。主成员不是 git checkout 根目录时为空。
pub async fn untracked_checkouts(
    conn: &DatabaseConnection,
    project_id: i32,
) -> Result<Vec<UntrackedCheckout>, DbError> {
    let members = list_project_members(conn, project_id).await?;
    let Some(main) = members.first() else {
        return Ok(Vec::new());
    };
    let registered: Vec<std::path::PathBuf> = list_all_folder_details(conn)
        .await?
        .iter()
        .filter(|f| f.project_id.is_some())
        .map(|f| canonical_or_raw(&f.path))
        .collect();
    Ok(live_checkouts(std::path::Path::new(&main.path))
        .unwrap_or_default()
        .into_iter()
        .filter(|(dir, _)| !registered.contains(dir))
        .map(|(dir, branch)| UntrackedCheckout {
            path: dir.to_string_lossy().into_owned(),
            branch,
        })
        .collect())
}

/// 把成员设为所在项目的主成员。
pub async fn set_main_member(conn: &DatabaseConnection, folder_id: i32) -> Result<(), DbError> {
    let folder = get_folder_by_id(conn, folder_id)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("Folder {folder_id} not found")))?;
    let project_id = folder
        .project_id
        .ok_or_else(|| DbError::Validation(format!("{} is not in a project", folder.path)))?;
    set_project_main(conn, project_id, folder_id).await
}

/// `dir` 所在的项目：路径是 `dir` 或其祖先的成员里最深的那个所属的项目。
pub async fn project_for_dir(
    conn: &DatabaseConnection,
    dir: &std::path::Path,
) -> Result<Option<project::Model>, DbError> {
    let dir = canonical_or_raw(&dir.to_string_lossy());
    let owner = list_all_folder_details(conn)
        .await?
        .into_iter()
        .filter(|f| f.project_id.is_some() && dir.starts_with(canonical_or_raw(&f.path)))
        .max_by_key(|f| f.path.len());
    match owner.and_then(|f| f.project_id) {
        Some(id) => get_project(conn, id).await,
        None => Ok(None),
    }
}

/// 只读的项目视图（检出与未加入的检出）；检出的 `agents` 留空给调用方填。
pub async fn project_view(
    conn: &DatabaseConnection,
    project: &project::Model,
) -> Result<ProjectView, DbError> {
    let checkouts: Vec<CheckoutView> = read_members(conn, project.id)
        .await?
        .into_iter()
        .map(|member| CheckoutView {
            main: member.folder.id == project.main_folder_id,
            path: member.folder.path,
            branch: member.branch,
            stale: member.stale,
            temporary: member.temporary,
            agents: Vec::new(),
        })
        .collect();
    Ok(ProjectView {
        name: project.name.clone(),
        home: checkouts
            .iter()
            .find(|checkout| checkout.main)
            .map(|checkout| checkout.path.clone())
            .unwrap_or_default(),
        checkouts,
        untracked: untracked_checkouts(conn, project.id).await?,
    })
}

/// 打开（登记）一个目录：已属于某项目就保持；新目录自成一个项目，自己是主成员。
pub async fn add_folder(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_inner(conn, path, None).await
}

/// 把目录登记为 `project_id` 的代码成员（新建 worktree、用户加入 / 改挂）。
/// 原来属于别的项目时改挂过来，旧项目没有成员了就一并删掉。
pub async fn add_folder_to_project(
    conn: &DatabaseConnection,
    path: &str,
    project_id: i32,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_inner(conn, path, Some(project_id)).await
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
    project_id: Option<i32>,
) -> Result<FolderDetail, DbError> {
    let entry = add_folder_inner(conn, &path.to_string_lossy(), project_id).await?;
    get_folder_by_id(conn, entry.id)
        .await?
        .ok_or_else(|| DbError::NotFound("Folder not found after add".into()))
}

/// 添加（打开）项目：GUI「添加项目」与无 GUI 时的 `berth project add` 共用。
///
/// 已登记的目录、普通目录（含非 git）只做普通打开。首次添加 git 仓库时，`git worktree list`
/// 的各 checkout 并成一个空间，主成员是 git 主 worktree；同仓库已有 checkout 属于某个空间时并进那个空间。
pub async fn open_project(conn: &DatabaseConnection, path: &str) -> Result<FolderDetail, DbError> {
    let canonical = canonical_or_raw(path);
    let all = list_all_folder_details(conn).await?;
    let registered_project = |dir: &std::path::Path| {
        all.iter()
            .find(|folder| canonical_or_raw(&folder.path) == dir)
            .and_then(|folder| folder.project_id)
    };
    if registered_project(&canonical).is_some() || !canonical.join(".git").exists() {
        return open_detail(conn, &canonical, None).await;
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
    let worktrees: Vec<std::path::PathBuf> =
        parse_worktrees(&String::from_utf8_lossy(&output.stdout))
            .into_iter()
            .map(|(path, _)| canonical_or_raw(&path))
            .collect();
    // `git worktree list` 第一项是 git 主 worktree。
    let Some(main) = worktrees.first() else {
        return open_detail(conn, &canonical, None).await;
    };

    // 并进已有空间时不改它的主项目（用户可能另设过）；新空间的主项目就是 git 主 worktree。
    let existing = worktrees.iter().find_map(|dir| registered_project(dir));
    let main_detail = open_detail(conn, main, existing).await?;
    let project_id = main_detail
        .project_id
        .ok_or_else(|| DbError::NotFound("Project not found after add".into()))?;
    let mut selected = (*main == canonical).then_some(main_detail);
    for worktree in worktrees.iter().filter(|dir| *dir != main) {
        let detail = open_detail(conn, worktree, Some(project_id)).await?;
        if *worktree == canonical {
            selected = Some(detail);
        }
    }
    let selected = selected.ok_or_else(|| {
        DbError::NotFound("Selected folder was not present in git worktree list".into())
    })?;
    // 主成员可能刚换过：重读一次，派生字段才对。
    get_folder_by_id(conn, selected.id)
        .await?
        .ok_or_else(|| DbError::NotFound("Folder not found after add".into()))
}

async fn set_project_main(
    conn: &DatabaseConnection,
    project_id: i32,
    main_folder_id: i32,
) -> Result<(), DbError> {
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE project SET main_folder_id = ?, updated_at = ? WHERE id = ? AND main_folder_id <> ?",
        [
            main_folder_id.into(),
            Utc::now().into(),
            project_id.into(),
            main_folder_id.into(),
        ],
    ))
    .await?;
    Ok(())
}

/// 新目录自成项目：项目名取目录名，与已有项目重名时加 ` · <folder id>` 区分。
async fn create_project<C: ConnectionTrait>(
    conn: &C,
    main: &folder::Model,
) -> Result<i32, DbError> {
    let now = Utc::now();
    let taken = project::Entity::find()
        .filter(project::Column::Name.eq(main.name.as_str()))
        .one(conn)
        .await?
        .is_some();
    let max_order = project::Entity::find()
        .order_by_desc(project::Column::SortOrder)
        .one(conn)
        .await?
        .map_or(0, |p| p.sort_order);
    let created = project::ActiveModel {
        id: NotSet,
        name: Set(if taken {
            format!("{} · {}", main.name, main.id)
        } else {
            main.name.clone()
        }),
        main_folder_id: Set(main.id),
        sort_order: Set(max_order + 1),
        pinned_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(conn)
    .await?;
    Ok(created.id)
}

/// 成员变动后收尾：没有成员的项目删掉，主成员已不在的改指最早登记的成员。
async fn prune_projects<C: ConnectionTrait>(conn: &C) -> Result<(), DbError> {
    const LIVE: &str = "SELECT id FROM folder WHERE deleted_at IS NULL AND project_id = project.id";
    for sql in [
        format!("DELETE FROM project WHERE NOT EXISTS ({LIVE})"),
        format!(
            "UPDATE project SET main_folder_id = ({LIVE} ORDER BY id LIMIT 1) \
             WHERE main_folder_id NOT IN ({LIVE})"
        ),
    ] {
        conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
            .await?;
    }
    Ok(())
}

async fn add_folder_inner(
    conn: &DatabaseConnection,
    path: &str,
    project_id: Option<i32>,
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
        if project_id.is_some() {
            active.project_id = Set(project_id);
        }
        active.update(conn).await?
    } else {
        folder::ActiveModel {
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
            project_id: Set(project_id),
            kind: Set(FolderKind::Regular),
        }
        .insert(conn)
        .await?
    };

    // 改挂、重开都可能留下空项目或失效的项目引用：先收尾，再给仍无项目的目录建一个。
    prune_projects(conn).await?;
    let has_project = match model.project_id {
        Some(id) => project::Entity::find_by_id(id).one(conn).await?.is_some(),
        None => false,
    };
    let model = if has_project {
        model
    } else {
        let id = create_project(conn, &model).await?;
        let mut active = model.into_active_model();
        active.project_id = Set(Some(id));
        active.update(conn).await?
    };
    Ok(to_entry(model))
}

/// Create a dedicated hidden folder backing a single chat-mode conversation.
///
/// Unlike [`add_folder`], the display name is a fixed sentinel ("Chat") rather
/// than derived from the path, and `kind = chat` is set so the frontend routes
/// this folder's conversations to the sidebar "Chat" group and hides
/// folder-bound chrome. Chat folders belong to no project. `path` is a freshly
/// generated per-conversation scratch dir, so it never collides on the
/// `UNIQUE(path)` constraint. Returns the full [`FolderDetail`] so the caller
/// can hand it straight to the frontend.
pub async fn add_chat_folder(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderDetail, DbError> {
    let now = Utc::now();
    let model = folder::ActiveModel {
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
        project_id: Set(None),
        kind: Set(FolderKind::Chat),
    }
    .insert(conn)
    .await?;
    Ok(to_detail(model, &HashMap::new()))
}

/// 改 folder 所属项目的名称或置顶。`alias = None` 恢复为主成员目录名；调用方已把空白输入归一成 `None`。
///
/// `pinned = Some(true)` 置顶（记当前时间），`Some(false)` 取消，`None` 不动。
pub async fn update_folder_alias(
    conn: &DatabaseConnection,
    folder_id: i32,
    alias: Option<String>,
    update_alias: bool,
    pinned: Option<bool>,
) -> Result<Option<FolderDetail>, DbError> {
    let Some(project_id) = get_folder_by_id(conn, folder_id)
        .await?
        .and_then(|folder| folder.project_id)
    else {
        return Ok(None);
    };
    let Some(row) = project::Entity::find_by_id(project_id).one(conn).await? else {
        return Ok(None);
    };
    let main_name = folder::Entity::find_by_id(row.main_folder_id)
        .one(conn)
        .await?
        .map(|main| main.name);

    let mut active = row.into_active_model();
    if update_alias {
        if let Some(name) = alias.or(main_name) {
            active.name = Set(name);
        }
    }
    if let Some(pinned) = pinned {
        active.pinned_at = Set(if pinned { Some(Utc::now()) } else { None });
    }
    active.updated_at = Set(Utc::now());
    active.update(conn).await?;
    get_folder_by_id(conn, folder_id).await
}

/// 目录搬家（worktree 改名）后改写路径、名字与分支，保留 id：会话、tab 都按 id 挂着。
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
    Ok(Some(detail_of(conn, active.update(conn).await?).await?))
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
    Ok(Some(detail_of(conn, updated).await?))
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
        prune_projects(conn).await?;
    }
    Ok(())
}

/// Forget a project registration without deleting data linked to its folder id.
///
/// The old row remains as a hidden foreign-key anchor, but its real path is
/// replaced so adding that path again creates a new folder/runtime identity.
/// The folder leaves its project; a project left without members is deleted.
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
    active.git_branch = Set(None);
    active.default_agent_type = Set(None);
    active.project_id = Set(None);
    active.updated_at = Set(now);
    active.update(conn).await?;
    prune_projects(conn).await?;

    Ok(path)
}

pub async fn list_open_folders(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderHistoryEntry>, DbError> {
    Ok(list_folders(conn)
        .await?
        .into_iter()
        .filter(|row| std::path::Path::new(&row.path).is_dir())
        .collect())
}

/// 按项目排序（`sort_order`），同项目内最近打开的在前。
fn sorted_details(
    rows: Vec<folder::Model>,
    projects: &HashMap<i32, project::Model>,
) -> Vec<FolderDetail> {
    let mut details: Vec<FolderDetail> = rows.into_iter().map(|m| to_detail(m, projects)).collect();
    details.sort_by(|a, b| {
        let order = |d: &FolderDetail| d.project.as_ref().map_or(0, |p| p.sort_order);
        order(a)
            .cmp(&order(b))
            .then(b.last_opened_at.cmp(&a.last_opened_at))
    });
    details
}

pub async fn list_open_folder_details(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderDetail>, DbError> {
    // Excludes hidden chat folders from the workspace "open folders" surface.
    // `list_all_folder_details` (below) intentionally keeps them so the frontend
    // can still resolve an active chat conversation's cwd / active folder by id.
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .all(conn)
        .await?
        .into_iter()
        // 只列仍存在的目录（被删、临时目录被清的不列；记录保留）：GUI、CLI 与设备概览同一口径。
        .filter(|row| std::path::Path::new(&row.path).is_dir())
        .collect();
    Ok(sorted_details(rows, &projects_by_id(conn).await?))
}

pub async fn list_all_folder_details(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderDetail>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .all(conn)
        .await?;
    Ok(sorted_details(rows, &projects_by_id(conn).await?))
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

/// 按 folder 顺序给它们所属的项目排序（同项目的多个 folder 取第一次出现的位置）。
pub async fn reorder_folders(conn: &DatabaseConnection, ids: Vec<i32>) -> Result<(), DbError> {
    let projects: HashMap<i32, Option<i32>> = folder::Entity::find()
        .filter(folder::Column::Id.is_in(ids.iter().copied()))
        .all(conn)
        .await?
        .into_iter()
        .map(|f| (f.id, f.project_id))
        .collect();
    let mut ordered: Vec<i32> = Vec::new();
    for project_id in ids
        .iter()
        .filter_map(|id| projects.get(id).copied().flatten())
    {
        if !ordered.contains(&project_id) {
            ordered.push(project_id);
        }
    }
    let now = Utc::now();
    for (idx, project_id) in ordered.into_iter().enumerate() {
        conn.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "UPDATE project SET sort_order = ?, updated_at = ? WHERE id = ?",
            [(idx as i32 + 1).into(), now.into(), project_id.into()],
        ))
        .await?;
    }
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
