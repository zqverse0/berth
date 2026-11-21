//! 空间：Berth 的容器（库表 `project`），一个空间有多个项目——主项目、worktree、参考目录。
//!
//! 任务、群组、想法、知识库与运行态是空间的私有数据，存在空间目录 `<数据目录>/spaces/<id>/`，
//! 不进代码仓库；目录里的布局与旧的 `<主项目>/.berth/` 相同（`tasks/`、`knowledge/`、`local/`…）。
//! 「目录属于哪个空间」只以库为准（folder.project_id、project_reference）。
//!
//! 进程启动时由宿主 [`configure`]（GUI 建库后、CLI 解析实例后）。没配置的进程（拿不到库、
//! 库还没迁移的 CLI）用不了任务、群组与知识库。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::instance::DataInstance;

/// 空间目录的父目录名（相对数据目录）。
pub const SPACES_DIR: &str = "spaces";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Space {
    pub id: i32,
    /// 主项目目录（git 对账、会话归属按它）。
    pub main: PathBuf,
    /// 空间目录（私有数据）。
    pub dir: PathBuf,
}

struct Config {
    db_path: PathBuf,
    spaces_root: PathBuf,
}

/// 一行：成员或参考目录 → 所属空间。
#[derive(Debug, Clone)]
struct Row {
    path: PathBuf,
    id: i32,
    main: PathBuf,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

/// 把空间数据搬出仓库的迁移；库里还没跑过它时不启用空间。
const SPACE_MIGRATION: &str = "m20261120_000002_space_dirs";

/// 设定本进程的数据实例；只认第一次。库还没迁移到空间（旧版库、只读 CLI 等着 GUI 升级）时不设定：
/// 否则会先建出空的空间目录，迁移再看到目录已在就不复制了。
pub fn configure(instance: &DataInstance) {
    if !migrated(&instance.db_path()) {
        return;
    }
    let _ = CONFIG.set(Config {
        db_path: instance.db_path(),
        spaces_root: instance.data_dir().join(SPACES_DIR),
    });
}

fn migrated(db_path: &Path) -> bool {
    open(db_path)
        .and_then(|conn| {
            conn.query_row(
                "SELECT 1 FROM seaql_migrations WHERE version = ?1",
                [SPACE_MIGRATION],
                |_| Ok(()),
            )
        })
        .is_ok()
}

fn open(db_path: &Path) -> rusqlite::Result<rusqlite::Connection> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}

pub fn configured() -> bool {
    CONFIG.get().is_some()
}

/// 空间 `id` 的目录（不检查是否存在）。未配置时为 `None`。
pub fn dir_of(id: i32) -> Option<PathBuf> {
    CONFIG.get().map(|config| config.spaces_root.join(id.to_string()))
}

/// `dir`（或其祖先）所属的空间：取路径最长的那个成员 / 参考目录。未配置或不属于任何空间时为 `None`。
pub fn of(dir: &Path) -> Option<Space> {
    let config = CONFIG.get()?;
    let rows = rows(config);
    let canonical = dir.canonicalize().ok();
    let row = pick(&rows, dir).or_else(|| canonical.as_deref().and_then(|dir| pick(&rows, dir)))?;
    Some(Space {
        id: row.id,
        main: row.main.clone(),
        dir: config.spaces_root.join(row.id.to_string()),
    })
}

fn pick<'a>(rows: &'a [Row], dir: &Path) -> Option<&'a Row> {
    rows.iter()
        .filter(|row| dir.starts_with(&row.path))
        .max_by_key(|row| row.path.as_os_str().len())
}

/// 成员表的快照：从库派生，GUI 每几秒为侧栏各项目查一次，缓存一小段时间；成员变动最多晚这么久生效。
static CACHE: Mutex<Option<(Instant, Vec<Row>)>> = Mutex::new(None);

fn rows(config: &Config) -> Vec<Row> {
    const TTL: Duration = Duration::from_secs(2);
    let mut cache = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((_, rows)) = cache.as_ref().filter(|(at, _)| at.elapsed() < TTL) {
        return rows.clone();
    }
    let rows = query(&config.db_path).unwrap_or_else(|error| {
        eprintln!("berth: 读空间成员失败（{}）：{error}", config.db_path.display());
        Vec::new()
    });
    *cache = Some((Instant::now(), rows.clone()));
    rows
}

fn query(db_path: &Path) -> rusqlite::Result<Vec<Row>> {
    let conn = open(db_path)?;
    let mut statement = conn.prepare(
        "SELECT f.path, p.id, m.path FROM folder f \
           JOIN project p ON p.id = f.project_id \
           JOIN folder m ON m.id = p.main_folder_id \
          WHERE f.deleted_at IS NULL \
         UNION ALL \
         SELECT r.path, p.id, m.path FROM project_reference r \
           JOIN project p ON p.id = r.project_id \
           JOIN folder m ON m.id = p.main_folder_id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(Row {
                path: PathBuf::from(row.get::<_, String>(0)?),
                id: row.get(1)?,
                main: PathBuf::from(row.get::<_, String>(2)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 测试用：本进程共用一个临时数据目录，每个测试把自己的主项目登记成一个空间。
#[cfg(any(test, feature = "testing"))]
pub mod testing {
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    use super::{Config, CACHE, CONFIG, SPACES_DIR};

    fn db() -> &'static Path {
        static DB: OnceLock<PathBuf> = OnceLock::new();
        DB.get_or_init(|| {
            let data = std::env::temp_dir().join(format!("berth-space-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&data);
            std::fs::create_dir_all(&data).unwrap();
            let path = data.join("berth.db");
            rusqlite::Connection::open(&path)
                .unwrap()
                .execute_batch(
                    "CREATE TABLE project (id integer PRIMARY KEY, main_folder_id integer NOT NULL);
                     CREATE TABLE folder (id integer PRIMARY KEY, path varchar, project_id integer, deleted_at text);
                     CREATE TABLE project_reference (id integer PRIMARY KEY, project_id integer, path varchar);",
                )
                .unwrap();
            let _ = CONFIG.set(Config {
                db_path: path.clone(),
                spaces_root: data.join(SPACES_DIR),
            });
            path
        })
    }

    /// 把 `main` 登记为一个新空间的主项目，返回空间目录（不创建）。
    pub fn register(main: &Path) -> PathBuf {
        let conn = rusqlite::Connection::open(db()).unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
        conn.execute(
            "INSERT INTO folder (path) VALUES (?1)",
            [main.to_string_lossy()],
        )
        .unwrap();
        let folder = conn.last_insert_rowid();
        conn.execute("INSERT INTO project (main_folder_id) VALUES (?1)", [folder])
            .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute("UPDATE folder SET project_id = ?1 WHERE id = ?2", [id, folder])
            .unwrap();
        *CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        super::dir_of(id as i32).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(path: &Path) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id integer PRIMARY KEY, main_folder_id integer NOT NULL);
             CREATE TABLE folder (id integer PRIMARY KEY, path varchar, project_id integer, deleted_at text);
             CREATE TABLE project_reference (id integer PRIMARY KEY, project_id integer, path varchar);
             INSERT INTO project VALUES (1, 10), (2, 20);
             INSERT INTO folder VALUES (10, '/w/app', 1, NULL), (11, '/w/app-feature', 1, NULL),
                                       (20, '/w/app/vendor/lib', 2, NULL), (21, '/w/gone', 2, 'x');
             INSERT INTO project_reference VALUES (1, 1, '/ref/docs');",
        )
        .unwrap();
    }

    #[test]
    fn spaces_wait_for_the_copy_migration() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("berth.db");
        db(&path);
        assert!(!migrated(&path), "没有迁移表");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE seaql_migrations (version varchar PRIMARY KEY, applied_at integer)")
            .unwrap();
        assert!(!migrated(&path), "迁移还没跑");
        conn.execute("INSERT INTO seaql_migrations VALUES (?1, 0)", [SPACE_MIGRATION]).unwrap();
        assert!(migrated(&path));
    }

    #[test]
    fn members_and_references_resolve_to_the_innermost_space() {
        let data = tempfile::tempdir().unwrap();
        db(&data.path().join("berth.db"));
        let rows = query(&data.path().join("berth.db")).unwrap();
        let find = |dir: &str| pick(&rows, Path::new(dir)).map(|row| (row.id, row.main.clone()));
        assert_eq!(find("/w/app/src"), Some((1, PathBuf::from("/w/app"))));
        assert_eq!(find("/w/app-feature"), Some((1, PathBuf::from("/w/app"))));
        assert_eq!(find("/ref/docs/a.md"), Some((1, PathBuf::from("/w/app"))));
        // 嵌在别的成员里的项目归它自己的空间。
        assert_eq!(find("/w/app/vendor/lib/x"), Some((2, PathBuf::from("/w/app/vendor/lib"))));
        // 已删除的成员、前缀相同但不是祖先的目录都不算。
        assert_eq!(find("/w/gone"), None);
        assert_eq!(find("/w/application"), None);
    }
}
