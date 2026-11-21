//! 项目目录投影（GUI control 与 CLI 消费的同一判据）语义测试。
//!
//! 覆盖：`scope=all` 含目录已不在的已注册项目、隐藏 chat scratch folder、
//! `scope=open` 只返回目录仍在的项目，以及 `is_open` 由打开集合投影得出。

use std::path::Path;

use berth_project_core::instance::{DataInstance, InstanceState, RELEASE_DB_FILE_NAME};
use berth_project_core::open::open_or_upgrade;
use berth_project_core::service::catalog::{list_catalog, CatalogEntry, CatalogScope};
use berth_project_core::service::folder_service;
use sea_orm::{DatabaseConnection, EntityTrait};

async fn ready_instance(data_dir: &Path) -> DatabaseConnection {
    let instance = DataInstance::create_if_missing(data_dir, RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&instance).await;
    assert_eq!(state, InstanceState::Ready, "instance must be ready");
    conn.expect("ready connection")
}

/// 打开列表只列仍存在的目录，测试项目要有真实目录。
fn project_dir(root: &Path, name: &str) -> String {
    let path = root.join("projects").join(name);
    std::fs::create_dir_all(&path).expect("project dir");
    path.to_string_lossy().into_owned()
}

fn names(entries: &[CatalogEntry]) -> Vec<String> {
    entries.iter().map(|entry| entry.name.clone()).collect()
}

fn find<'a>(entries: &'a [CatalogEntry], name: &str) -> &'a CatalogEntry {
    entries
        .iter()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("entry {name} missing"))
}

/// scope=all：目录已不在的已注册项目仍可见（不算打开），chat scratch folder 不出现。
#[tokio::test]
async fn all_scope_keeps_closed_projects_and_hides_chat() {
    let dir = tempfile::tempdir().expect("dir");
    let conn = ready_instance(dir.path()).await;

    let alpha_dir = project_dir(dir.path(), "alpha");
    folder_service::add_folder(&conn, &alpha_dir)
        .await
        .expect("alpha");
    folder_service::add_folder(&conn, &project_dir(dir.path(), "beta"))
        .await
        .expect("beta");
    std::fs::remove_dir(&alpha_dir).expect("remove alpha dir");
    folder_service::add_chat_folder(&conn, &project_dir(dir.path(), "chat-scratch"))
        .await
        .expect("chat folder");

    let all = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("catalog");
    let mut sorted = names(&all);
    sorted.sort();
    assert_eq!(sorted, vec!["alpha".to_string(), "beta".to_string()]);
    assert!(!find(&all, "alpha").is_open, "closed project is not open");
    assert!(find(&all, "beta").is_open, "opened project is open");
}

/// scope=open：只返回打开的常规项目，且 `is_open` 恒为真。
#[tokio::test]
async fn open_scope_returns_only_open_projects() {
    let dir = tempfile::tempdir().expect("dir");
    let conn = ready_instance(dir.path()).await;

    // 打开列表只列仍存在的目录：用真实目录，另加一个已不存在的。
    folder_service::add_folder(&conn, &project_dir(dir.path(), "beta"))
        .await
        .expect("beta");
    folder_service::add_folder(&conn, "/tmp/berth-catalog-test-gone")
        .await
        .expect("gone");
    folder_service::add_chat_folder(&conn, &project_dir(dir.path(), "chat-scratch"))
        .await
        .expect("chat folder");

    let open = list_catalog(&conn, CatalogScope::Open)
        .await
        .expect("catalog");
    assert_eq!(names(&open), vec!["beta".to_string()]);
    assert!(open[0].is_open);
}

#[tokio::test]
async fn forgetting_a_project_removes_its_path_and_readd_creates_new_identity() {
    let dir = tempfile::tempdir().expect("dir");
    let conn = ready_instance(dir.path()).await;
    let path = "/tmp/forget-project";
    let old = folder_service::add_folder(&conn, path)
        .await
        .expect("add old");
    let old_runtime_id = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("catalog before forget")
        .into_iter()
        .find(|entry| entry.id == old.id)
        .expect("old registration")
        .project_runtime_id;

    let forgotten_path = folder_service::forget_folder(&conn, old.id)
        .await
        .expect("forget old");

    assert_eq!(forgotten_path, path);
    assert!(!list_catalog(&conn, CatalogScope::All)
        .await
        .expect("catalog after forget")
        .iter()
        .any(|entry| entry.path == path));

    let new = folder_service::add_folder(&conn, path)
        .await
        .expect("re-add");
    assert_ne!(new.id, old.id);

    let catalog = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("catalog after re-add");
    let entry = catalog
        .iter()
        .find(|entry| entry.id == new.id)
        .expect("new registration");
    assert_ne!(entry.project_runtime_id, old_runtime_id);

    let rows = berth_project_core::entities::folder::Entity::find()
        .all(&conn)
        .await
        .expect("folder rows");
    let forgotten = rows
        .iter()
        .find(|row| row.id == old.id)
        .expect("foreign-key anchor");
    assert_eq!(forgotten.name, "forgotten");
    assert!(forgotten.deleted_at.is_some());
    assert_ne!(forgotten.project_runtime_id, old_runtime_id);
    assert!(
        rows.iter().all(|row| row.path != path || row.id == new.id),
        "the forgotten project path must not remain in Berth's folder records"
    );
}

#[tokio::test]
async fn retire_closed_migration_leaves_only_registered_projects() {
    use berth_project_core::migration::Migrator;
    use sea_orm::{ConnectOptions, ConnectionTrait, Database};
    use sea_orm_migration::MigratorTrait;

    let dir = tempfile::tempdir().expect("fixture directory");
    let owner = DataInstance::create_if_missing(dir.path(), RELEASE_DB_FILE_NAME);
    let url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&owner.db_path().to_string_lossy())
    );
    let mut options = ConnectOptions::new(url);
    options.max_connections(1).sqlx_logging(false);
    let conn = Database::connect(options).await.expect("fixture writer");
    let index = Migrator::migrations()
        .iter()
        .position(|m| m.name() == "m20260930_000001_folder_retire_closed")
        .expect("retire migration is registered");
    Migrator::up(&conn, Some(index as u32))
        .await
        .expect("pre-retire schema");
    conn.execute_unprepared(
        "INSERT INTO folder (id, name, path, project_runtime_id, last_opened_at, created_at, updated_at, kind, is_open, parent_id) VALUES \
         (1, 'open', '/tmp/open', 'a', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'regular', 1, NULL), \
         (2, 'open-wt', '/tmp/open-wt', 'b', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'regular', 1, 1), \
         (3, 'closed', '/tmp/closed', 'c', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'regular', 0, NULL), \
         (4, 'orphan-wt', '/tmp/orphan-wt', 'd', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'regular', 1, 3), \
         (5, 'Chat', '/tmp/chat', 'e', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'chat', 0, NULL);",
    )
    .await
    .expect("seed folders");
    conn.close().await.expect("close fixture");

    let conn = ready_instance(dir.path()).await;
    let all = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("catalog");
    let mut kept = names(&all);
    kept.sort();
    assert_eq!(kept, vec!["open".to_string(), "open-wt".to_string()]);
    // 被退休的原路径可以重新注册为新项目。
    let readded = folder_service::add_folder(&conn, "/tmp/closed")
        .await
        .expect("re-add retired path");
    assert_ne!(readded.id, 3);
}

/// 同名项目新建时项目名加 ` · <folder id>` 区分；用户改过的名字重开不被覆盖。
#[tokio::test]
async fn same_named_projects_get_distinct_editable_names() {
    let dir = tempfile::tempdir().unwrap();
    let conn = ready_instance(dir.path()).await;
    let alias = |id| {
        let conn = &conn;
        async move {
            folder_service::get_folder_by_id(conn, id)
                .await
                .unwrap()
                .unwrap()
                .project
                .unwrap()
                .name
        }
    };
    let first = folder_service::add_folder(&conn, "/tmp/one/berth-dev")
        .await
        .unwrap();
    let second = folder_service::add_folder(&conn, "/tmp/two/berth-dev")
        .await
        .unwrap();
    assert_eq!(alias(first.id).await, "berth-dev", "first keeps the directory name");
    assert_eq!(alias(second.id).await, format!("berth-dev · {}", second.id));
    folder_service::update_folder_alias(&conn, first.id, Some("My dev".into()), true, None)
        .await
        .unwrap();
    folder_service::add_folder(&conn, "/tmp/one/berth-dev")
        .await
        .unwrap();
    assert_eq!(alias(first.id).await, "My dev");
    // 清空名称恢复为主成员目录名。
    folder_service::update_folder_alias(&conn, first.id, None, true, None)
        .await
        .unwrap();
    assert_eq!(alias(first.id).await, "berth-dev");
}

#[cfg(unix)]
#[tokio::test]
async fn reopening_moved_folder_through_symlink_preserves_identity() {
    use berth_project_core::entities::folder;
    use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().expect("dir");
    let conn = ready_instance(dir.path()).await;
    let old = dir.path().join("old-worktree");
    let new = dir.path().join("renamed-worktree");
    std::fs::create_dir(&old).unwrap();
    let original = folder_service::add_folder(&conn, old.to_str().unwrap())
        .await
        .unwrap();
    let identity = folder::Entity::find_by_id(original.id)
        .one(&conn)
        .await
        .unwrap()
        .unwrap();
    std::fs::rename(&old, &new).unwrap();
    symlink(&new, &old).unwrap();

    let reopened = folder_service::add_folder(&conn, old.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(reopened.id, original.id);
    assert_eq!(reopened.path, new.to_str().unwrap());
    assert_eq!(reopened.name, "renamed-worktree");
    let real = folder_service::add_folder(&conn, new.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(real.id, original.id);
    let row = folder::Entity::find_by_id(real.id)
        .one(&conn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.project_runtime_id, identity.project_runtime_id);
    assert_eq!(
        list_catalog(&conn, CatalogScope::All).await.unwrap().len(),
        1
    );

    // 模拟遗留软链路径：登记进项目的写入入口也必须迁移同一身份。
    let mut legacy = row.into_active_model();
    legacy.path = Set(old.to_str().unwrap().to_owned());
    legacy.update(&conn).await.unwrap();
    let other = folder_service::add_folder(&conn, &project_dir(dir.path(), "other"))
        .await
        .unwrap();
    let other_project = folder_service::get_folder_by_id(&conn, other.id)
        .await
        .unwrap()
        .unwrap()
        .project_id
        .unwrap();
    let child = folder_service::add_folder_to_project(&conn, new.to_str().unwrap(), other_project)
        .await
        .unwrap();
    assert_eq!(child.id, original.id);
    assert_eq!(
        folder_service::get_folder_by_id(&conn, child.id)
            .await
            .unwrap()
            .unwrap()
            .project
            .map(|p| p.main_folder_id),
        Some(other.id)
    );
}
