use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::ConnectionTrait;

/// 自定义档案解绑单一 agent_type；overlay + allowlist + flavor + discovery。
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .add_column(
                        ColumnDef::new(ModelProvider::Flavor)
                            .text()
                            .not_null()
                            .default("openai"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .add_column(ColumnDef::new(ModelProvider::DiscoveryJson).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .add_column(
                        ColumnDef::new(ModelProvider::AgentAllowlist)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ModelProviderOverlay::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ModelProviderOverlay::ProviderId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ModelProviderOverlay::AgentType)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ModelProviderOverlay::ModelsJson)
                            .text()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(ModelProviderOverlay::ProviderId)
                            .col(ModelProviderOverlay::AgentType),
                    )
                    .to_owned(),
            )
            .await?;

        // 旧自定义：model JSON → overlay；agent_type → allowlist；再清空单一栏位。
        manager
            .get_connection()
            .execute_unprepared(
                r#"
INSERT INTO model_provider_overlay (provider_id, agent_type, models_json)
SELECT id, agent_type, model
FROM model_provider
WHERE kind = 'custom'
  AND agent_type IS NOT NULL
  AND trim(agent_type) != ''
  AND model IS NOT NULL
  AND trim(model) != '';
"#,
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                r#"
UPDATE model_provider
SET agent_allowlist = json_array(agent_type)
WHERE kind = 'custom'
  AND agent_type IS NOT NULL
  AND trim(agent_type) != '';
"#,
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                r#"
UPDATE model_provider
SET agent_type = '', agent_types_json = '[]'
WHERE kind = 'custom';
"#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(ModelProviderOverlay::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .drop_column(ModelProvider::Flavor)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .drop_column(ModelProvider::DiscoveryJson)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .drop_column(ModelProvider::AgentAllowlist)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ModelProvider {
    Table,
    Flavor,
    DiscoveryJson,
    AgentAllowlist,
}

#[derive(DeriveIden)]
enum ModelProviderOverlay {
    Table,
    ProviderId,
    AgentType,
    ModelsJson,
}
