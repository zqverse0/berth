use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("automation"))
                    .add_column(
                        ColumnDef::new(Alias::new("missed_run_grace_minutes"))
                            .integer()
                            .not_null()
                            .default(720),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("automation_run"))
                    .add_column(ColumnDef::new(Alias::new("terminal_id")).string().null())
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
                    .drop_column(Alias::new("terminal_id"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("automation"))
                    .drop_column(Alias::new("missed_run_grace_minutes"))
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}
