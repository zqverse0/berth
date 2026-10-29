//! 唯一的迁移与开库入口。
//!
//! [`open_or_upgrade`] 是桌面宿主与 CLI 共用的唯一切口：单连接顺序迁移，
//! WAL 之后再建运行时连接池（沿用既有顺序）。桌面宿主的 pending restore
//! 仍留在 GUI（`commands::backup`），并在调用本切口**之前**完成。
//!
//! **只读策略是例外**：`InstanceAccess::ExistingOnly`（CLI）绝不写库 —— schema 落后
//! 本构建时报 [`InstanceState::UpgradeRequired`] 并指向 GUI，不就地迁移、不 install
//! 迁移记录表。连接使用 `mode=ro`，不改 journal mode，也不重建写连接池。

use std::path::Path;
use std::time::Duration;

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use sea_orm_migration::MigratorTrait;

use crate::error::DbError;
use crate::instance::{DataInstance, InstanceAccess, InstanceState};
use crate::migration::Migrator;

/// SQLite pragma 集合：`journal_mode=WAL` 写进库头，其余按连接重放。
const PRAGMAS: [(&str, &str); 5] = [
    ("journal_mode", "WAL"),
    ("busy_timeout", "5000"),
    ("synchronous", "NORMAL"),
    ("foreign_keys", "ON"),
    ("cache_size", "-8000"),
];

fn configure_sqlite_pragmas(opts: &mut ConnectOptions, read_only: bool) {
    // 由驱动在每个新连接上设置；从连接池执行 PRAGMA 只会设置借到的连接。
    opts.map_sqlx_sqlite_opts(move |mut options| {
        for (name, value) in PRAGMAS {
            if name != "journal_mode" || !read_only {
                options = options.pragma(name, value);
            }
        }
        options
    });
}

fn sqlite_url(db_path: &Path, access: InstanceAccess) -> String {
    let mode = match access {
        InstanceAccess::CreateIfMissing => "rwc",
        InstanceAccess::ExistingOnly => "ro",
    };
    format!(
        "sqlite:{}?mode={mode}",
        urlencoding::encode(&db_path.to_string_lossy())
    )
}

fn is_lock_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("database is locked")
        || lower.contains("database table is locked")
        || lower.contains("database schema is locked")
        || lower.contains("database is busy")
}

/// 连接失败分类：写锁占用 → `Migrating`；其余（含 `file is not a database`）
/// → `Incompatible`。绝不回退到「空实例」。
fn classify_open_error(detail: &str, db_path: &Path) -> InstanceState {
    if is_lock_error(detail) {
        return InstanceState::Migrating {
            detail: detail.to_owned(),
        };
    }
    InstanceState::Incompatible {
        detail: format!("{} ({detail})", db_path.display()),
    }
}

/// 本库已记录的迁移版本；`None` 表示本库没有迁移记录表（全新库或非 Berth 库）。
async fn applied_migration_versions(
    conn: &DatabaseConnection,
) -> Result<Option<Vec<String>>, DbError> {
    let table = conn
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM sqlite_master WHERE type='table' AND name='seaql_migrations'"
                .to_owned(),
        ))
        .await
        .map_err(|error| DbError::Migration(error.to_string()))?;
    if table.is_none() {
        return Ok(None);
    }

    let rows = conn
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT version FROM seaql_migrations".to_owned(),
        ))
        .await
        .map_err(|error| DbError::Migration(error.to_string()))?;

    let mut versions = Vec::with_capacity(rows.len());
    for row in rows {
        versions.push(
            row.try_get("", "version")
                .map_err(|error| DbError::Migration(error.to_string()))?,
        );
    }
    Ok(Some(versions))
}

fn known_migration_names() -> Vec<String> {
    <Migrator as MigratorTrait>::migrations()
        .iter()
        .map(|migration| migration.name().to_owned())
        .collect()
}

/// 已记录在本库、但本构建的迁移清单里没有的迁移版本。
///
/// 空表示本库没有迁移记录表（全新库），或所有记录都在本清单内。
/// 非空意味着库被更旧/更新的构建写过：报 `Incompatible`，不按自己的清单继续升级。
async fn unknown_applied_migrations(conn: &DatabaseConnection) -> Result<Vec<String>, DbError> {
    let Some(applied) = applied_migration_versions(conn).await? else {
        return Ok(Vec::new());
    };

    let known = known_migration_names();
    let mut unknown: Vec<String> = applied
        .into_iter()
        .filter(|version| !known.iter().any(|name| name == version))
        .collect();
    unknown.sort();
    Ok(unknown)
}

/// 只读探测：本构建定义、本库尚未记录的迁移数。
///
/// 刻意不使用 `Migrator::get_pending_migrations`：那个切口会 `install`
/// `seaql_migrations` 表，本身即是一次写库。
async fn pending_migration_count(conn: &DatabaseConnection) -> Result<usize, DbError> {
    let total = <Migrator as MigratorTrait>::migrations().len();
    let applied = applied_migration_versions(conn)
        .await?
        .map_or(0, |versions| versions.len());
    Ok(total.saturating_sub(applied))
}

/// 打开（必要时升级）一个数据实例。
///
/// 返回 `(None, 非 Ready 状态)` 时**不得**把结果投影成空列表：调用方必须
/// 报错并给出下一步。成功的唯一形态是 `(Some(conn), InstanceState::Ready)`。
pub async fn open_or_upgrade(
    instance: &DataInstance,
) -> (Option<DatabaseConnection>, InstanceState) {
    let marker = instance.restore_marker_path();
    if marker.is_file() {
        // 恢复交换必须由 GUI 在开库前完成（见 `commands::backup::restore`）。
        return (None, InstanceState::PendingRestore { marker });
    }

    let db_path = instance.db_path();
    if !db_path.is_file() {
        if instance.access() == InstanceAccess::ExistingOnly {
            return (None, InstanceState::Missing { db_path });
        }
        if let Err(error) = std::fs::create_dir_all(instance.data_dir()) {
            return (
                None,
                InstanceState::Incompatible {
                    detail: format!(
                        "cannot create data directory {}: {error}",
                        instance.data_dir().display()
                    ),
                },
            );
        }
    }

    let read_only = instance.access() == InstanceAccess::ExistingOnly;
    let url = sqlite_url(&db_path, instance.access());

    // 迁移在专用单连接上执行：连接池会让 sea-orm 把一条迁移的语句散到不同连接，
    // 引用刚追加列的语句可能落到缓存了旧 schema 的连接上（见原 `init_database`）。
    let mut migrate_opts = ConnectOptions::new(url.clone());
    migrate_opts
        .max_connections(1)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .sqlx_logging(false);
    configure_sqlite_pragmas(&mut migrate_opts, read_only);
    let migrate_conn = match Database::connect(migrate_opts).await {
        Ok(conn) => conn,
        Err(error) => return (None, classify_open_error(&error.to_string(), &db_path)),
    };
    match unknown_applied_migrations(&migrate_conn).await {
        Err(error) => {
            return (
                None,
                InstanceState::Incompatible {
                    detail: error.to_string(),
                },
            )
        }
        Ok(unknown) if !unknown.is_empty() => {
            let _ = migrate_conn.close().await;
            return (
                None,
                InstanceState::Incompatible {
                    detail: format!(
                        "database schema is not readable by this build (unknown migrations: {})",
                        unknown.join(", ")
                    ),
                },
            );
        }
        Ok(_) => {}
    }

    // 只读策略（CLI）绝不写库：schema 落后本构建时报「需 GUI 完成升级」，
    // 不就地迁移，也不 install `seaql_migrations` 表。
    if read_only {
        match pending_migration_count(&migrate_conn).await {
            // 保留同一个只读连接，不经过下方 GUI 专属的运行时写连接池。
            Ok(0) => return (Some(migrate_conn), InstanceState::Ready),
            Ok(pending) => {
                let _ = migrate_conn.close().await;
                return (None, InstanceState::UpgradeRequired { pending });
            }
            Err(error) => {
                let detail = error.to_string();
                let _ = migrate_conn.close().await;
                return (None, classify_open_error(&detail, &db_path));
            }
        }
    } else if let Err(error) = Migrator::up(&migrate_conn, None).await {
        let detail = error.to_string();
        let _ = migrate_conn.close().await;
        return (None, classify_open_error(&detail, &db_path));
    }
    if let Err(error) = migrate_conn.close().await {
        return (
            None,
            InstanceState::Incompatible {
                detail: error.to_string(),
            },
        );
    }

    // 运行时连接池：schema 已稳定，读并发可以分散到多个连接。
    let mut opts = ConnectOptions::new(url);
    opts.max_connections(5)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .sqlx_logging(false);
    configure_sqlite_pragmas(&mut opts, read_only);
    let conn = match Database::connect(opts).await {
        Ok(conn) => conn,
        Err(error) => return (None, classify_open_error(&error.to_string(), &db_path)),
    };
    (Some(conn), InstanceState::Ready)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_pragmas_apply_to_every_pool_connection() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let mut opts = ConnectOptions::new(format!(
                "sqlite:{}?mode=rwc",
                dir.path().join("pool.db").display()
            ));
            opts.max_connections(2).min_connections(1);
            configure_sqlite_pragmas(&mut opts, false);
            let db = Database::connect(opts).await.unwrap();
            let pool = db.get_sqlite_connection_pool();
            let mut first = pool.acquire().await.unwrap();
            let mut second = pool.acquire().await.unwrap();
            for connection in [&mut first, &mut second] {
                for (statement, expected) in [
                    ("PRAGMA busy_timeout", 5000_i64),
                    ("PRAGMA foreign_keys", 1),
                    ("PRAGMA synchronous", 1),
                    ("PRAGMA cache_size", -8000),
                ] {
                    let actual: i64 = sea_orm::sqlx::query_scalar(statement)
                        .fetch_one(&mut **connection)
                        .await
                        .unwrap();
                    assert_eq!(actual, expected, "{statement}");
                }
                let journal: String = sea_orm::sqlx::query_scalar("PRAGMA journal_mode")
                    .fetch_one(&mut **connection)
                    .await
                    .unwrap();
                assert_eq!(journal, "wal");
            }
            drop(first);
            drop(second);
            db.close().await.unwrap();
        });
    }

    #[test]
    fn read_only_connections_preserve_journal_mode() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("readonly.db");
            let db = Database::connect(format!("sqlite:{}?mode=rwc", path.display()))
                .await
                .unwrap();
            db.execute(Statement::from_string(
                DbBackend::Sqlite,
                "CREATE TABLE sample (id INTEGER)",
            ))
            .await
            .unwrap();
            db.execute(Statement::from_string(
                DbBackend::Sqlite,
                "PRAGMA journal_mode=DELETE",
            ))
            .await
            .unwrap();
            db.close().await.unwrap();

            let mut opts = ConnectOptions::new(format!("sqlite:{}?mode=ro", path.display()));
            configure_sqlite_pragmas(&mut opts, true);
            let db = Database::connect(opts).await.unwrap();
            let journal = db
                .query_one(Statement::from_string(
                    DbBackend::Sqlite,
                    "PRAGMA journal_mode",
                ))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                journal.try_get::<String>("", "journal_mode").unwrap(),
                "delete"
            );
            db.close().await.unwrap();
        });
    }
}
