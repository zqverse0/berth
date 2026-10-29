use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `pinned_at` records when the user pinned a folder; NULL means not
        // pinned. The project/folder list surfaces pinned folders first, sorted
        // by this timestamp descending. New and legacy rows default to NULL.
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .add_column(ColumnDef::new(Folder::PinnedAt).timestamp_with_time_zone())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .drop_column(Folder::PinnedAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    PinnedAt,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[tokio::test]
    async fn up_adds_nullable_pinned_at_defaulting_null() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE folder (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO folder (name) VALUES ('x')")
            .await
            .expect("insert row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT pinned_at FROM folder".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let pinned_at: Option<String> = rows[0].try_get("", "pinned_at").expect("pinned_at col");
        assert!(pinned_at.is_none(), "new column must default to NULL");
    }
}
