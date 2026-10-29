//! 项目运行身份回归只使用合成目录与隔离 SQLite，不访问用户实例或 daemon。

use std::fs;

use sea_orm::{ConnectOptions, ConnectionTrait, Database, EntityTrait};
use sea_orm_migration::MigratorTrait;
use berth_project_core::entities::folder;
use berth_project_core::instance::{DataInstance, InstanceState, RELEASE_DB_FILE_NAME};
use berth_project_core::migration::Migrator;
use berth_project_core::open::open_or_upgrade;
use berth_project_core::runtime::{
    classify_session, parse_project_session_key, project_session_key, SessionOwnership,
};
use berth_project_core::service::catalog::{list_catalog, CatalogEntry, CatalogScope};
use berth_project_core::service::folder_service;
use uuid::Uuid;

const NAMESPACE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PROJECT_ID: &str = "12345678-1234-4234-8234-123456789abc";
const IDENTITY_MIGRATION: &str = "m20260926_000001_folder_project_runtime_id";

fn entry() -> CatalogEntry {
    CatalogEntry {
        id: 7,
        path: "/tmp/runtime-identity-project".to_owned(),
        name: "runtime-identity-project".to_owned(),
        is_open: true,
        project_runtime_id: PROJECT_ID.to_owned(),
    }
}

#[test]
fn runtime_identity_key_round_trips_without_session_name_rewriting() {
    let key = project_session_key(NAMESPACE, PROJECT_ID).expect("valid identity");
    assert_eq!(key, format!("berth-project-v1-{NAMESPACE}-{PROJECT_ID}"));
    assert_eq!(key.len(), 118);
    assert!(key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
    let parsed = parse_project_session_key(&key).expect("versioned key");
    assert_eq!(parsed.data_instance_key, NAMESPACE);
    assert_eq!(parsed.project_runtime_id, PROJECT_ID);
}

#[test]
fn runtime_identity_key_rejects_noncanonical_and_unknown_formats() {
    assert!(project_session_key("short", PROJECT_ID).is_err());
    assert!(project_session_key(&NAMESPACE.to_uppercase(), PROJECT_ID).is_err());
    assert!(project_session_key(NAMESPACE, "00000000-0000-0000-0000-000000000000").is_err());
    assert!(project_session_key(NAMESPACE, &PROJECT_ID.to_uppercase()).is_err());
    assert!(project_session_key(NAMESPACE, &PROJECT_ID.replace('-', "")).is_err());

    let valid = project_session_key(NAMESPACE, PROJECT_ID).expect("valid key");
    for invalid in [
        String::new(),
        "7".to_owned(),
        valid.replace("-v1-", "-v2-"),
        valid.replace(NAMESPACE, "short"),
        format!("{valid}-extra"),
        format!(" {valid}"),
        format!("{valid}:0"),
        format!("{valid}\n"),
        format!("berth-project-v1-{}", "界".repeat(40)),
    ] {
        assert!(parse_project_session_key(&invalid).is_none(), "{invalid:?}");
    }
}

#[test]
fn runtime_identity_classification_requires_one_proven_catalog_owner() {
    let catalog = vec![entry()];
    let key = project_session_key(NAMESPACE, PROJECT_ID).expect("key");
    assert_eq!(
        classify_session(&key, NAMESPACE, &catalog),
        SessionOwnership::Project(&catalog[0])
    );
    let other_namespace = "a".repeat(64);
    assert_eq!(
        classify_session(&key, &other_namespace, &catalog),
        SessionOwnership::Foreign
    );
    assert_eq!(
        classify_session(&key, NAMESPACE, &[]),
        SessionOwnership::LegacyUnresolved
    );
    let duplicate = vec![entry(), entry()];
    assert_eq!(
        classify_session(&key, NAMESPACE, &duplicate),
        SessionOwnership::LegacyUnresolved,
        "重复 UUID 不能取第一项"
    );
    for name in ["7", "0007", "berth-project", "berth-project-v2-unknown", ""] {
        assert_eq!(
            classify_session(name, NAMESPACE, &catalog),
            SessionOwnership::LegacyUnresolved,
            "{name:?}"
        );
    }
    for name in ["personal", "scratch", "berth-personal"] {
        assert_eq!(
            classify_session(name, NAMESPACE, &catalog),
            SessionOwnership::Independent
        );
    }
}

#[test]
fn runtime_identity_namespace_uses_canonical_full_database_path() {
    let dir = tempfile::tempdir().expect("fixture directory");
    fs::create_dir(dir.path().join("segment")).expect("path alias segment");
    fs::write(dir.path().join("one.db"), b"synthetic catalog").expect("first file");
    fs::copy(dir.path().join("one.db"), dir.path().join("two.db")).expect("clone file");
    let first = DataInstance::existing_only(dir.path(), "one.db");
    let alias = DataInstance::existing_only(dir.path().join("segment/.."), "one.db");
    let second = DataInstance::existing_only(dir.path(), "two.db");
    let namespace = first.namespace_key().expect("namespace");
    assert_eq!(namespace.len(), 64);
    assert_eq!(namespace, first.namespace_key().expect("stable namespace"));
    assert_eq!(namespace, alias.namespace_key().expect("canonical alias"));
    assert_ne!(
        namespace,
        second.namespace_key().expect("different filename")
    );

    let missing = DataInstance::existing_only(dir.path(), "absent.db");
    assert!(matches!(
        missing.namespace_key(),
        Err(InstanceState::Missing { .. })
    ));
    assert!(!missing.db_path().exists(), "namespace 解析不能建库");
}

#[cfg(unix)]
#[test]
fn runtime_identity_namespace_resolves_directory_and_file_symlinks() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().expect("fixture directory");
    let data_dir = dir.path().join("data");
    fs::create_dir(&data_dir).expect("data directory");
    fs::write(data_dir.join("real.db"), b"synthetic catalog").expect("db placeholder");
    symlink(&data_dir, dir.path().join("alias")).expect("directory alias");
    symlink(data_dir.join("real.db"), dir.path().join("alias.db")).expect("file alias");
    let real = DataInstance::existing_only(&data_dir, "real.db");
    let directory_alias = DataInstance::existing_only(dir.path().join("alias"), "real.db");
    let file_alias = DataInstance::existing_only(dir.path(), "alias.db");
    let namespace = real.namespace_key().expect("real namespace");
    assert_eq!(
        namespace,
        directory_alias.namespace_key().expect("directory alias")
    );
    assert_eq!(namespace, file_alias.namespace_key().expect("file alias"));
}

#[cfg(unix)]
#[test]
fn runtime_identity_namespace_preserves_non_utf8_path_bytes() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let dir = tempfile::tempdir().expect("fixture directory");
    let first_path = dir.path().join(OsString::from_vec(b"data-\xfe".to_vec()));
    let second_path = dir.path().join(OsString::from_vec(b"data-\xff".to_vec()));
    fs::create_dir(&first_path).expect("first non-UTF8 directory");
    fs::create_dir(&second_path).expect("second non-UTF8 directory");
    for path in [&first_path, &second_path] {
        fs::write(path.join("catalog.db"), b"synthetic catalog").expect("db placeholder");
    }
    assert_eq!(first_path.to_string_lossy(), second_path.to_string_lossy());
    let first = DataInstance::existing_only(first_path, "catalog.db");
    let second = DataInstance::existing_only(second_path, "catalog.db");
    assert_ne!(
        first.namespace_key().expect("first namespace"),
        second.namespace_key().expect("second namespace"),
        "namespace 不得用 lossy 路径文本合并不同实例"
    );
}

#[tokio::test]
async fn runtime_identity_upgrade_backfills_and_read_only_refuses_without_writes() {
    let dir = tempfile::tempdir().expect("fixture directory");
    let owner = DataInstance::create_if_missing(dir.path(), RELEASE_DB_FILE_NAME);
    let url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&owner.db_path().to_string_lossy())
    );
    let mut options = ConnectOptions::new(url);
    options.max_connections(1).sqlx_logging(false);
    let conn = Database::connect(options).await.expect("fixture writer");
    let migrations = Migrator::migrations();
    let index = migrations
        .iter()
        .position(|migration| migration.name() == IDENTITY_MIGRATION)
        .expect("identity migration is registered");
    Migrator::up(&conn, Some(index as u32))
        .await
        .expect("legacy schema");
    conn.execute_unprepared(
        "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at, kind, is_open) VALUES \
         (1, 'legacy', '/tmp/legacy', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'regular', 1), \
         (2, 'Chat', '/tmp/chat', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'chat', 1);",
    )
    .await
    .expect("legacy folders");
    conn.close().await.expect("close legacy fixture");
    let before = fs::read(owner.db_path()).expect("legacy bytes");
    let reader = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    for _ in 0..2 {
        let (conn, state) = open_or_upgrade(&reader).await;
        assert!(conn.is_none());
        assert_eq!(
            state,
            InstanceState::UpgradeRequired {
                pending: migrations.len() - index
            }
        );
        assert_eq!(fs::read(reader.db_path()).expect("unchanged bytes"), before);
    }

    let (conn, state) = open_or_upgrade(&owner).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("upgraded writer");
    let rows = folder::Entity::find()
        .all(&conn)
        .await
        .expect("backfilled rows");
    assert_eq!(rows.len(), 2);
    for row in &rows {
        let id = Uuid::parse_str(&row.project_runtime_id).expect("UUID backfill");
        assert_eq!(id.get_version_num(), 4);
    }
    assert_ne!(rows[0].project_runtime_id, rows[1].project_runtime_id);
    for statement in [
        "UPDATE folder SET project_runtime_id = NULL WHERE id = 1",
        "UPDATE folder SET project_runtime_id = '' WHERE id = 1",
        "UPDATE folder SET project_runtime_id = (SELECT project_runtime_id FROM folder WHERE id = 2) WHERE id = 1",
    ] {
        conn.execute_unprepared(statement).await.expect_err("identity constraint");
    }
    let catalog = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("catalog");
    assert_eq!(catalog.len(), 1, "chat 仍隐藏");
    assert_eq!(catalog[0].id, 1);
    let preserved = catalog[0].project_runtime_id.clone();
    conn.close().await.expect("close owner");

    let (conn, state) = open_or_upgrade(&reader).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("read-only catalog");
    let reopened = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("reopened catalog");
    assert_eq!(reopened[0].project_runtime_id, preserved);
    conn.execute_unprepared("UPDATE folder SET name = 'wrong'")
        .await
        .expect_err("ready connection remains read-only");
    conn.close().await.expect("close reader");
}

#[tokio::test]
async fn runtime_identity_service_preserves_identity_and_hides_it_from_folder_json() {
    let dir = tempfile::tempdir().expect("fixture directory");
    let instance = DataInstance::create_if_missing(dir.path(), RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&instance).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("writer");
    let first = folder_service::add_folder(&conn, "/tmp/runtime-a")
        .await
        .expect("first project");
    let second = folder_service::add_folder(&conn, "/tmp/runtime-b")
        .await
        .expect("second project");
    let chat = folder_service::add_chat_folder(&conn, "/tmp/runtime-chat")
        .await
        .expect("chat");
    let before = folder_service::get_folder_by_id(&conn, first.id)
        .await
        .expect("lookup")
        .expect("first detail");
    let other = folder_service::get_folder_by_id(&conn, second.id)
        .await
        .expect("lookup")
        .expect("second detail");
    let identities = [
        &before.project_runtime_id,
        &other.project_runtime_id,
        &chat.project_runtime_id,
    ];
    for identity in identities {
        assert_eq!(
            Uuid::parse_str(identity)
                .expect("new UUID")
                .get_version_num(),
            4
        );
    }
    assert_ne!(before.project_runtime_id, other.project_runtime_id);
    assert_ne!(before.project_runtime_id, chat.project_runtime_id);
    assert_ne!(other.project_runtime_id, chat.project_runtime_id);
    folder_service::remove_folder(&conn, "/tmp/runtime-a")
        .await
        .expect("soft delete");
    folder_service::add_folder(&conn, "/tmp/runtime-a")
        .await
        .expect("reopen");
    let after = folder_service::get_folder_by_id(&conn, first.id)
        .await
        .expect("lookup")
        .expect("reopened detail");
    assert_eq!(before.project_runtime_id, after.project_runtime_id);
    let json = serde_json::to_value(&after).expect("folder wire projection");
    assert!(
        json.get("project_runtime_id").is_none(),
        "GUI DTO 保持原字段"
    );
    let catalog = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("catalog");
    assert_eq!(catalog.len(), 2);
    assert_eq!(
        catalog
            .iter()
            .find(|entry| entry.id == first.id)
            .expect("first")
            .project_runtime_id,
        before.project_runtime_id
    );
    conn.close().await.expect("close writer");
}

#[tokio::test]
async fn runtime_identity_cloned_catalog_is_foreign_despite_equal_id_uuid_and_cwd() {
    let source = tempfile::tempdir().expect("source fixture");
    let clone = tempfile::tempdir().expect("cloned fixture");
    let owner = DataInstance::create_if_missing(source.path(), RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&owner).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("source writer");
    folder_service::add_folder(&conn, "/tmp/shared-cwd")
        .await
        .expect("project");
    let original = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("original catalog");
    // 克隆夹具前显式把已提交 WAL 落入主库，不能靠连接池关闭时机假定已 checkpoint。
    conn.execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)")
        .await
        .expect("checkpoint fixture before copying");
    conn.close().await.expect("close source fixture");
    let cloned = DataInstance::existing_only(clone.path(), RELEASE_DB_FILE_NAME);
    fs::copy(owner.db_path(), cloned.db_path()).expect("clone complete catalog");
    let (conn, state) = open_or_upgrade(&cloned).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("cloned reader");
    let copied = list_catalog(&conn, CatalogScope::All)
        .await
        .expect("cloned catalog");
    assert_eq!(original, copied, "ID、UUID、cwd 随库复制");
    let original_namespace = owner.namespace_key().expect("original namespace");
    let cloned_namespace = cloned.namespace_key().expect("cloned namespace");
    assert_ne!(original_namespace, cloned_namespace);
    let key =
        project_session_key(&original_namespace, &original[0].project_runtime_id).expect("key");
    assert_eq!(
        classify_session(&key, &original_namespace, &original),
        SessionOwnership::Project(&original[0])
    );
    assert_eq!(
        classify_session(&key, &cloned_namespace, &copied),
        SessionOwnership::Foreign
    );
    conn.close().await.expect("close clone reader");
}
