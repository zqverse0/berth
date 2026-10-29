use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const IDX_EXPERT_BINDING: &str = "idx_conversation_expert_binding";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::ExpertSnapshotId)
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::ExpertRuntimeId)
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name(IDX_EXPERT_BINDING)
                    .table(Conversation::Table)
                    .col(Conversation::ExpertSnapshotId)
                    .col(Conversation::ExpertRuntimeId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .if_exists()
                    .name(IDX_EXPERT_BINDING)
                    .table(Conversation::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::ExpertRuntimeId)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::ExpertSnapshotId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    ExpertSnapshotId,
    ExpertRuntimeId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[tokio::test]
    async fn up_adds_nullable_binding_columns_and_composite_index() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT)",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO conversation (title) VALUES ('legacy')")
            .await
            .expect("insert legacy row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration");

        let row = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT expert_snapshot_id, expert_runtime_id FROM conversation".to_owned(),
            ))
            .await
            .expect("query legacy row")
            .expect("legacy row");
        let snapshot: Option<String> = row
            .try_get("", "expert_snapshot_id")
            .expect("snapshot column");
        let runtime: Option<String> = row
            .try_get("", "expert_runtime_id")
            .expect("runtime column");
        assert_eq!((snapshot, runtime), (None, None));

        let indexes = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "PRAGMA index_list('conversation')".to_owned(),
            ))
            .await
            .expect("list indexes");
        assert!(indexes.iter().any(|row| {
            row.try_get::<String>("", "name")
                .is_ok_and(|name| name == IDX_EXPERT_BINDING)
        }));
    }
}
