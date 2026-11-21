//! 空间范围：任务、群组、知识库的数据在哪、主项目是谁——一律以库为准（[`crate::space`]）。

use std::path::{Path, PathBuf};

use crate::space::Space;

use super::git;
use super::{TaskError, TaskResult};

/// 空间范围：任务、群组、知识库都从这里取路径。
#[derive(Debug, Clone)]
pub struct Scope {
    /// `dir` 所在 checkout。
    pub checkout: PathBuf,
    /// 空间的主项目（git 对账的基准）；数据目录用 [`berth_dir`] 从它取。
    pub main: PathBuf,
}

/// `dir` 所属的空间。没登记进库的 worktree（如 Agent 用 `git worktree add` 建的）跟同仓库已登记的 checkout 走。
fn space_of(dir: &Path) -> TaskResult<Space> {
    if !crate::space::configured() {
        return Err(TaskError::new(
            "not_initialized",
            "空间不可用：Berth 数据库还没升级到空间，请先打开一次新版 Berth",
        ));
    }
    crate::space::of(dir)
        .or_else(|| {
            git::worktrees(dir)
                .iter()
                .find_map(|worktree| crate::space::of(&worktree.path))
        })
        .ok_or_else(|| {
            TaskError::new(
                "not_initialized",
                format!(
                    "{} 不属于任何空间：请先在 Berth 里把这个项目加进空间（或 `berth project add`）",
                    dir.display()
                ),
            )
        })
}

/// 空间范围的唯一入口；解析时补齐空间目录骨架。
pub fn resolve(dir: &Path) -> TaskResult<Scope> {
    let space = space_of(dir)?;
    crate::berth_dir::ensure_space(&space.dir)?;
    let main = space.main.canonicalize().unwrap_or_else(|_| space.main.clone());
    let checkout = match git::stdout(dir, &["rev-parse", "--show-toplevel"]).filter(|s| !s.is_empty()) {
        // 主项目是仓库的子目录：checkout 就是主项目本身。
        Some(top) if main.starts_with(&top) => space.main.clone(),
        Some(top) => PathBuf::from(top),
        None => space.main.clone(),
    };
    Ok(Scope {
        checkout,
        main: space.main,
    })
}

/// `dir` 所属空间的主项目（不补骨架；会话归属这类只读用）。
pub fn main_project(dir: &Path) -> TaskResult<PathBuf> {
    space_of(dir).map(|space| space.main)
}

/// 数据目录：`dir` 所属空间的空间目录。
pub fn berth_dir(dir: &Path) -> TaskResult<PathBuf> {
    space_of(dir).map(|space| space.dir)
}

/// [`berth_dir`] 的内部版：`main` 来自 [`resolve`] / [`main_project`]，已在空间里；写入前由
/// [`require`] 把关。空间恰在这期间被删时落到临时目录，不写回代码仓库。
pub(crate) fn data_dir(main: &Path) -> PathBuf {
    // ponytail: 竞态兜底用临时目录；要报错得把各路径函数都改成 Result。
    berth_dir(main).unwrap_or_else(|_| std::env::temp_dir().join("berth-unassigned"))
}

pub(crate) fn local_dir(main: &Path) -> PathBuf {
    data_dir(main).join("local")
}

/// 写账本 / 实时状态前的检查：`main` 必须属于某个空间。
pub(crate) fn require(main: &Path) -> TaskResult<()> {
    space_of(main).map(drop)
}
