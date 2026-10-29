use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};
use uuid::Uuid;

/// 项目只剩「已注册 / 墓碑」两态：把旧版「关闭」留下的 `is_open = 0` 常规
/// folder，以及 root 已不在的孤儿 worktree，按 `folder_service::forget_folder`
/// 同样的语义转为墓碑。行本身保留，作为会话等外键的锚点。
#[derive(DeriveMigrationName)]
pub struct Migration;

const RETIRE_SQL: &str = "UPDATE folder SET name = 'forgotten', path = ?, \
     project_runtime_id = ?, deleted_at = ?, updated_at = ?, is_open = 0, \
     git_branch = NULL, default_agent_type = NULL, parent_id = NULL, alias = NULL, \
     pinned_at = NULL WHERE id = ?";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        // 先退休关闭的项目，再找孤儿：它们的 root 可能正是刚退休的那批。
        for select in [
            "SELECT id FROM folder WHERE deleted_at IS NULL AND kind = 'regular' \
             AND is_open = 0",
            "SELECT id FROM folder WHERE deleted_at IS NULL AND kind = 'regular' \
             AND parent_id IS NOT NULL AND parent_id NOT IN \
             (SELECT id FROM folder WHERE deleted_at IS NULL)",
        ] {
            let rows = transaction
                .query_all(Statement::from_string(DbBackend::Sqlite, select.to_owned()))
                .await?;
            for row in rows {
                let id: i32 = row.try_get("", "id")?;
                let tombstone = Uuid::new_v4();
                let now = chrono::Utc::now();
                transaction
                    .execute(Statement::from_sql_and_values(
                        DbBackend::Sqlite,
                        RETIRE_SQL,
                        [
                            format!("berth-forgotten://{tombstone}").into(),
                            tombstone.to_string().into(),
                            now.into(),
                            now.into(),
                            id.into(),
                        ],
                    ))
                    .await?;
            }
        }
        transaction.commit().await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // 墓碑化丢弃了原路径，无法还原；也没有需要还原的 schema。
        Ok(())
    }
}
