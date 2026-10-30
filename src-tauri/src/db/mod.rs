//! Database access for the desktop host.
//!
//! 项目事实（实体、迁移、项目领域服务、数据实例解析与唯一迁移入口）已搬到
//! 纯 Rust crate `berth-project-core`；本模块只保留桌面宿主自己的生命周期：
//! `AppDatabase`、`database_file_name()`（`cfg!` 语义留在宿主）与
//! `init_database`（backup restore → 共享 `open_or_upgrade`）。

pub mod service;

#[cfg(any(test, feature = "test-utils"))]
pub mod test_helpers;

use std::path::Path;

use sea_orm::DatabaseConnection;

use berth_project_core::error::DbError;
use berth_project_core::instance::DataInstance;
use berth_project_core::open::open_or_upgrade;

pub struct AppDatabase {
    pub conn: DatabaseConnection,
}

pub(crate) fn database_file_name() -> &'static str {
    if cfg!(all(debug_assertions, feature = "tauri-runtime")) {
        "berth-dev.db"
    } else {
        "berth.db"
    }
}

pub async fn init_database(
    app_data_dir: impl AsRef<Path>,
    app_version: &str,
) -> Result<AppDatabase, DbError> {
    let app_data_dir = app_data_dir.as_ref();
    std::fs::create_dir_all(app_data_dir)?;

    // Apply any pending restore BEFORE opening a connection — swapping
    // `berth.db` under a live SQLite handle would corrupt it. A failure here
    // aborts startup loudly (leaving the safety snapshot intact) rather than
    // booting a half-restored data dir. 恢复交换只能由桌面宿主完成：共享切口
    // 检测到标记时只报 `InstanceState::PendingRestore`。
    match crate::commands::backup::restore::apply_pending_restore_on_startup(app_data_dir) {
        Ok(crate::commands::backup::restore::RestoreApplied::Applied { .. }) => {}
        Ok(crate::commands::backup::restore::RestoreApplied::None) => {}
        Err(e) => return Err(DbError::Io(e)),
    }
    crate::commands::backup::restore::cleanup_transient_dirs(app_data_dir);

    // 共享 crate 是唯一迁移入口：单连接顺序迁移，WAL 之后再建运行时连接池。
    let instance = DataInstance::create_if_missing(app_data_dir, database_file_name());
    let (conn, state) = open_or_upgrade(&instance).await;
    let Some(conn) = conn else {
        return Err(DbError::Migration(format!(
            "database instance is not ready: {}",
            state.message()
        )));
    };

    berth_project_core::service::app_metadata_service::update_app_version(&conn, app_version)
        .await?;

    berth_project_core::service::folder_service::ensure_distinct_folder_aliases(&conn).await?;

    Ok(AppDatabase { conn })
}

#[cfg(test)]
mod tests {
    // debug 桌面构建（含 cargo test）用独立的 dev 库，不碰正式数据。
    #[test]
    fn database_name_separates_dev_from_release() {
        let expected = if cfg!(all(debug_assertions, feature = "tauri-runtime")) {
            "berth-dev.db"
        } else {
            "berth.db"
        };
        assert_eq!(super::database_file_name(), expected);
    }
}
