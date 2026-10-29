//! `.berth/knowledge/` 知识库：扫描、搜索、过期、改状态与体检；想法见 [`ideas`]。GUI 记忆面板与 CLI `berth knowledge` 共用。
//!
//! 错误统一用 `std::io::Error`：参数不合法为 `InvalidInput`，其余是文件 / git 的 I/O 错误。

pub mod classifier;
pub mod exchanges;
pub mod handoff;
pub mod journal;
pub mod ideas;
pub mod model;
pub mod rules;
mod parser;
mod service;

pub(crate) use parser::split_frontmatter;
pub(crate) use service::replace_status;

pub use service::{
    covering, find, lint, search, set_status, show, snapshot, stale, worktree_changes, LintReport,
};

use std::path::{Path, PathBuf};

/// 知识库所在的项目：同仓库的主项目（`berth init` 过的 checkout）。所有 worktree 都读写这一份。
pub fn vault_project(dir: &Path) -> PathBuf {
    crate::tasks::main_project(dir).unwrap_or_else(|_| crate::tasks::checkout_root(dir))
}
