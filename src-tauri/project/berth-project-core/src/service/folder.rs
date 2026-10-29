//! 项目（folder）投影类型。
//!
//! 与桌面宿主原有的 `models::folder` 定义逐字一致：JSON 线上字段名不变。
//! GUI 侧保留 `pub use` 桥，前端 DTO 不因搬家改名。

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::agent::AgentType;
use crate::entities::folder::FolderKind;

#[derive(Debug, Clone, Serialize)]
pub struct FolderHistoryEntry {
    pub id: i32,
    pub path: String,
    pub name: String,
    pub last_opened_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderDetail {
    pub id: i32,
    pub name: String,
    pub path: String,
    /// 只供宿主与共享 catalog 寻址，不改变既有前端 DTO。
    #[serde(skip)]
    pub project_runtime_id: String,
    pub git_branch: Option<String>,
    pub default_agent_type: Option<AgentType>,
    pub last_opened_at: DateTime<Utc>,
    pub sort_order: i32,
    pub color: String,
    /// Root folder this one was created under (worktree folders only); NULL for
    /// top-level folders. Drives sidebar merge + worktree-branch detection.
    pub parent_id: Option<i32>,
    /// Folder classification (mirrors `folder.kind`). `chat` folders are kept in
    /// `allFolders` (so cwd / active-folder resolve) but hidden from folder
    /// lists; their conversations route to the sidebar "Chat" group.
    pub kind: FolderKind,
    /// User-supplied display alias, or NULL when unset. When present the sidebar
    /// folder header and conversation header render `alias [name]`.
    pub alias: Option<String>,
    /// When the user pinned this folder; `None` means not pinned.
    pub pinned_at: Option<DateTime<Utc>>,
}
