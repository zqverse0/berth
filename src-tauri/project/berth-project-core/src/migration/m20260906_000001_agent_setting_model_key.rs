use sea_orm_migration::prelude::*;

/// agent_setting 加 `model_key`:启动栏模型下拉选中档案内的具体模型
/// (claude 档案的 model 是一组角色 JSON,如 {"main":..,"reasoning":..};
/// 绑定除了 provider id 还要记用户选了哪个键)。NULL = 未选具体模型
/// (整档案绑定或档案本身是单模型名)。
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .add_column(ColumnDef::new(AgentSetting::ModelKey).text())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(AgentSetting::Table)
                    .drop_column(AgentSetting::ModelKey)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum AgentSetting {
    Table,
    ModelKey,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    #[tokio::test]
    async fn up_adds_nullable_model_key_defaulting_null() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE agent_setting (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_type TEXT)",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO agent_setting (agent_type) VALUES ('\"codex\"')")
            .await
            .expect("insert row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT model_key FROM agent_setting".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let model_key: Option<String> = rows[0].try_get("", "model_key").expect("model_key col");
        assert!(model_key.is_none(), "new column must default to NULL");
    }
}
