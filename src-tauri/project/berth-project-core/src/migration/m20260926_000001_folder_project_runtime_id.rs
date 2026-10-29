use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};
use uuid::Uuid;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        let manager = SchemaManager::new(&transaction);
        // SQLite 不能给已有表追加非恒定默认值；先在同一事务中补列并回填，
        // 再以唯一索引及空值守卫约束后续写入，避免重建被多张表引用的 folder。
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .add_column(
                        ColumnDef::new(Folder::ProjectRuntimeId)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .to_owned(),
            )
            .await?;
        let rows = transaction
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT id FROM folder".to_owned(),
            ))
            .await?;
        for row in rows {
            let id: i32 = row.try_get("", "id")?;
            transaction
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    "UPDATE folder SET project_runtime_id = ? WHERE id = ?",
                    [Uuid::new_v4().to_string().into(), id.into()],
                ))
                .await?;
        }
        manager
            .create_index(
                Index::create()
                    .name("idx_folder_project_runtime_id")
                    .table(Folder::Table)
                    .col(Folder::ProjectRuntimeId)
                    .unique()
                    .to_owned(),
            )
            .await?;
        transaction
            .execute_unprepared(
                "CREATE TRIGGER folder_runtime_id_nonempty_insert \
                 BEFORE INSERT ON folder WHEN NEW.project_runtime_id = '' \
                 BEGIN SELECT RAISE(ABORT, 'project_runtime_id must not be empty'); END; \
                 CREATE TRIGGER folder_runtime_id_nonempty_update \
                 BEFORE UPDATE OF project_runtime_id ON folder WHEN NEW.project_runtime_id = '' \
                 BEGIN SELECT RAISE(ABORT, 'project_runtime_id must not be empty'); END;",
            )
            .await?;
        transaction.commit().await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // 已签发给运行中 session 的身份不能在回滚中删除或重新生成。
        Err(DbErr::Custom(
            "project runtime identities require a forward migration; removing them is not supported"
                .to_owned(),
        ))
    }
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    ProjectRuntimeId,
}
