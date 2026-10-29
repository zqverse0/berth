//! 数据实例解析：项目事实（SQLite）属于哪个数据根与哪个库文件。
//!
//! 决策表（父任务 design §4.1 冻结）：
//!
//! | 调用方 | `BERTH_DATA_DIR` | `BERTH_DATA_FILE` | 数据根 | 库文件 |
//! |---|---|---|---|---|
//! | release GUI | 未设 | — | Tauri `app_data_dir()`（`~/.local/share/app.berth`） | `berth.db` |
//! | dev GUI（`pnpm tauri dev`） | 启动脚本设 `~/.berth-dev` | `berth-dev.db` | `~/.berth-dev` | `berth-dev.db` |
//! | release CLI | 未设 | — | `dirs::data_dir()/app.berth` | `berth.db` |
//! | release CLI | 设 | 未设 | 该目录 | 目录内实际存在的库，两个都在则报歧义 |
//! | debug CLI | 未设 | — | `~/.berth-dev` | `berth-dev.db` |
//! | 仓库 `bin/berth` | `~/.berth-dev` | `berth-dev.db` | `~/.berth-dev` | `berth-dev.db` |
//! | 直调 debug CLI | 设 | 未设 | 该目录 | 目录内实际存在的库，两个都在则报歧义 |
//! | 任一 | 设 | 设 | 该目录 | 该文件名 |
//!
//! **本模块不读 `cfg!`**：构建实例（dev/release）由调用方给出，避免把
//! `berth-cli`（没有 `tauri-runtime` feature）的 dev 实例解析成 `berth.db`。
//! GUI 侧继续使用它自己的 `db::database_file_name()`（保留
//! `cfg!(all(debug_assertions, feature = "tauri-runtime"))` 语义）。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 应用数据根的环境变量（与桌面宿主同一别名，不得改名）。
pub const DATA_DIR_ENV: &str = "BERTH_DATA_DIR";
/// 显式指定库文件名的环境变量：数据目录内两个候选库并存时必须给出。
pub const DATA_FILE_ENV: &str = "BERTH_DATA_FILE";
/// 正式实例的库文件名。
pub const RELEASE_DB_FILE_NAME: &str = "berth.db";
/// dev 实例的库文件名（`database_file_name()` 的 debug + `tauri-runtime` 分支）。
pub const DEV_DB_FILE_NAME: &str = "berth-dev.db";
/// 未完成 restore 的标记文件（`commands::backup::restore` 写入；此处是唯一常量定义）。
pub const RESTORE_PENDING_MARKER: &str = ".berth-restore-pending.json";

/// 调用方的构建实例。由调用方判定（`cfg!(debug_assertions)`），不在本 crate 内读 `cfg!`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildInstance {
    Dev,
    Release,
}

impl BuildInstance {
    /// 该构建实例默认的库文件名。
    pub fn default_db_file_name(self) -> &'static str {
        match self {
            BuildInstance::Dev => DEV_DB_FILE_NAME,
            BuildInstance::Release => RELEASE_DB_FILE_NAME,
        }
    }
}

/// 打开库文件时的缺失策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceAccess {
    /// 与桌面宿主 `init_database` 一致：缺库则建库并迁移。
    CreateIfMissing,
    /// 只读查询：缺库报 [`InstanceState::Missing`]，不创建、不迁移空库。
    ExistingOnly,
}

/// 一个已解析的数据实例：数据根 + 库文件名 + 缺失策略。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataInstance {
    data_dir: PathBuf,
    db_file_name: String,
    access: InstanceAccess,
}

impl DataInstance {
    /// 桌面宿主入口：数据根与库名由宿主给出（保留既有 `cfg!` 语义）。
    pub fn create_if_missing(
        data_dir: impl Into<PathBuf>,
        db_file_name: impl Into<String>,
    ) -> Self {
        Self {
            data_dir: data_dir.into(),
            db_file_name: db_file_name.into(),
            access: InstanceAccess::CreateIfMissing,
        }
    }

    /// 只读入口（CLI）：缺库即失败，不产生任何写入。
    pub fn existing_only(data_dir: impl Into<PathBuf>, db_file_name: impl Into<String>) -> Self {
        Self {
            data_dir: data_dir.into(),
            db_file_name: db_file_name.into(),
            access: InstanceAccess::ExistingOnly,
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn db_file_name(&self) -> &str {
        &self.db_file_name
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(&self.db_file_name)
    }

    pub fn access(&self) -> InstanceAccess {
        self.access
    }

    /// 已存在 DB 完整 canonical 路径的稳定 SHA-256 namespace，不读库内容、不建库。
    ///
    /// v1 编码为域标签、平台标签及无损路径字节；Unix 使用原始字节，Windows 使用
    /// UTF-16 小端 code units。不能改用 lossy 文本或仅数据目录，否则会合并不同实例。
    pub fn namespace_key(&self) -> Result<String, InstanceState> {
        let db_path = self.db_path();
        let canonical = db_path.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                InstanceState::Missing {
                    db_path: db_path.clone(),
                }
            } else {
                InstanceState::Incompatible {
                    detail: format!("cannot canonicalize database path: {error}"),
                }
            }
        })?;
        if !canonical.is_file() {
            return Err(InstanceState::Incompatible {
                detail: "database path is not a file".to_owned(),
            });
        }
        let mut digest = Sha256::new();
        digest.update(b"berth-data-instance-v1\0");
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            digest.update(b"unix\0");
            digest.update(canonical.as_os_str().as_bytes());
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            digest.update(b"windows-utf16le\0");
            for unit in canonical.as_os_str().encode_wide() {
                digest.update(unit.to_le_bytes());
            }
        }
        #[cfg(not(any(unix, windows)))]
        return Err(InstanceState::Incompatible {
            detail: "database namespace encoding is unsupported on this platform".to_owned(),
        });
        Ok(format!("{:x}", digest.finalize()))
    }

    /// 未完成 restore 标记的绝对路径。
    pub fn restore_marker_path(&self) -> PathBuf {
        self.data_dir.join(RESTORE_PENDING_MARKER)
    }
}

/// 实例状态。非 [`InstanceState::Ready`] 一律不得伪报为空列表。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceState {
    Ready,
    /// 数据根存在未完成的 restore 标记：只有桌面宿主能完成恢复。
    PendingRestore { marker: PathBuf },
    /// 另一个进程正在迁移（SQLite 写锁未释放）。
    Migrating { detail: String },
    /// 库文件无法被本构建读取（损坏、或 schema 比本构建更新）。
    Incompatible { detail: String },
    /// 数据目录内两个候选库并存且未显式指定 `BERTH_DATA_FILE`。
    Ambiguous { candidates: Vec<String> },
    /// 只读查询要求库文件存在，但该文件不存在。
    Missing { db_path: PathBuf },
    /// 只读策略（CLI）遇到落后于本构建的 schema：只有承担迁移职责的一方（GUI）能升级，
    /// 读命令绝不就地写库。
    UpgradeRequired { pending: usize },
}

impl InstanceState {
    pub fn is_ready(&self) -> bool {
        matches!(self, InstanceState::Ready)
    }

    /// 机器可读分类（CLI `--json` 的 `error.kind`）。
    pub fn kind(&self) -> &'static str {
        match self {
            InstanceState::Ready => "ready",
            InstanceState::PendingRestore { .. } => "instance_pending_restore",
            InstanceState::Migrating { .. } => "instance_migrating",
            InstanceState::Incompatible { .. } => "instance_incompatible",
            InstanceState::Ambiguous { .. } => "instance_ambiguous",
            InstanceState::Missing { .. } => "instance_unavailable",
            InstanceState::UpgradeRequired { .. } => "instance_upgrade_required",
        }
    }

    /// 人类可读诊断 + 下一步（不声称成功，也不伪装成空列表）。
    pub fn message(&self) -> String {
        match self {
            InstanceState::Ready => "data instance is ready".to_owned(),
            InstanceState::PendingRestore { marker } => format!(
                "data instance is unavailable: a pending restore marker exists at {}; start the Berth GUI to finish the restore",
                marker.display()
            ),
            InstanceState::Migrating { detail } => format!(
                "data instance is busy: another process is migrating this database ({detail}); retry once it finishes"
            ),
            InstanceState::Incompatible { detail } => format!(
                "data instance is unavailable: the database cannot be read by this build ({detail})"
            ),
            InstanceState::Ambiguous { candidates } => format!(
                "data instance is ambiguous: {} exist in the data directory; set BERTH_DATA_FILE to one of them",
                candidates.join(" and ")
            ),
            InstanceState::Missing { db_path } => format!(
                "data instance is unavailable: no database at {}; start the Berth GUI once to initialise it or point BERTH_DATA_DIR at the right instance",
                db_path.display()
            ),
            InstanceState::UpgradeRequired { pending } => format!(
                "data instance needs an upgrade: {pending} pending migration(s) for this build; start the Berth GUI to finish the upgrade (read-only queries never migrate this database)"
            ),
        }
    }
}

/// 未显式指定数据根时，按构建实例给出默认数据根。
///
/// - dev：`~/.berth-dev`（启动脚本 `scripts/tauri-with-display.mjs` 为 dev GUI 使用的数据根）；
/// - release：`dirs::data_dir()/app.berth`（Tauri `app_data_dir()` 的同名目录）。
///
/// 没有 home 目录时退化为相对目录，调用方仍需处理创建失败。
pub fn default_data_dir(build: BuildInstance) -> PathBuf {
    match build {
        BuildInstance::Dev => dirs::home_dir()
            .map(|home| home.join(".berth-dev"))
            .unwrap_or_else(|| PathBuf::from(".berth-dev")),
        BuildInstance::Release => dirs::data_dir()
            .map(|data| data.join("app.berth"))
            .unwrap_or_else(|| PathBuf::from("app.berth")),
    }
}

/// 数据目录内实际存在的候选库文件名（顺序稳定，用于歧义诊断）。
pub fn existing_db_candidates(data_dir: &Path) -> Vec<String> {
    [RELEASE_DB_FILE_NAME, DEV_DB_FILE_NAME]
        .into_iter()
        .filter(|name| data_dir.join(name).is_file())
        .map(str::to_owned)
        .collect()
}

/// 解析结果：显式目录 → 目录内实际存在的库；未显式 → 构建实例默认根与库名。
pub fn resolve(
    build: BuildInstance,
    access: InstanceAccess,
    explicit_data_dir: Option<PathBuf>,
    explicit_db_file: Option<String>,
) -> Result<DataInstance, InstanceState> {
    let (data_dir, db_file_name) = match explicit_data_dir {
        Some(dir) => match explicit_db_file {
            Some(name) => (dir, name),
            None => {
                let candidates = existing_db_candidates(&dir);
                match candidates.len() {
                    0 if access == InstanceAccess::CreateIfMissing => {
                        (dir, build.default_db_file_name().to_owned())
                    }
                    0 => {
                        return Err(InstanceState::Missing {
                            db_path: dir.join(build.default_db_file_name()),
                        })
                    }
                    1 => {
                        let name = candidates.into_iter().next().unwrap_or_default();
                        (dir, name)
                    }
                    _ => return Err(InstanceState::Ambiguous { candidates }),
                }
            }
        },
        None => (
            default_data_dir(build),
            explicit_db_file.unwrap_or_else(|| build.default_db_file_name().to_owned()),
        ),
    };

    let instance = DataInstance {
        data_dir,
        db_file_name,
        access,
    };
    if instance.access == InstanceAccess::CreateIfMissing || instance.db_path().is_file() {
        Ok(instance)
    } else {
        Err(InstanceState::Missing {
            db_path: instance.db_path(),
        })
    }
}

/// CLI 入口：读 `BERTH_DATA_DIR` / `BERTH_DATA_FILE`，只读策略。
pub fn resolve_cli_from_env(build: BuildInstance) -> Result<DataInstance, InstanceState> {
    resolve_from_env(build, InstanceAccess::ExistingOnly)
}

/// 同 [`resolve_cli_from_env`]，但由调用方给出访问策略：CLI 写路径（GUI 未运行时的
/// `berth project add`）用 `CreateIfMissing`，无库的服务器上首次使用即建库。
pub fn resolve_from_env(
    build: BuildInstance,
    access: InstanceAccess,
) -> Result<DataInstance, InstanceState> {
    resolve(
        build,
        access,
        std::env::var_os(DATA_DIR_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
        std::env::var_os(DATA_FILE_ENV)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string_lossy().into_owned()),
    )
}
