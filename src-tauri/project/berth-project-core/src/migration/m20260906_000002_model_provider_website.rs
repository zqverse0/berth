use sea_orm_migration::prelude::*;

/// model_provider 加 `website`:供应商官网(详情页展示/跳转,cc-switch
/// 导入时从其 `website_url` 列提取)。NULL = 未填。
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .add_column(ColumnDef::new(ModelProvider::Website).text())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ModelProvider::Table)
                    .drop_column(ModelProvider::Website)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ModelProvider {
    Table,
    Website,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[tokio::test]
    async fn up_adds_nullable_website_defaulting_null() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE model_provider (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)",
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
                "SELECT website FROM model_provider".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let website: Option<String> = rows[0].try_get("", "website").expect("website col");
        assert!(website.is_none(), "new column must default to NULL");
    }
}
