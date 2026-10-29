use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_column("primary_tab", "launch_source").await? {
            manager
                .get_connection()
                .execute_unprepared("ALTER TABLE primary_tab ADD COLUMN launch_source TEXT NULL")
                .await?;
        }
        if !manager.has_column("primary_tab", "last_known_cwd").await? {
            manager
                .get_connection()
                .execute_unprepared("ALTER TABLE primary_tab ADD COLUMN last_known_cwd TEXT NULL")
                .await?;
        }

        // A lossless, read-only inventory of records that cannot participate in
        // the folder-only runtime projection. Original rows are intentionally
        // retained; this migration never deletes transcripts or tab metadata.
        manager
            .create_table(
                Table::create()
                    .table(LegacyResourceArchive::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(LegacyResourceArchive::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(LegacyResourceArchive::ResourceKind)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(LegacyResourceArchive::ResourceKey)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(LegacyResourceArchive::Payload)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(LegacyResourceArchive::ArchivedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .index(
                        Index::create()
                            .name("uq_legacy_resource_archive_kind_key")
                            .col(LegacyResourceArchive::ResourceKind)
                            .col(LegacyResourceArchive::ResourceKey)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                INSERT OR IGNORE INTO legacy_resource_archive
                    (resource_kind, resource_key, payload)
                SELECT
                    'conversation',
                    CAST(conversation.id AS TEXT),
                    json_object(
                        'id', conversation.id,
                        'folderId', conversation.folder_id,
                        'agentType', conversation.agent_type,
                        'status', conversation.status,
                        'title', conversation.title,
                        'createdAt', conversation.created_at,
                        'updatedAt', conversation.updated_at
                    )
                FROM conversation
                INNER JOIN folder ON folder.id = conversation.folder_id
                WHERE folder.kind = 'chat' OR conversation.kind = 'chat'
                "#,
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                INSERT OR IGNORE INTO legacy_resource_archive
                    (resource_kind, resource_key, payload)
                SELECT
                    'terminal_tab',
                    primary_tab.tab_key,
                    json_object(
                        'tabKey', primary_tab.tab_key,
                        'terminalId', primary_tab.terminal_id,
                        'backendInstanceId', primary_tab.backend_instance_id,
                        'title', primary_tab.title,
                        'initialCwd', primary_tab.initial_cwd,
                        'shell', primary_tab.shell,
                        'position', primary_tab.position,
                        'isPinned', primary_tab.is_pinned
                    )
                FROM primary_tab
                WHERE primary_tab.kind = 'terminal'
                  AND primary_tab.folder_id IS NULL
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(LegacyResourceArchive::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum LegacyResourceArchive {
    Table,
    Id,
    ResourceKind,
    ResourceKey,
    Payload,
    ArchivedAt,
}
