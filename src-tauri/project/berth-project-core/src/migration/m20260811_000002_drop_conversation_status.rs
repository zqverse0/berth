use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// `conversation.status` mixed user-archive state with runtime outcomes. Runtime
/// state now belongs to ACP connections, automation runs, delegation outcomes,
/// and chat-channel bridges, so conversation rows retain history metadata only.
///
/// Downgrading restores only structural compatibility with a default value; the
/// removed historical meaning cannot be reconstructed. Runtime rollback must use
/// a pre-migration database backup together with the old binary.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::Status)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::Status)
                            .string()
                            .not_null()
                            .default("in_progress"),
                    )
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Status,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[tokio::test]
    async fn up_removes_only_status_and_preserves_row_data() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE conversation (id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL, delegation_call_id TEXT, deleted_at TEXT, pinned_at TEXT)",
        )
        .await
        .expect("create conversation");
        conn.execute_unprepared(
            "INSERT INTO conversation VALUES (7, 'kept', 'completed', 'call-1', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')",
        )
        .await
        .expect("seed row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("drop status");

        let columns = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "PRAGMA table_info('conversation')".to_owned(),
            ))
            .await
            .expect("list columns");
        assert!(!columns.iter().any(|row| {
            row.try_get::<String>("", "name")
                .is_ok_and(|name| name == "status")
        }));

        let row = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id, title, delegation_call_id, deleted_at, pinned_at FROM conversation"
                    .to_owned(),
            ))
            .await
            .expect("query row")
            .expect("preserved row");
        assert_eq!(row.try_get::<i32>("", "id").unwrap(), 7);
        assert_eq!(row.try_get::<String>("", "title").unwrap(), "kept");
        assert_eq!(
            row.try_get::<String>("", "delegation_call_id").unwrap(),
            "call-1"
        );
        assert_eq!(
            row.try_get::<String>("", "deleted_at").unwrap(),
            "2026-08-01T00:00:00Z"
        );
        assert_eq!(
            row.try_get::<String>("", "pinned_at").unwrap(),
            "2026-08-02T00:00:00Z"
        );
    }
}
