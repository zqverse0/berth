use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_setting")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub agent_type: String,
    pub registry_id: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub installed_version: Option<String>,
    pub env_json: Option<String>,
    pub model_provider_id: Option<i32>,
    /// 绑定档案内选中的具体模型键(claude 档案 model 是角色 JSON,如
    /// {"main":..,"reasoning":..});NULL = 未选具体模型。
    pub model_key: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
