use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::agent::AgentType;
use super::message::{MessageTurn, TurnUsage};
use berth_project_core::entities::conversation::ConversationKind;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub agent_type: AgentType,
    pub folder_path: Option<String>,
    pub folder_name: Option<String>,
    pub title: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub message_count: u32,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegation_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DbConversationSummary {
    pub id: i32,
    pub folder_id: i32,
    pub title: Option<String>,
    /// Mirror of `conversation.title_locked`: the user renamed this row by hand,
    /// so the auto-title backfill must leave it alone.
    pub title_locked: bool,
    pub agent_type: AgentType,
    /// Mirrors `conversation.kind` — drives sidebar visibility/grouping
    /// (serialized as "regular" | "chat" | "loop" | "delegate").
    pub kind: ConversationKind,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub external_id: Option<String>,
    pub message_count: u32,
    /// Number of direct, non-deleted delegation children. Drives the sidebar
    /// chevron: a row with `child_count > 0` is expandable into its sub-session
    /// subtree. Not stored on the row — computed by a single GROUP BY aggregate
    /// (`fill_child_counts`) over the returned set, so `child_count > 0` iff
    /// `list_children` would return rows. Always serialized (the frontend reads
    /// `child_count` to decide chevron visibility).
    pub child_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Mirror of `conversation.pinned_at`: when set, the sidebar shows this row in
    /// its "Pinned" section (sorted by this timestamp descending) instead of its
    /// folder group. Serialized as `null` when absent so the frontend's
    /// `pinned_at: string | null` always sees the field.
    pub pinned_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegation_call_id: Option<String>,
}

/// Request for one bounded project + Agent history page.
///
/// `limit` is a hint only: the command clamps it to the server-owned range.
/// The scan budget is deliberately absent so clients cannot turn one request
/// back into an unbounded transcript walk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentSessionPageRequest {
    pub folder_id: i32,
    /// agent 标识 = tool.json Agent 扩展的 `projectType`(文件驱动,任意字符串)。
    /// 特化枚举在 core 入口解析,未知栏位安静降级为空页。
    pub agent_type: String,
    pub cursor: Option<String>,
    pub search: Option<String>,
    pub limit: Option<u32>,
    /// Bypass an already-complete persistent index for one bounded provider
    /// reconciliation pass (used after a native-store invalidation).
    #[serde(default)]
    pub refresh: bool,
}

/// Origin relationship between one browser row and Berth's conversation DB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectAgentSessionSource {
    NativeOnly,
    Both,
    DatabaseOnly,
}

/// Unified, bounded project-browser row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentSessionSummary {
    pub agent_type: AgentType,
    pub external_id: Option<String>,
    pub conversation_id: Option<i32>,
    /// Full DB projection when this row is already persisted. Bounded page
    /// size keeps this cheap and lets existing detail/resume UI reuse its
    /// established conversation contract without a second summary request.
    pub conversation: Option<DbConversationSummary>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub message_count: u32,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub source: ProjectAgentSessionSource,
    /// `Some(true)` is proven by a native summary. `Some(false)` is only set
    /// after a targeted lookup proves the source disappeared. `None` means a
    /// bounded page has not inspected that DB row's native candidate yet.
    pub source_available: Option<bool>,
}

/// One independently bounded DB + native page. The cursor owns both source
/// frontiers and is opaque to clients.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentSessionPage {
    pub items: Vec<ProjectAgentSessionSummary>,
    pub next_cursor: Option<String>,
    pub scan_complete: bool,
    pub source_warning: Option<String>,
}

/// Result of resolving a selected native-only row into a single DB row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveProjectAgentSessionResult {
    pub conversation: Option<DbConversationSummary>,
    pub source_available: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStats {
    pub total_usage: Option<TurnUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    pub total_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_used_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window_usage_percent: Option<f64>,
}

/// 启动时注入给 Agent 的一项上下文，来自 `sessions.json` 的 `context` 声明。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextSource {
    /// 声明的来源类别（`system`、`instructions`、`skills`…），宿主不解释。
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 来源文件（如指令文件）的路径，查看器据此提供打开入口。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 正文的估算 token（`berth_tool_core::sessions::estimate_tokens`），只作大小比较。
    pub tokens: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationDetail {
    pub summary: ConversationSummary,
    pub turns: Vec<MessageTurn>,
    /// 启动时注入的上下文，按首次出现排列，同一内容只留一份。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<ContextSource>,
    /// 来源 Agent 声明的会话级字段。宿主不解释其含义，由通用会话查看器按键值展示。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub session_fields: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    /// Byte length of the source transcript this parse consumed (exact — the
    /// parser measures the buffer it read, never a racy stat). Present only
    /// for parsers reading a single session file (Claude today; `None`
    /// elsewhere). The frontend retires background-overlay turns
    /// (when a background transcript scan reports activity) whose `watermark <=` this value once
    /// a detail (re)fetch catches up — the race-free hand-off between the
    /// live overlay and persisted turns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_watermark: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DbConversationDetail {
    pub summary: DbConversationSummary,
    pub turns: Vec<MessageTurn>,
    /// 见 [`ConversationDetail::context`]。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<ContextSource>,
    /// 从声明式原生会话转发的会话级字段。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub session_fields: BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    /// See [`ConversationDetail::transcript_watermark`] — threaded through from
    /// the parser detail on the DB-backed fetch path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_watermark: Option<u64>,
    /// Id of the persisted user turn the live-correlation pass identified as the
    /// in-flight prompt (only present while a turn is running on this
    /// conversation's connection; `None` otherwise). The frontend uses it to
    /// locate — and, while the live reply is in hand, hide — the partial
    /// assistant turn some agents (OpenCode, Gemini) persist after the prompt
    /// mid-stream, which would otherwise double-render against the live reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_flight_user_turn_id: Option<String>,
    /// 读取前的源文件变化标记，见 `get_conversation_source_revision`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    /// 会话在项目群里的归属；项目没有群或会话不在任何群目录下时为空。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_link: Option<SessionGroupLink>,
}

/// 会话所属群、来源与在跑成员（与侧栏「会话」视图同一推导）。
#[derive(Debug, Clone, Serialize)]
pub struct SessionGroupLink {
    /// 群的内部名（读写群账本用）。
    pub group: String,
    pub group_name: String,
    pub group_dir: String,
    /// 群目录还在（收尾删掉的 worktree 不能再在里面启动 Agent）。
    pub group_dir_exists: bool,
    /// 主项目目录（主项目群 `main` 在这里，知识库专家在这个群）。
    pub main_dir: String,
    /// `berth` / `external` / `unknown`。
    pub origin: &'static str,
    pub live_member: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderInfo {
    pub path: String,
    pub name: String,
    pub agent_types: Vec<AgentType>,
    pub conversation_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStats {
    pub total_conversations: u32,
    pub total_messages: u32,
    pub by_agent: Vec<AgentConversationCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConversationCount {
    pub agent_type: AgentType,
    pub conversation_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarData {
    pub folders: Vec<FolderInfo>,
    pub stats: AgentStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub imported: u32,
    /// Already-imported conversations whose title was refreshed from the
    /// agent's session file (e.g. an AI-generated title that did not yet exist
    /// at first import). Manual renames are never touched.
    pub updated: u32,
    pub skipped: u32,
}

/// Reconciliation state of one locally-discovered session against the codeg DB,
/// keyed by `(external_id, agent_type)` — the same identity `import_one` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanSessionStatus {
    /// Not in the DB — importable.
    New,
    /// At least one live (non-deleted) row exists — already imported.
    Imported,
    /// Only soft-deleted rows exist — never resurrected by import.
    Deleted,
}

/// One locally-discovered agent session in the import-picker scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSession {
    /// The agent's own session id (`ConversationSummary::id`).
    pub external_id: String,
    pub agent_type: AgentType,
    pub title: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub message_count: u32,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub status: ScanSessionStatus,
}

/// One folder group in the import-picker scan: all sessions sharing a
/// normalize-matched cwd, plus how that path reconciles against the `folder`
/// table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanFolder {
    /// Display/import path. When a folder row normalize-matches the sessions'
    /// cwd this is the ROW's stored string (the unique key `add_folder` upserts
    /// on), so importing can never mint a near-duplicate row from a trailing-
    /// slash or separator variant.
    pub path: String,
    pub name: String,
    /// A live (non-deleted) folder row exists for this path. `false` with a
    /// `folder_id` means the row is soft-deleted and import will reopen it.
    pub exists_in_berth: bool,
    pub folder_id: Option<i32>,
    pub agent_types: Vec<AgentType>,
    pub sessions: Vec<ScanSession>,
}

/// Result of scanning every local agent's sessions for the import picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub folders: Vec<ScanFolder>,
    /// Sessions whose transcript carries no cwd — not importable (an import
    /// target folder cannot be derived), surfaced only as a count.
    pub no_folder_count: u32,
    pub total_sessions: u32,
    pub importable_count: u32,
}

/// Selection key sent back by the import picker: identifies one scanned
/// session by the same `(agent_type, external_id)` identity the DB dedups on.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSessionKey {
    pub agent_type: AgentType,
    pub external_id: String,
}

/// Per-folder tally of one batch import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportFolderOutcome {
    pub path: String,
    pub folder_id: i32,
    /// No live folder row existed before this import (freshly created, or a
    /// soft-deleted row was reopened).
    pub created: bool,
    pub imported: u32,
    pub updated: u32,
    pub skipped: u32,
}

/// Aggregate result of `import_selected_sessions`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSelectedResult {
    pub imported: u32,
    pub updated: u32,
    pub skipped: u32,
    /// Selection keys that no longer resolved to a scanned session (deleted on
    /// disk between scan and import, or bogus input).
    pub not_found: u32,
    /// Sessions that failed because their folder group errored.
    pub failed: u32,
    pub created_folders: u32,
    pub folders: Vec<ImportFolderOutcome>,
    /// Human-readable per-folder failure messages, capped by the command.
    pub errors: Vec<String>,
}
