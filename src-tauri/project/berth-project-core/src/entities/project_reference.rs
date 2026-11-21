use sea_orm::entity::prelude::*;

/// 项目的参考成员（参考项目、资料目录）：手动加减，只是路径引用，不占 folder 归属，
/// 同一路径可进多个项目。成员与项目同在本机。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "project_reference")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub project_id: i32,
    pub path: String,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
