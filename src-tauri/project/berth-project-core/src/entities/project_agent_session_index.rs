use sea_orm::entity::prelude::*;

/// Durable metadata projection of one provider-native Agent session.
/// Transcript bodies remain in the provider store and are never copied here.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "project_agent_session_index")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub agent_type: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub external_id: String,
    pub source_locator: String,
    pub source_kind: String,
    pub normalized_project_path: String,
    pub fingerprint: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub message_count: i32,
    pub started_at: DateTimeUtc,
    pub activity_at: DateTimeUtc,
    pub source_available: bool,
    pub index_schema_version: i32,
    pub adapter_version: i32,
    pub last_seen_generation: i64,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
