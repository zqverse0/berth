//! 迁移/开库切口的状态语义测试。
//!
//! 覆盖：缺库、坏库、旧 schema、跨版本 schema、pending restore 标记、
//! 两个 DATA_DIR fixture 的项目投影一致性与隔离。

use std::fs;
use std::path::Path;

use sea_orm::{ConnectOptions, ConnectionTrait, Database, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;
use berth_project_core::instance::{DataInstance, InstanceState, RELEASE_DB_FILE_NAME};
use berth_project_core::migration::Migrator;
use berth_project_core::open::open_or_upgrade;
use berth_project_core::service::folder_service;

async fn seed_projects(data_dir: &Path, names: &[&str]) {
    // 建库动作只能由桌面宿主的策略（CreateIfMissing）完成；CLI 只读策略不建库。
    let instance = DataInstance::create_if_missing(data_dir, RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&instance).await;
    assert_eq!(state, InstanceState::Ready, "instance must be ready");
    let conn = conn.expect("ready connection");
    for name in names {
        folder_service::add_folder(&conn, &format!("/tmp/{name}"))
            .await
            .expect("seed folder");
    }
    conn.close().await.expect("close seed connection");
}

async fn list_project_names(instance: &DataInstance) -> Vec<String> {
    let (conn, state) = open_or_upgrade(instance).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("ready connection");
    let mut names: Vec<String> = folder_service::list_all_folder_details(&conn)
        .await
        .expect("list folders")
        .into_iter()
        .map(|detail| detail.name)
        .collect();
    names.sort();
    conn.close().await.expect("close reader");
    names
}

/// AC-032：只读策略下缺库报「实例不可用」，且不创建任何库文件。
#[tokio::test]
async fn missing_database_reports_unavailable_without_creating_it() {
    let dir = tempfile::tempdir().expect("dir");
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(conn.is_none());
    assert_eq!(
        state,
        InstanceState::Missing {
            db_path: dir.path().join(RELEASE_DB_FILE_NAME)
        }
    );
    assert_eq!(state.kind(), "instance_unavailable");
    assert!(!instance.db_path().exists(), "只读查询不得建库");
}

/// AC-HC-002：损坏的库文件必须给出非空错误状态，不得伪装成空目录。
#[tokio::test]
async fn corrupt_database_reports_incompatible() {
    let dir = tempfile::tempdir().expect("dir");
    fs::write(
        dir.path().join(RELEASE_DB_FILE_NAME),
        b"not a sqlite database",
    )
    .expect("write corrupt db");
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(conn.is_none());
    assert!(!state.is_ready());
    assert!(matches!(state, InstanceState::Incompatible { .. }));
    assert_eq!(state.kind(), "instance_incompatible");
}

/// AC-HC-006：未完成的 restore 标记必须阻塞读取，并指向 GUI 完成恢复。
#[tokio::test]
async fn pending_restore_marker_blocks_reading() {
    let dir = tempfile::tempdir().expect("dir");
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    fs::write(instance.restore_marker_path(), b"{}").expect("marker");
    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(conn.is_none());
    assert!(matches!(state, InstanceState::PendingRestore { .. }));
    assert_eq!(state.kind(), "instance_pending_restore");
    assert!(state.message().contains("GUI"));
}

/// 旧 schema：由承担迁移职责的一方（GUI，`CreateIfMissing`）升级后可读；
/// 只读入口（CLI）**不得**就地升级，报 `UpgradeRequired` 并指向 GUI。
#[tokio::test]
async fn older_schema_is_upgraded_by_the_owner_and_refused_by_read_only_open() {
    let dir = tempfile::tempdir().expect("dir");
    let db_path = dir.path().join(RELEASE_DB_FILE_NAME);
    let url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&db_path.to_string_lossy())
    );
    {
        let mut opts = ConnectOptions::new(url);
        opts.max_connections(1).sqlx_logging(false);
        let conn = Database::connect(opts).await.expect("open partial db");
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA foreign_keys=ON;".to_owned(),
        ))
        .await
        .expect("pragma");
        // 只跑前 3 条迁移：模拟旧实例。
        Migrator::up(&conn, Some(3)).await.expect("partial migrate");
        // cutoff=3 时 folder 只有 init + is_open 的列（sort_order/color/kind 由后续迁移补齐）。
        let folder_cols = "(id, name, path, last_opened_at, created_at, updated_at, is_open)";
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            format!(
                "INSERT INTO folder {folder_cols} VALUES \
                 (1, 'legacy', '/tmp/legacy', '2026-01-01 00:00:00', '2026-01-01 00:00:00', \
                  '2026-01-01 00:00:00', 1)"
            ),
        ))
        .await
        .expect("seed legacy folder");
        conn.close().await.expect("close partial db");
    }

    // 只读入口（CLI）不写库：报「需 GUI 完成升级」。
    let read_only = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&read_only).await;
    assert!(
        conn.is_none(),
        "read-only open must not hand out a connection"
    );
    assert!(
        matches!(state, InstanceState::UpgradeRequired { .. }),
        "expected upgrade_required, got {state:?}"
    );

    // 承担迁移职责的一方开库后，旧 schema 被升级，旧数据仍在。
    let owner = DataInstance::create_if_missing(dir.path(), RELEASE_DB_FILE_NAME);
    assert_eq!(list_project_names(&owner).await, vec!["legacy".to_owned()]);
}

/// 跨版本 schema（本构建不认识的迁移记录）报 `Incompatible`，不静默继续。
#[tokio::test]
async fn newer_schema_reports_incompatible() {
    let dir = tempfile::tempdir().expect("dir");
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    seed_projects(dir.path(), &["alpha"]).await;

    {
        // 注入未来迁移是夹具写入，不能借用生产只读策略。
        let owner = DataInstance::create_if_missing(dir.path(), RELEASE_DB_FILE_NAME);
        let (conn, state) = open_or_upgrade(&owner).await;
        assert_eq!(state, InstanceState::Ready);
        let conn = conn.expect("ready connection");
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            "INSERT INTO seaql_migrations (version, applied_at) VALUES ('m99999999_000001_from_the_future', 0)"
                .to_owned(),
        ))
        .await
        .expect("inject future migration");
        conn.close().await.expect("close");
    }

    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(conn.is_none());
    match &state {
        InstanceState::Incompatible { detail } => {
            assert!(detail.contains("from_the_future"), "detail: {detail}")
        }
        other => panic!("expected incompatible, got {other:?}"),
    }
}

/// AC-HC-001 / AC-HC-003：同一 crate 的同一投影在两个 DATA_DIR fixture 上
/// 各列出自己的项目（3 个项目、0 个终端；互不读取对方库）。
#[tokio::test]
async fn two_data_dirs_project_their_own_projects() {
    let first = tempfile::tempdir().expect("first dir");
    let second = tempfile::tempdir().expect("second dir");
    let first_instance = DataInstance::existing_only(first.path(), RELEASE_DB_FILE_NAME);
    let second_instance = DataInstance::existing_only(second.path(), RELEASE_DB_FILE_NAME);

    seed_projects(first.path(), &["alpha", "beta", "gamma"]).await;
    seed_projects(second.path(), &["delta"]).await;

    assert_eq!(
        list_project_names(&first_instance).await,
        vec!["alpha".to_owned(), "beta".to_owned(), "gamma".to_owned()]
    );
    assert_eq!(
        list_project_names(&second_instance).await,
        vec!["delta".to_owned()]
    );
}

/// 只读策略（CLI）绝不写库：schema 落后本构建时报 `UpgradeRequired` 并指向 GUI，
/// 既不就地迁移，也不 install 迁移记录表，库文件字节不变。
#[tokio::test]
async fn read_only_open_refuses_to_upgrade_and_touches_nothing() {
    let dir = tempfile::tempdir().expect("dir");
    let owner = DataInstance::create_if_missing(dir.path(), RELEASE_DB_FILE_NAME);
    let (conn, state) = open_or_upgrade(&owner).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("ready connection");

    // schema 已最新时只读入口照常可用。
    let read_only = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let (conn_read_only, state) = open_or_upgrade(&read_only).await;
    assert_eq!(state, InstanceState::Ready);
    conn_read_only
        .expect("ready connection")
        .close()
        .await
        .expect("close");

    // 让本库对本构建落后一条：只删迁移记录（库结构不动，语义足够）。
    let last = <Migrator as MigratorTrait>::migrations()
        .last()
        .expect("at least one migration")
        .name()
        .to_owned();
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        format!("DELETE FROM seaql_migrations WHERE version = '{last}'"),
    ))
    .await
    .expect("mark the last migration as pending");
    // 把这次写入落到主库，避免把后续读连接触发的 WAL 检查点误判成「只读查询写了库」。
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA wal_checkpoint(TRUNCATE);".to_owned(),
    ))
    .await
    .expect("checkpoint");
    conn.close().await.expect("close");

    let before = fs::read(owner.db_path()).expect("read db before");
    let (conn, state) = open_or_upgrade(&read_only).await;
    assert!(
        conn.is_none(),
        "read-only open must not hand out a connection"
    );
    assert_eq!(state, InstanceState::UpgradeRequired { pending: 1 });
    assert_eq!(state.kind(), "instance_upgrade_required");
    assert!(
        state.message().contains("start the Berth GUI"),
        "message must point at the next step: {}",
        state.message()
    );
    assert_eq!(
        fs::read(owner.db_path()).expect("read db after"),
        before,
        "只读查询不得修改数据库"
    );

    // 仍然报同一条待迁移：说明没有被就地升级。
    let (_, state) = open_or_upgrade(&read_only).await;
    assert_eq!(state, InstanceState::UpgradeRequired { pending: 1 });
}

/// 非 WAL、未安装迁移表的库也必须保持原样，不能先切换日志模式再拒绝升级。
#[tokio::test]
async fn read_only_delete_mode_without_migrations_stays_unchanged() {
    let dir = tempfile::tempdir().expect("dir");
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let conn = fixture_connection(&instance).await;
    conn.execute_unprepared("CREATE TABLE audit_fixture (id INTEGER PRIMARY KEY)")
        .await
        .expect("seed nonempty database");
    conn.close().await.expect("close fixture");
    let before = fs::read(instance.db_path()).expect("before");
    assert_eq!(&before[18..20], &[1, 1], "fixture must use DELETE mode");

    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(conn.is_none());
    assert!(matches!(state, InstanceState::UpgradeRequired { .. }));
    assert_eq!(fs::read(instance.db_path()).expect("after"), before);
}

/// 未知 schema 的拒绝路径同样不得修改库头。
#[tokio::test]
async fn read_only_unknown_schema_stays_unchanged() {
    let dir = tempfile::tempdir().expect("dir");
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let conn = fixture_connection(&instance).await;
    conn.execute_unprepared(
        "CREATE TABLE seaql_migrations (version TEXT PRIMARY KEY, applied_at INTEGER); \
         INSERT INTO seaql_migrations VALUES ('future_schema', 0)",
    )
    .await
    .expect("seed future schema");
    conn.close().await.expect("close fixture");
    let before = fs::read(instance.db_path()).expect("before");

    let (conn, state) = open_or_upgrade(&instance).await;
    assert!(conn.is_none());
    assert!(matches!(state, InstanceState::Incompatible { .. }));
    assert_eq!(fs::read(instance.db_path()).expect("after"), before);
}

/// Ready 不得返回可写连接；DELETE 模式和只读文件也必须能读。
#[tokio::test]
async fn read_only_ready_connection_rejects_writes() {
    let dir = tempfile::tempdir().expect("dir");
    seed_projects(dir.path(), &["alpha"]).await;
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let fixture = fixture_connection(&instance).await;
    fixture
        .execute_unprepared("PRAGMA journal_mode=DELETE")
        .await
        .expect("switch fixture to DELETE");
    fixture.close().await.expect("close fixture");
    let before = fs::read(instance.db_path()).expect("before");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(instance.db_path(), fs::Permissions::from_mode(0o444))
            .expect("make database file read-only");
    }

    let (conn, state) = open_or_upgrade(&instance).await;
    assert_eq!(state, InstanceState::Ready);
    let conn = conn.expect("ready connection");
    let projects = folder_service::list_all_folder_details(&conn)
        .await
        .expect("read");
    assert_eq!(projects[0].name, "alpha");
    let error = conn
        .execute_unprepared("UPDATE folder SET name = 'wrong'")
        .await
        .expect_err("read-only connection must reject writes");
    assert!(error.to_string().contains("readonly"), "{error}");
    conn.close().await.expect("close reader");
    assert_eq!(fs::read(instance.db_path()).expect("after"), before);
}

/// 不能用 immutable 绕过锁：共享库的只读查询必须看见已提交、尚未 checkpoint 的 WAL。
#[tokio::test]
async fn read_only_observes_live_wal_without_checkpointing() {
    let dir = tempfile::tempdir().expect("dir");
    seed_projects(dir.path(), &["alpha"]).await;
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    let writer = fixture_connection(&instance).await;
    writer
        .execute_unprepared("PRAGMA wal_autocheckpoint=0")
        .await
        .expect("disable fixture checkpoint");
    folder_service::add_folder(&writer, "/tmp/beta")
        .await
        .expect("commit to WAL");
    let before = fs::read(instance.db_path()).expect("before");
    let wal_path = instance.db_path().with_file_name("berth.db-wal");
    let wal_before = fs::read(&wal_path).expect("live WAL");
    assert!(wal_before.len() > 32, "WAL must contain committed frames");

    let (reader, state) = open_or_upgrade(&instance).await;
    assert_eq!(state, InstanceState::Ready);
    let reader = reader.expect("reader");
    let error = reader
        .execute_unprepared("UPDATE folder SET name = 'wrong'")
        .await
        .expect_err("even a writable file must be opened read-only");
    assert!(error.to_string().contains("readonly"), "{error}");
    reader.close().await.expect("close reader");
    assert_eq!(list_project_names(&instance).await, vec!["alpha", "beta"]);
    assert_eq!(fs::read(instance.db_path()).expect("after"), before);
    assert_eq!(fs::read(wal_path).expect("WAL after"), wal_before);
    writer.close().await.expect("close writer");
}

/// 测试夹具写入口，不通过被测只读连接准备数据。
async fn fixture_connection(instance: &DataInstance) -> sea_orm::DatabaseConnection {
    let url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&instance.db_path().to_string_lossy())
    );
    let mut options = ConnectOptions::new(url);
    options.max_connections(1).sqlx_logging(false);
    Database::connect(options)
        .await
        .expect("fixture connection")
}
