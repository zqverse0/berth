//! 项目成员：迁移 `m20261120_000001_project` 前后夹具对比，以及新建 / 改挂 / 忘记成员后的项目收尾。

use std::path::Path;
use std::process::Command;

use berth_project_core::entities::{folder, project};
use berth_project_core::instance::{DataInstance, InstanceState, RELEASE_DB_FILE_NAME};
use berth_project_core::migration::Migrator;
use berth_project_core::open::open_or_upgrade;
use berth_project_core::service::folder_service;
use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseConnection, EntityTrait};
use sea_orm_migration::MigratorTrait;

const PROJECT_MIGRATION: &str = "m20261120_000001_project";

async fn ready(data_dir: &Path) -> DatabaseConnection {
    let instance = DataInstance::create_if_missing(data_dir, RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&instance).await;
    assert_eq!(state, InstanceState::Ready);
    conn.expect("ready connection")
}

fn project_of(folders: &[folder::Model], id: i32) -> Option<i32> {
    folders.iter().find(|f| f.id == id).unwrap().project_id
}

#[tokio::test]
async fn migration_merges_families_into_projects_with_hub_as_main() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repos");
    // 家族 1：git 主 worktree `berth` + 带 hub 标记的 `berth-dev`。
    std::fs::create_dir_all(root.join("berth")).unwrap();
    std::fs::create_dir_all(root.join("berth-dev/.berth/local")).unwrap();
    std::fs::write(root.join("berth-dev/.berth/local/hub.json"), "{}").unwrap();
    // 家族 2：没有 hub，主成员取 root。
    std::fs::create_dir_all(root.join("app")).unwrap();
    std::fs::create_dir_all(root.join("app-wt")).unwrap();
    let p = |name: &str| root.join(name).to_string_lossy().into_owned();

    let owner = DataInstance::create_if_missing(dir.path(), RELEASE_DB_FILE_NAME);
    let url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&owner.db_path().to_string_lossy())
    );
    let mut options = ConnectOptions::new(url);
    options.max_connections(1).sqlx_logging(false);
    let conn = Database::connect(options).await.unwrap();
    let index = Migrator::migrations()
        .iter()
        .position(|m| m.name() == PROJECT_MIGRATION)
        .expect("project migration is registered");
    Migrator::up(&conn, Some(index as u32)).await.unwrap();
    let t = "'2026-01-01 00:00:00 +00:00'";
    let pinned = "'2026-02-01 00:00:00 +00:00'";
    conn.execute_unprepared(&format!(
        "INSERT INTO folder (id, name, path, project_runtime_id, last_opened_at, created_at, updated_at, \
         deleted_at, kind, is_open, sort_order, parent_id, alias, pinned_at) VALUES \
         (1, 'berth', '{}', 'u1', {t}, {t}, {t}, NULL, 'regular', 1, 5, NULL, NULL, {pinned}), \
         (2, 'berth-dev', '{}', 'u2', {t}, {t}, {t}, NULL, 'regular', 1, 9, 1, 'berth-dev · 2', NULL), \
         (3, 'app', '{}', 'u3', {t}, {t}, {t}, NULL, 'regular', 1, 2, NULL, 'My app', NULL), \
         (4, 'app-wt', '{}', 'u4', {t}, {t}, {t}, NULL, 'regular', 1, 3, 3, NULL, NULL), \
         (5, 'orphan-wt', '/tmp/berth-migration-orphan', 'u5', {t}, {t}, {t}, NULL, 'regular', 1, 4, 99, NULL, NULL), \
         (6, 'mnt', '/nonexistent/sshfs/remote-device', 'u6', {t}, {t}, {t}, NULL, 'regular', 1, 6, NULL, '远程', NULL), \
         (7, 'forgotten', 'berth-forgotten://x', 'u7', {t}, {t}, {t}, {t}, 'regular', 0, 0, NULL, NULL, NULL), \
         (8, 'Chat', '/tmp/berth-migration-chat', 'u8', {t}, {t}, {t}, NULL, 'chat', 1, 0, NULL, NULL, NULL);",
        p("berth"),
        p("berth-dev"),
        p("app"),
        p("app-wt"),
    ))
    .await
    .unwrap();
    conn.close().await.unwrap();

    let conn = ready(dir.path()).await;
    let folders = folder::Entity::find().all(&conn).await.unwrap();
    let projects = project::Entity::find().all(&conn).await.unwrap();
    assert_eq!(projects.len(), 4, "two families + orphan + remote mount");
    let find = |id: i32| {
        let pid = project_of(&folders, id).expect("live folder has a project");
        projects.iter().find(|p| p.id == pid).unwrap().clone()
    };

    let berth = find(1);
    assert_eq!(
        project_of(&folders, 2),
        Some(berth.id),
        "family shares one project"
    );
    assert_eq!(
        berth.main_folder_id, 2,
        "hub wins over the git main worktree"
    );
    assert_eq!(berth.name, "berth", "name comes from the old root row");
    assert_eq!(berth.sort_order, 5);
    assert!(berth.pinned_at.is_some(), "root pin moves to the project");

    let app = find(3);
    assert_eq!(project_of(&folders, 4), Some(app.id));
    assert_eq!(app.main_folder_id, 3, "no hub: git main worktree is main");
    assert_eq!(app.name, "My app", "root alias becomes the project name");

    let orphan = find(5);
    assert_eq!(
        orphan.main_folder_id, 5,
        "orphan worktree forms its own project"
    );
    let remote = find(6);
    assert_eq!((remote.main_folder_id, remote.name.as_str()), (6, "远程"));
    assert_eq!(
        project_of(&folders, 7),
        None,
        "tombstones belong to no project"
    );
    assert_eq!(
        project_of(&folders, 8),
        None,
        "chat folders belong to no project"
    );

    let columns: Vec<String> = conn
        .query_all(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('folder')".to_owned(),
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get::<String>("", "name").unwrap())
        .collect();
    for gone in [
        "parent_id",
        "alias",
        "pinned_at",
        "sort_order",
        "color",
        "is_open",
    ] {
        assert!(!columns.iter().any(|c| c == gone), "{gone} must be dropped");
    }

    // DTO：每个成员都带同一份项目属性，主成员是 hub。
    let dev = folder_service::get_folder_by_id(&conn, 2)
        .await
        .unwrap()
        .unwrap();
    assert!(dev.is_main());
    let project = dev.project.unwrap();
    assert_eq!((project.name.as_str(), project.main_folder_id), ("berth", 2));
    assert!(project.pinned_at.is_some());
    let main_wt = folder_service::get_folder_by_id(&conn, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(!main_wt.is_main());
    assert_eq!(main_wt.project.unwrap().main_folder_id, 2);
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn opening_a_repo_registers_its_checkouts_as_one_project() {
    let dir = tempfile::tempdir().unwrap();
    let conn = ready(dir.path()).await;
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let dev = dir.path().join("repo-dev");
    git(
        &repo,
        &["worktree", "add", "-q", "-b", "dev", dev.to_str().unwrap()],
    );

    let main = folder_service::open_project(&conn, dev.to_str().unwrap())
        .await
        .unwrap();
    let project_id = main.project_id.unwrap();
    let members = folder_service::list_project_members(&conn, project_id)
        .await
        .unwrap();
    assert_eq!(members.len(), 2);
    let repo_path = std::fs::canonicalize(&repo).unwrap();
    assert_eq!(
        Path::new(&members[0].path),
        repo_path,
        "git main worktree is listed first as main"
    );
    assert_eq!(main.project.as_ref().unwrap().main_folder_id, members[0].id);

    // 同一仓库的新 worktree 打开时并进已有项目。
    let extra = dir.path().join("repo-x");
    git(
        &repo,
        &["worktree", "add", "-q", "-b", "x", extra.to_str().unwrap()],
    );
    let x = folder_service::add_folder(&conn, extra.to_str().unwrap())
        .await
        .unwrap();
    let x_project = folder_service::get_folder_by_id(&conn, x.id)
        .await
        .unwrap()
        .unwrap()
        .project_id;
    assert_ne!(
        x_project,
        Some(project_id),
        "plain add makes its own project"
    );
    folder_service::add_folder_to_project(&conn, extra.to_str().unwrap(), project_id)
        .await
        .unwrap();
    assert!(
        folder_service::get_project(&conn, x_project.unwrap())
            .await
            .unwrap()
            .is_none(),
        "moving the only member deletes the empty project"
    );

    // 忘记主成员：主成员改指仍在的成员；全部忘记后项目删除。
    folder_service::forget_folder(&conn, members[0].id)
        .await
        .unwrap();
    let after = folder_service::get_project(&conn, project_id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(after.main_folder_id, members[0].id);
    for member in folder_service::list_project_members(&conn, project_id)
        .await
        .unwrap()
    {
        folder_service::forget_folder(&conn, member.id)
            .await
            .unwrap();
    }
    assert!(folder_service::get_project(&conn, project_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn git_worktrees_are_hints_until_joined_and_members_can_move() {
    let dir = tempfile::tempdir().unwrap();
    let conn = ready(dir.path()).await;
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let main = folder_service::open_project(&conn, repo.to_str().unwrap())
        .await
        .unwrap();
    let project_id = main.project_id.unwrap();

    // Agent 在 Berth 外用 git 新建 worktree：不登记，只作为未加入的检出提示。
    let wt = dir.path().join("repo-agent");
    git(
        &repo,
        &["worktree", "add", "-q", "-b", "agent", wt.to_str().unwrap()],
    );
    let wt_path = std::fs::canonicalize(&wt).unwrap();
    let members = folder_service::discover_members(&conn, project_id)
        .await
        .unwrap();
    assert_eq!(members.len(), 1);
    let untracked = folder_service::untracked_checkouts(&conn, project_id)
        .await
        .unwrap();
    assert_eq!(untracked.len(), 1);
    assert_eq!(Path::new(&untracked[0].path), wt_path);
    assert_eq!(untracked[0].branch.as_deref(), Some("agent"));

    // 用户加入后是成员，不再提示。
    let joined = folder_service::add_folder_to_project(&conn, &untracked[0].path, project_id)
        .await
        .unwrap();
    let members = folder_service::discover_members(&conn, project_id)
        .await
        .unwrap();
    assert_eq!(members.len(), 2);
    assert!(folder_service::untracked_checkouts(&conn, project_id)
        .await
        .unwrap()
        .is_empty());

    // 别的目录改挂进来：不算失效（失效只看目录在不在）。
    let other = dir.path().join("notes");
    std::fs::create_dir(&other).unwrap();
    let notes = folder_service::add_folder(&conn, other.to_str().unwrap())
        .await
        .unwrap();
    folder_service::add_folder_to_project(&conn, other.to_str().unwrap(), project_id)
        .await
        .unwrap();
    let members = folder_service::discover_members(&conn, project_id)
        .await
        .unwrap();
    assert_eq!(members.len(), 3);
    assert!(members.iter().all(|m| !m.stale));

    // 设主成员。
    folder_service::set_main_member(&conn, notes.id).await.unwrap();
    let project = folder_service::get_project(&conn, project_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(project.main_folder_id, notes.id);
    folder_service::set_main_member(&conn, main.id).await.unwrap();

    // 删除 worktree 后不自动移除，只标失效；主成员不受影响。
    git(&repo, &["worktree", "remove", wt.to_str().unwrap()]);
    let members = folder_service::discover_members(&conn, project_id)
        .await
        .unwrap();
    assert_eq!(members.len(), 3);
    assert!(members.iter().find(|m| m.folder.id == joined.id).unwrap().stale);
    assert!(!members.iter().find(|m| m.folder.id == main.id).unwrap().stale);
}

#[tokio::test]
async fn project_view_is_the_same_from_any_checkout_and_lists_references() {
    let dir = tempfile::tempdir().unwrap();
    let conn = ready(dir.path()).await;
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let wt = dir.path().join("repo-wt");
    git(&repo, &["worktree", "add", "-q", "-b", "wt", wt.to_str().unwrap()]);
    folder_service::open_project(&conn, repo.to_str().unwrap())
        .await
        .unwrap();
    let docs = dir.path().join("docs");
    std::fs::create_dir_all(docs.join("sub")).unwrap();
    let other = folder_service::add_folder(&conn, docs.to_str().unwrap())
        .await
        .unwrap();

    let from_main = folder_service::project_for_dir(&conn, &repo).await.unwrap().unwrap();
    let from_wt = folder_service::project_for_dir(&conn, &wt.join("nested"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(from_main.id, from_wt.id, "worktree resolves to the same project");

    // 同一路径可以是别的项目的成员，也可以进多个项目的参考；重复加入不重复。
    let stored = folder_service::add_reference(&conn, from_main.id, docs.to_str().unwrap())
        .await
        .unwrap();
    folder_service::add_reference(&conn, from_main.id, docs.to_str().unwrap())
        .await
        .unwrap();
    let docs_project = folder_service::get_folder_by_id(&conn, other.id)
        .await
        .unwrap()
        .unwrap()
        .project_id
        .unwrap();
    folder_service::add_reference(&conn, docs_project, wt.to_str().unwrap())
        .await
        .unwrap();
    assert!(folder_service::add_reference(&conn, from_main.id, "/nonexistent/berth-ref")
        .await
        .is_err());

    let view = folder_service::project_view(&conn, &from_main).await.unwrap();
    assert_eq!(view.name, "repo");
    assert_eq!(Path::new(&view.home), std::fs::canonicalize(&repo).unwrap());
    let branches: Vec<_> = view.checkouts.iter().map(|c| (c.main, c.branch.clone())).collect();
    assert_eq!(branches, vec![(true, Some("main".into())), (false, Some("wt".into()))]);
    assert_eq!(view.references.len(), 1);
    assert_eq!(view.references[0].path, stored);

    assert!(folder_service::remove_reference(&conn, from_main.id, docs.to_str().unwrap())
        .await
        .unwrap());
    assert!(!folder_service::remove_reference(&conn, from_main.id, docs.to_str().unwrap())
        .await
        .unwrap());
    assert!(folder_service::project_view(&conn, &from_main)
        .await
        .unwrap()
        .references
        .is_empty());
}
