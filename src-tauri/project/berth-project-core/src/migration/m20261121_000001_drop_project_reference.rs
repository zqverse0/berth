//! 参考目录下线：空间只有主项目与 worktree，`project_reference` 表删除。磁盘上的目录不动。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(ProjectReference::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }

    /// 不恢复：参考目录已下线。
    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

#[derive(DeriveIden)]
enum ProjectReference {
    Table,
}
