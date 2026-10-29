use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use berth_project_core::entities::{conversation, delegation_outcome};
use berth_project_core::error::DbError;

pub struct DelegationOutcomeWrite<'a> {
    pub delegation_call_id: &'a str,
    pub child_conversation_id: i32,
    pub agent_type: &'a str,
    pub status: &'a str,
    pub error_code: Option<&'a str>,
    pub message: Option<&'a str>,
}

pub async fn record_terminal(
    conn: &DatabaseConnection,
    write: DelegationOutcomeWrite<'_>,
) -> Result<(), DbError> {
    let parent_conversation_id = conversation::Entity::find_by_id(write.child_conversation_id)
        .one(conn)
        .await?
        .and_then(|row| row.parent_id);
    let model = delegation_outcome::ActiveModel {
        delegation_call_id: Set(write.delegation_call_id.to_string()),
        child_conversation_id: Set(write.child_conversation_id),
        parent_conversation_id: Set(parent_conversation_id),
        agent_type: Set(write.agent_type.to_string()),
        status: Set(write.status.to_string()),
        error_code: Set(write.error_code.map(str::to_string)),
        message: Set(write.message.map(str::to_string)),
        completed_at: Set(Utc::now()),
    };
    delegation_outcome::Entity::insert(model)
        .on_conflict(
            OnConflict::column(delegation_outcome::Column::DelegationCallId)
                .update_columns([
                    delegation_outcome::Column::ChildConversationId,
                    delegation_outcome::Column::ParentConversationId,
                    delegation_outcome::Column::AgentType,
                    delegation_outcome::Column::Status,
                    delegation_outcome::Column::ErrorCode,
                    delegation_outcome::Column::Message,
                    delegation_outcome::Column::CompletedAt,
                ])
                .to_owned(),
        )
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn find_by_call_id(
    conn: &DatabaseConnection,
    call_id: &str,
) -> Result<Option<delegation_outcome::Model>, DbError> {
    Ok(delegation_outcome::Entity::find()
        .filter(delegation_outcome::Column::DelegationCallId.eq(call_id))
        .one(conn)
        .await?)
}
