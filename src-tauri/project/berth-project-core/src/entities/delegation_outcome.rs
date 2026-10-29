use sea_orm::entity::prelude::*;

/// Durable terminal result for one delegation task. This is intentionally
/// delegation-scoped and must not be used as a generic conversation lifecycle.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "delegation_outcome")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub delegation_call_id: String,
    pub child_conversation_id: i32,
    pub parent_conversation_id: Option<i32>,
    pub agent_type: String,
    pub status: String,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub completed_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
