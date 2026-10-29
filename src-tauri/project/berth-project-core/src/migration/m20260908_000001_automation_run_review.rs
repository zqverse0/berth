use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite 一次 ALTER 只支持单个操作,分两条执行。
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("automation_run"))
                    .add_column(
                        ColumnDef::new(Alias::new("reviewed_at"))
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("automation_run"))
                    .add_column(ColumnDef::new(Alias::new("result_path")).string().null())
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("automation_run"))
                    .drop_column(Alias::new("result_path"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("automation_run"))
                    .drop_column(Alias::new("reviewed_at"))
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}
