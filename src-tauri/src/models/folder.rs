use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::AgentType;

// 项目（folder）投影类型定义在共享 crate，桌面宿主只再导出：
// GUI 与 CLI 必须消费同一 DTO，不允许第二份形状。
pub use berth_project_core::service::folder::{FolderDetail, FolderHistoryEntry};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenedTab {
    pub id: i32,
    pub folder_id: i32,
    pub conversation_id: Option<i32>,
    pub agent_type: AgentType,
    pub position: i32,
    pub is_active: bool,
    pub is_pinned: bool,
}

/// Response for `list_opened_tabs`: the persisted tab set plus the current
/// workspace tab version. Clients seed their compare-and-set / echo logic from
/// `version`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTabsSnapshot {
    pub items: Vec<OpenedTab>,
    pub version: i64,
}

/// Response for `save_opened_tabs`: whether the compare-and-set was applied, the
/// authoritative version after the call, and the canonical tab set. When
/// `accepted` is false the save was stale (another client won) and `tabs` is the
/// current truth to reconcile against.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTabsOutcome {
    pub accepted: bool,
    pub version: i64,
    pub tabs: Vec<OpenedTab>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTab {
    pub id: String,
    pub folder_id: i32,
    pub conversation_id: i32,
    pub agent_type: AgentType,
    pub title: String,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTab {
    pub id: String,
    pub terminal_id: String,
    pub backend_instance_id: String,
    pub folder_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_source: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    pub title: String,
    pub initial_cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_known_cwd: Option<String>,
    pub shell: String,
    pub detached_folder_label: Option<String>,
    pub detached_folder_path: Option<String>,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrimaryTab {
    Conversation(ConversationTab),
    Terminal(TerminalTab),
}

impl PrimaryTab {
    pub fn id(&self) -> &str {
        match self {
            Self::Conversation(tab) => &tab.id,
            Self::Terminal(tab) => &tab.id,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryTabsSnapshot {
    pub items: Vec<PrimaryTab>,
    pub version: i64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavePrimaryTabsRejection {
    VersionConflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePrimaryTabsOutcome {
    pub accepted: bool,
    pub version: i64,
    pub tabs: Vec<PrimaryTab>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection: Option<SavePrimaryTabsRejection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderCommandInfo {
    pub id: i32,
    pub folder_id: i32,
    pub name: String,
    pub command: String,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
