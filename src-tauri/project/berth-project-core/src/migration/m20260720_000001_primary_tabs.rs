use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PrimaryTab::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PrimaryTab::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PrimaryTab::TabKey)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(PrimaryTab::Kind).string().not_null())
                    .col(ColumnDef::new(PrimaryTab::FolderId).integer().null())
                    .col(ColumnDef::new(PrimaryTab::ConversationId).integer().null())
                    .col(ColumnDef::new(PrimaryTab::AgentType).string().null())
                    .col(ColumnDef::new(PrimaryTab::TerminalId).string().null())
                    .col(
                        ColumnDef::new(PrimaryTab::BackendInstanceId)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PrimaryTab::Title)
                            .string()
                            .not_null()
                            .default(""),
                    )
                    .col(ColumnDef::new(PrimaryTab::InitialCwd).string().null())
                    .col(ColumnDef::new(PrimaryTab::Shell).string().null())
                    .col(
                        ColumnDef::new(PrimaryTab::DetachedFolderLabel)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PrimaryTab::DetachedFolderPath)
                            .string()
                            .null(),
                    )
                    .col(ColumnDef::new(PrimaryTab::Position).integer().not_null())
                    .col(
                        ColumnDef::new(PrimaryTab::IsPinned)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(PrimaryTab::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PrimaryTab::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(PrimaryTab::Table, PrimaryTab::FolderId)
                            .to(Folder::Table, Folder::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(PrimaryTab::Table, PrimaryTab::ConversationId)
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_primary_tab_position")
                    .table(PrimaryTab::Table)
                    .col(PrimaryTab::Position)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_primary_tab_folder_id")
                    .table(PrimaryTab::Table)
                    .col(PrimaryTab::FolderId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_primary_tab_terminal_id")
                    .table(PrimaryTab::Table)
                    .col(PrimaryTab::TerminalId)
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                INSERT INTO primary_tab (
                    tab_key, kind, folder_id, conversation_id, agent_type,
                    terminal_id, backend_instance_id, title, initial_cwd, shell,
                    detached_folder_label, detached_folder_path, position,
                    is_pinned, created_at, updated_at
                )
                SELECT
                    'conv-' || opened_tab.folder_id || '-' || opened_tab.agent_type || '-' || opened_tab.conversation_id,
                    'conversation',
                    opened_tab.folder_id,
                    opened_tab.conversation_id,
                    opened_tab.agent_type,
                    NULL,
                    NULL,
                    COALESCE(conversation.title, ''),
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    opened_tab.position,
                    opened_tab.is_pinned,
                    opened_tab.created_at,
                    opened_tab.updated_at
                FROM opened_tab
                LEFT JOIN conversation ON conversation.id = opened_tab.conversation_id
                WHERE opened_tab.conversation_id IS NOT NULL
                "#,
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                INSERT OR IGNORE INTO app_metadata (
                    key, value, created_at, updated_at, deleted_at
                )
                VALUES (
                    'primary_tabs_version',
                    COALESCE(
                        (SELECT value FROM app_metadata
                         WHERE key = 'opened_tabs_version' AND deleted_at IS NULL),
                        '0'
                    ),
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP,
                    NULL
                )
                "#,
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(PrimaryTab::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum PrimaryTab {
    Table,
    Id,
    TabKey,
    Kind,
    FolderId,
    ConversationId,
    AgentType,
    TerminalId,
    BackendInstanceId,
    Title,
    InitialCwd,
    Shell,
    DetachedFolderLabel,
    DetachedFolderPath,
    Position,
    IsPinned,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, ActiveValue::NotSet, ConnectionTrait, Database, EntityTrait, Set};
    use sea_orm_migration::MigratorTrait;

    use crate::entities::{opened_tab, primary_tab};
    use crate::migration::Migrator;
    use crate::service::app_metadata_service;

    #[tokio::test]
    async fn migrates_legacy_conversation_tabs_and_version_without_active_state() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let primary_idx = migrations
            .iter()
            .position(|migration| migration.name().contains("primary_tabs"))
            .expect("primary tabs migration registered");
        Migrator::up(&conn, Some(primary_idx as u32))
            .await
            .expect("legacy migrations");

        // 只跑到本迁移之前，库表是旧结构：用 SQL 直接写旧行，不经当前实体（会带上后来加的列）。
        conn.execute_unprepared(
            "INSERT INTO folder (name, path, last_opened_at, created_at, updated_at)
             VALUES ('m', '/tmp/codeg-primary-tab-migration', '2026-01-01T00:00:00Z',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO conversation (folder_id, title, agent_type, created_at, updated_at)
             VALUES (1, 'Migrated', 'codex', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
        )
        .await
        .expect("legacy rows");
        let (folder_id, conversation_id) = (1, 1);
        let now = Utc::now();
        opened_tab::ActiveModel {
            id: NotSet,
            folder_id: Set(folder_id),
            conversation_id: Set(Some(conversation_id)),
            agent_type: Set("codex".to_string()),
            position: Set(4),
            is_active: Set(true),
            is_pinned: Set(true),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&conn)
        .await
        .expect("legacy tab");
        app_metadata_service::upsert_value(&conn, "opened_tabs_version", "7")
            .await
            .expect("legacy version");

        Migrator::up(&conn, None).await.expect("primary migration");

        let rows = primary_tab::Entity::find().all(&conn).await.expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "conversation");
        assert_eq!(rows[0].conversation_id, Some(conversation_id));
        assert_eq!(rows[0].position, 4);
        assert!(rows[0].is_pinned);
        assert_eq!(rows[0].title, "Migrated");
        assert_eq!(
            app_metadata_service::get_value(&conn, "primary_tabs_version")
                .await
                .expect("primary version"),
            Some("7".to_string())
        );
    }
}
