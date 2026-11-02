//! 设备只保留节点方式（经节点连接操作对方的 Berth）：sshfs 挂载的远程项目下线，`device_project` 表删除。
//! 原先挂载出来的项目仍是普通项目行（路径是本机挂载点），由用户自行移除。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(DeviceProject::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }

    /// 不恢复：挂载方式已下线。
    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

#[derive(DeriveIden)]
enum DeviceProject {
    Table,
}
