use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(DelegationOutcome::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(DelegationOutcome::DelegationCallId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(DelegationOutcome::ChildConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(DelegationOutcome::ParentConversationId).integer())
                    .col(
                        ColumnDef::new(DelegationOutcome::AgentType)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DelegationOutcome::Status)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(DelegationOutcome::ErrorCode).string())
                    .col(ColumnDef::new(DelegationOutcome::Message).text())
                    .col(
                        ColumnDef::new(DelegationOutcome::CompletedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_delegation_outcome_parent")
                    .table(DelegationOutcome::Table)
                    .col(DelegationOutcome::ParentConversationId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(DelegationOutcome::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum DelegationOutcome {
    Table,
    DelegationCallId,
    ChildConversationId,
    ParentConversationId,
    AgentType,
    Status,
    ErrorCode,
    Message,
    CompletedAt,
}
