//! 知识库 `knowledge/`（空间目录下，见 [`crate::space`]）：扫描、搜索、过期、改状态与体检。GUI 记忆面板与 CLI `berth knowledge` 共用。
//!
//! 错误统一用 `std::io::Error`：参数不合法为 `InvalidInput`，其余是文件 / git 的 I/O 错误。

pub mod inbox;
pub mod model;
mod parser;
mod service;

pub(crate) use parser::split_frontmatter;
pub(crate) use service::replace_status;

pub use service::{
    add_source, covering, find, find_source, lint, search, set_status, show, snapshot, stale,
    LintReport,
};

use std::path::{Path, PathBuf};

/// 知识库所在空间的主项目：空间里所有项目读写同一份。不属于任何空间时原样返回，读写时报错。
pub fn vault_project(dir: &Path) -> PathBuf {
    crate::tasks::main_project(dir).unwrap_or_else(|_| dir.to_path_buf())
}
