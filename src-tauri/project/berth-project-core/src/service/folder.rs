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
    /// Folder classification (mirrors `folder.kind`). `chat` folders are kept in
    /// `allFolders` (so cwd / active-folder resolve) but hidden from folder
    /// lists; their conversations route to the sidebar "Chat" group.
    pub kind: FolderKind,
    /// 所属项目；chat folder 为 NULL。
    pub project_id: Option<i32>,
    /// 所属项目的属性（每个成员都带同一份）；chat folder 为 `None`。
    pub project: Option<ProjectSummary>,
}

impl FolderDetail {
    /// 自己是所属项目的主成员。
    pub fn is_main(&self) -> bool {
        self.project
            .as_ref()
            .is_some_and(|project| project.main_folder_id == self.id)
    }
}

/// 项目级属性：项目名、主成员、置顶、排序只存在项目表，folder 行不再有。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub name: String,
    pub main_folder_id: i32,
    pub pinned_at: Option<DateTime<Utc>>,
    pub sort_order: i32,
    /// 空间目录（任务、群组、想法、知识库；见 [`crate::space`]）。从 id 派生，不存库；进程未配置空间时为空。
    pub dir: Option<String>,
}

/// 项目的代码成员（[`crate::service::folder_service::read_members`]；分支现读 git）。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectMember {
    #[serde(flatten)]
    pub folder: FolderDetail,
    /// 当前分支（来自 `git worktree list`；git 不可用时是登记时记下的分支）。
    pub branch: Option<String>,
    /// 失效：目录不在（只给「清理」）。
    pub stale: bool,
    /// 临时：自动化每次运行建的 worktree，或所属群的任务都已结束。
    pub temporary: bool,
}

/// 项目视图：`berth project . member ls --json` 与 launch.js 的 `ctx.project` 同一份。
/// 怎么用（交给 `--add-dir`、有 Agent 在跑的检出给不给写）由插件决定。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectView {
    pub name: String,
    /// 主成员目录（放 `.berth/` 的 checkout）。
    pub home: String,
    /// 代码成员（main 与各 worktree），主成员在前。
    pub checkouts: Vec<CheckoutView>,
    /// git 里有、还没登记进任何项目的检出：只提示，用户决定是否加入。
    pub untracked: Vec<UntrackedCheckout>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UntrackedCheckout {
    pub path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckoutView {
    pub path: String,
    pub branch: Option<String>,
    pub main: bool,
    pub stale: bool,
    pub temporary: bool,
    /// 在这个检出里跑的 Agent；由能看到终端的一方（CLI）填，共享 crate 只给空表。
    pub agents: Vec<RunningAgent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningAgent {
    /// 插件 id（`tools/<id>/launch.js`）。
    pub agent: String,
    /// 终端短名，如 `berth-dev:3`。
    pub terminal: String,
}
