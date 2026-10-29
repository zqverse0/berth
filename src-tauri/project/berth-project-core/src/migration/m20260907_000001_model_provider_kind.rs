use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::ConnectionTrait;

/// model_provider 加 `kind`:区分中转站档案与官方登录。
/// `custom`(默认)= url/key 注入;`official`= 不注入,走 CLI 原生登录。
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
                        ColumnDef::new(ModelProvider::Kind)
                            .text()
                            .not_null()
                            .default("custom"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_model_provider_official_agent ON model_provider(agent_type) WHERE kind = 'official'",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_model_provider_official_agent")
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .drop_column(ModelProvider::Kind)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ModelProvider {
    Table,
    Kind,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[tokio::test]
    async fn up_adds_kind_defaulting_custom() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE model_provider (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, agent_type TEXT NOT NULL DEFAULT '')",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO model_provider (name) VALUES ('x')")
            .await
            .expect("insert row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT kind FROM model_provider".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let kind: String = rows[0].try_get("", "kind").expect("kind col");
        assert_eq!(kind, "custom");
    }
}
