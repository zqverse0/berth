//! 主项目判定：执行过 `berth init` 的那份 checkout（`.berth/local/hub.json`）。
//!
//! 不用 DB `parent_id`：GUI 把 `git worktree list` 第一项（git 主 worktree）当家族根，
//! 而用户工作、跑 dev、存 `local/` 的 checkout 不一定是它（本仓库的根是 main 分支的旧目录）。

use std::path::{Path, PathBuf};

use super::git;
use super::{TaskError, TaskResult};

/// 相对 checkout 根的主项目标记，由 `berth init` 写入。
pub const HUB_MARKER: &str = ".berth/local/hub.json";

/// `dir` 所在 checkout 的根：先找含 `.berth/` 的祖先（到 git 根为止，与 `berth init` 一致，
/// 项目可以是仓库的子目录），再退回 git 顶层目录，最后是 `dir`。
pub(crate) fn checkout_root(dir: &Path) -> PathBuf {
    if let Some(root) = crate::berth_dir::project_root(dir) {
        return root.to_path_buf();
    }
    git::stdout(dir, &["rev-parse", "--show-toplevel"])
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.to_path_buf())
}

/// 已启用 Berth 的项目范围：任务、群组、知识库都从这里取路径。
#[derive(Debug, Clone)]
pub struct Scope {
    /// `dir` 所在 checkout（含 `.berth/` 的那一层；任务内容在这里读写）。
    pub checkout: PathBuf,
    /// 主项目（群、实时状态、知识库在这里）。
    pub main: PathBuf,
}

/// 项目范围的唯一入口：`dir` 往上（到 git 根为止）没有 `.berth/` 即未启用，不跑 git。
/// 与 [`crate::berth_dir::enabled_at`] 同一判定；会话这类不要求启用的读取用 [`main_project`]。
pub fn resolve(dir: &Path) -> TaskResult<Scope> {
    let checkout = crate::berth_dir::project_root(dir)
        .ok_or_else(|| not_initialized(dir))?
        .to_path_buf();
    let main = main_project(&checkout)?;
    if !berth_dir(&main).is_dir() {
        return Err(not_initialized(&main));
    }
    Ok(Scope { checkout, main })
}

pub(crate) fn not_initialized(dir: &Path) -> TaskError {
    TaskError::new(
        "not_initialized",
        format!(
            "本项目未启用 Berth（{} 往上没有 .berth/）：请在 Berth 中启用，或执行 `berth project init`",
            dir.display()
        ),
    )
}

/// 同一仓库里带主项目标记的 checkout（不要求启用；会话归属用）。没有标记（标记出现前启用的旧项目）时取 git 主 worktree，
/// 它也启用了 Berth 才算；否则是 `dir` 所在 checkout 自己（单 checkout）。
pub fn main_project(dir: &Path) -> TaskResult<PathBuf> {
    let checkout = checkout_root(dir);
    let worktrees: Vec<PathBuf> = git::worktrees(&checkout)
        .into_iter()
        .map(|worktree| worktree.path)
        .collect();
    let marked: Vec<&PathBuf> = worktrees
        .iter()
        .filter(|path| path.join(HUB_MARKER).is_file())
        .collect();
    match marked.as_slice() {
        // `git worktree list` 第一项是主 worktree。
        [] => Ok(worktrees
            .first()
            .filter(|main| main.join(".berth").is_dir())
            .cloned()
            .unwrap_or(checkout)),
        [hub] => Ok((*hub).clone()),
        many => Err(TaskError::new(
            "ambiguous",
            format!(
                "多个 checkout 都标记为主项目：{}；只保留一个的 {HUB_MARKER}",
                many.iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join("、")
            ),
        )),
    }
}

/// 同仓库里**另一份** checkout 已是主项目时返回它（`berth init` 据此拒绝在 worktree 里再建一个）。
pub(crate) fn hub_elsewhere(root: &Path) -> Option<PathBuf> {
    git::worktrees(root)
        .into_iter()
        .map(|worktree| worktree.path)
        .find(|path| path.join(HUB_MARKER).is_file() && !git::same_path(path, root))
}

/// `<主项目>/.berth`
pub(crate) fn berth_dir(main: &Path) -> PathBuf {
    main.join(".berth")
}

pub(crate) fn local_dir(main: &Path) -> PathBuf {
    main.join(".berth").join("local")
}
