use sea_orm::entity::prelude::*;

/// 远程项目：项目（`folder`，路径是本机挂载点）在哪台设备的哪个目录。没有这一行的项目都是本地项目。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "device_project")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub folder_id: i32,
    pub device_id: i32,
    /// 设备上的目录：绝对路径，或相对 SSH 登录目录（家目录）的路径。
    pub remote_path: String,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
