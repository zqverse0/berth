//! 会话（conversation）行的插入路径。
//!
//! 只包含 `create` / `create_chat` / `create_with_delegation` 与内部
//! `create_inner`：迁移测试（schema owner 自己的测试）依赖这条插入路径，
//! 而查询路径仍留在桌面宿主的 `db/service/conversation_service.rs`（它依赖
//! session 索引等宿主侧类型）。**不复制实现**：宿主侧以 `pub use` 桥复用这里。

use chrono::Utc;
use sea_orm::{ActiveModelTrait, ActiveValue::NotSet, DatabaseConnection, Set};

use crate::agent::AgentType;
use crate::entities::conversation::ConversationKind;
use crate::entities::conversation;
use crate::error::DbError;
use crate::service::delegation::DelegationLink;

pub async fn create(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
) -> Result<conversation::Model, DbError> {
    create_inner(
        conn,
        folder_id,
        agent_type,
        title,
        git_branch,
        None,
        ConversationKind::Regular,
    )
    .await
}

/// Mirror of [`create`] for folderless chat-mode conversations: identical row
/// shape but `kind = 'chat'`, so the sidebar routes the row to its flat "Chat"
/// section. Callers must pair it with the hidden chat folder created in the
/// same flow (`create_chat_conversation_core`).
pub async fn create_chat(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
) -> Result<conversation::Model, DbError> {
    create_inner(
        conn,
        folder_id,
        agent_type,
        title,
        git_branch,
        None,
        ConversationKind::Chat,
    )
    .await
}

/// Mirror of [`create`] plus optional delegation linkage. Used by the
/// multi-agent broker when spawning a child sub-session — populates
/// `parent_id` / `parent_tool_use_id` / `delegation_call_id` so the lifecycle
/// subscriber and frontend can rebuild the parent ↔ child binding without
/// inspecting the live broker state. `kind` follows the invariant
/// `delegate ⟺ parent_id set`.
pub async fn create_with_delegation(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
    delegation: Option<DelegationLink>,
) -> Result<conversation::Model, DbError> {
    let kind = if delegation.is_some() {
        ConversationKind::Delegate
    } else {
        ConversationKind::Regular
    };
    create_inner(
        conn, folder_id, agent_type, title, git_branch, delegation, kind,
    )
    .await
}

async fn create_inner(
    conn: &DatabaseConnection,
    folder_id: i32,
    agent_type: AgentType,
    title: Option<String>,
    git_branch: Option<String>,
    delegation: Option<DelegationLink>,
    kind: ConversationKind,
) -> Result<conversation::Model, DbError> {
    let at_str = serde_json::to_value(agent_type)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    let now = Utc::now();
    let (parent_id, parent_tool_use_id, delegation_call_id) = match delegation {
        Some(link) => (
            Some(link.parent_conversation_id),
            Some(link.parent_tool_use_id),
            Some(link.delegation_call_id),
        ),
        None => (None, None, None),
    };
    let model = conversation::ActiveModel {
        id: NotSet,
        folder_id: Set(folder_id),
        title: Set(title),
        title_locked: Set(false),
        agent_type: Set(at_str),
        kind: Set(kind),
        model: Set(None),
        git_branch: Set(git_branch),
        external_id: Set(None),
        // 历史列由已执行迁移保留；新会话不再写入 Expert 绑定。
        expert_snapshot_id: Set(None),
        expert_runtime_id: Set(None),
        parent_id: Set(parent_id),
        parent_tool_use_id: Set(parent_tool_use_id),
        delegation_call_id: Set(delegation_call_id),
        message_count: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        pinned_at: Set(None),
    };
    Ok(model.insert(conn).await?)
}
