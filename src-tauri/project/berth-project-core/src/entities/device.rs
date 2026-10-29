use sea_orm::entity::prelude::*;

/// 可连接的其他设备。Berth 只记「名称 → SSH 目标」：网络（Tailscale、局域网……）和
/// 登录细节（用户、端口、密钥、跳板机）归 OpenSSH（`~/.ssh/config`），这里不重复保存。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "device")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(unique)]
    pub name: String,
    /// 传给 `ssh` 的目标：`user@host`、域名或 `~/.ssh/config` 里的 Host 别名。
    pub ssh_target: String,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
