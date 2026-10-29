use sea_orm::entity::prelude::*;

/// 服务商对某一 Agent 的 overlay(Claude 四档或模型 id 列表)。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "model_provider_overlay")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub provider_id: i32,
    #[sea_orm(primary_key, auto_increment = false)]
    pub agent_type: String,
    pub models_json: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
