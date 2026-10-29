//! 数据实例解析的聚焦测试（父任务 design §4.1 决策表）。
//!
//! 全部用例使用隔离的临时数据根，不触碰用户 `~/.berth` 与 `~/.berth-dev`。

use std::fs;
use std::path::Path;

use berth_project_core::instance::{
    self, BuildInstance, DataInstance, InstanceAccess, InstanceState, DATA_DIR_ENV, DATA_FILE_ENV,
    DEV_DB_FILE_NAME, RELEASE_DB_FILE_NAME,
};

fn touch(path: &Path) {
    fs::write(path, b"").expect("touch db file");
}

#[test]
fn dev_and_release_defaults_are_distinct() {
    let dev = instance::default_data_dir(BuildInstance::Dev);
    let release = instance::default_data_dir(BuildInstance::Release);
    assert!(dev.to_string_lossy().ends_with(".berth-dev"));
    assert!(release.to_string_lossy().ends_with("app.berth"));
    assert_eq!(BuildInstance::Dev.default_db_file_name(), DEV_DB_FILE_NAME);
    assert_eq!(
        BuildInstance::Release.default_db_file_name(),
        RELEASE_DB_FILE_NAME
    );
}

/// 两个 DATA_DIR fixture 相互隔离：显式目录只按目录内实际存在的库判定。
#[test]
fn explicit_data_dirs_resolve_their_own_database_file() {
    let dev_dir = tempfile::tempdir().expect("dev dir");
    let release_dir = tempfile::tempdir().expect("release dir");
    touch(&dev_dir.path().join(DEV_DB_FILE_NAME));
    touch(&release_dir.path().join(RELEASE_DB_FILE_NAME));

    let dev = instance::resolve(
        BuildInstance::Release,
        InstanceAccess::ExistingOnly,
        Some(dev_dir.path().to_path_buf()),
        None,
    )
    .expect("dev instance");
    assert_eq!(dev.db_file_name(), DEV_DB_FILE_NAME);
    assert_eq!(dev.data_dir(), dev_dir.path());

    let release = instance::resolve(
        BuildInstance::Dev,
        InstanceAccess::ExistingOnly,
        Some(release_dir.path().to_path_buf()),
        None,
    )
    .expect("release instance");
    assert_eq!(release.db_file_name(), RELEASE_DB_FILE_NAME);
    assert_eq!(release.data_dir(), release_dir.path());
}

#[test]
fn two_databases_in_one_directory_are_ambiguous() {
    let dir = tempfile::tempdir().expect("dir");
    touch(&dir.path().join(RELEASE_DB_FILE_NAME));
    touch(&dir.path().join(DEV_DB_FILE_NAME));

    let error = instance::resolve(
        BuildInstance::Dev,
        InstanceAccess::ExistingOnly,
        Some(dir.path().to_path_buf()),
        None,
    )
    .expect_err("ambiguous");
    assert_eq!(
        error,
        InstanceState::Ambiguous {
            candidates: vec![RELEASE_DB_FILE_NAME.to_owned(), DEV_DB_FILE_NAME.to_owned()]
        }
    );
    assert_eq!(error.kind(), "instance_ambiguous");
    assert!(error.message().contains("BERTH_DATA_FILE"));
}

#[test]
fn explicit_db_file_disambiguates_and_empty_dir_reports_unavailable() {
    let dir = tempfile::tempdir().expect("dir");
    touch(&dir.path().join(RELEASE_DB_FILE_NAME));
    touch(&dir.path().join(DEV_DB_FILE_NAME));

    let chosen = instance::resolve(
        BuildInstance::Dev,
        InstanceAccess::ExistingOnly,
        Some(dir.path().to_path_buf()),
        Some(DEV_DB_FILE_NAME.to_owned()),
    )
    .expect("explicit file wins");
    assert_eq!(chosen.db_file_name(), DEV_DB_FILE_NAME);

    let empty = tempfile::tempdir().expect("empty dir");
    let error = instance::resolve(
        BuildInstance::Release,
        InstanceAccess::ExistingOnly,
        Some(empty.path().to_path_buf()),
        None,
    )
    .expect_err("missing");
    assert_eq!(
        error,
        InstanceState::Missing {
            db_path: empty.path().join(RELEASE_DB_FILE_NAME)
        }
    );
    assert_eq!(error.kind(), "instance_unavailable");
}

#[test]
fn access_policy_decides_whether_a_missing_file_is_created_or_reported() {
    let dir = tempfile::tempdir().expect("dir");

    let created = instance::resolve(
        BuildInstance::Dev,
        InstanceAccess::CreateIfMissing,
        Some(dir.path().to_path_buf()),
        None,
    )
    .expect("gui policy resolves an absent database");
    assert_eq!(created.access(), InstanceAccess::CreateIfMissing);
    assert_eq!(created.db_path(), dir.path().join(DEV_DB_FILE_NAME));
    assert!(!created.db_path().is_file(), "解析不产生写入");

    let reported = instance::resolve(
        BuildInstance::Dev,
        InstanceAccess::ExistingOnly,
        Some(dir.path().to_path_buf()),
        None,
    )
    .expect_err("cli policy refuses an absent database");
    assert!(matches!(reported, InstanceState::Missing { .. }));
}

/// 未设 `BERTH_DATA_DIR` 时按构建实例与各自默认库名解析（debug CLI 不会
/// 把 dev 实例解析成 `berth.db`）。
#[test]
fn build_instance_defaults_drive_unset_environment() {
    let dev =
        instance::resolve(BuildInstance::Dev, InstanceAccess::ExistingOnly, None, None).expect("dev");
    assert_eq!(dev.db_file_name(), DEV_DB_FILE_NAME);
    assert!(dev.data_dir().to_string_lossy().ends_with(".berth-dev"));

    let release =
        instance::resolve(BuildInstance::Release, InstanceAccess::ExistingOnly, None, None)
            .expect("release");
    assert_eq!(release.db_file_name(), RELEASE_DB_FILE_NAME);
    assert!(release.data_dir().to_string_lossy().ends_with("app.berth"));
}

#[test]
fn cli_env_override_selects_the_explicit_instance() {
    let dir = tempfile::tempdir().expect("dir");
    touch(&dir.path().join(DEV_DB_FILE_NAME));
    let dir_str = dir.path().to_string_lossy().into_owned();

    temp_env::with_vars(
        [
            (DATA_DIR_ENV, Some(dir_str.as_str())),
            (DATA_FILE_ENV, None::<&str>),
        ],
        || {
            let resolved =
                instance::resolve_cli_from_env(BuildInstance::Release).expect("explicit dir");
            assert_eq!(resolved.db_file_name(), DEV_DB_FILE_NAME);
            assert_eq!(resolved.data_dir(), dir.path());
            assert_eq!(resolved.access(), InstanceAccess::ExistingOnly);
        },
    );
}

#[test]
fn data_instance_reports_marker_path_in_its_data_root() {
    let dir = tempfile::tempdir().expect("dir");
    let instance = DataInstance::existing_only(dir.path(), RELEASE_DB_FILE_NAME);
    assert_eq!(
        instance.restore_marker_path(),
        dir.path().join(instance::RESTORE_PENDING_MARKER)
    );
}

