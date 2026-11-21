//! 项目成为容器：新增 `project` 与 `project_reference` 表，folder 行改记所属项目。
//!
//! - 现有 `parent_id` 家族（root + 挂在它下面的 worktree）并成一个项目；其余 folder 各成一个项目。
//!   root 已不在的孤儿 worktree 以自己为 root。
//! - 主成员取家族里带 hub 标记（`.berth/local/hub.json`）的 checkout，没有就取 root（git 主 worktree）。
//! - 项目名 = root 的别名或目录名（即升级前侧栏项目行显示的名字）；置顶、排序取 root 的。
//! - 迁移后删掉 folder 上的 `parent_id`、`alias`、`pinned_at`、`sort_order`；`color`（无读写方）
//!   与 `is_open`（两态之后与 `deleted_at` 等价）直接删掉。chat folder 与墓碑不属于任何项目。

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};

#[derive(DeriveMigrationName)]
pub struct Migration;

/// 与 `tasks::hub::HUB_MARKER` 相同；迁移写死，不随代码改动。
const HUB_MARKER: &str = ".berth/local/hub.json";

const CREATE_PROJECT: &str = "CREATE TABLE \"project\" ( \
     \"id\" integer NOT NULL PRIMARY KEY AUTOINCREMENT, \
     \"name\" varchar NOT NULL, \
     \"main_folder_id\" integer NOT NULL, \
     \"sort_order\" integer NOT NULL DEFAULT 0, \
     \"pinned_at\" timestamp_with_timezone_text NULL, \
     \"created_at\" timestamp_with_timezone_text NOT NULL, \
     \"updated_at\" timestamp_with_timezone_text NOT NULL )";

const CREATE_REFERENCE: &str = "CREATE TABLE \"project_reference\" ( \
     \"id\" integer NOT NULL PRIMARY KEY AUTOINCREMENT, \
     \"project_id\" integer NOT NULL REFERENCES \"project\" (\"id\") ON DELETE CASCADE, \
     \"path\" varchar NOT NULL, \
     \"created_at\" timestamp_with_timezone_text NOT NULL, \
     UNIQUE (\"project_id\", \"path\") )";

struct Row {
    id: i32,
    name: String,
    path: String,
    parent_id: Option<i32>,
    alias: Option<String>,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let txn = manager.get_connection().begin().await?;
        let sql = |s: &str| Statement::from_string(DbBackend::Sqlite, s.to_owned());
        txn.execute(sql(CREATE_PROJECT)).await?;
        txn.execute(sql(CREATE_REFERENCE)).await?;
        txn.execute(sql("ALTER TABLE folder ADD COLUMN project_id integer NULL"))
            .await?;
        txn.execute(sql(
            "CREATE INDEX idx_folder_project_id ON folder (project_id)",
        ))
        .await?;

        let mut rows = Vec::new();
        for row in txn
            .query_all(sql("SELECT id, name, path, parent_id, alias FROM folder \
                 WHERE deleted_at IS NULL AND kind = 'regular' ORDER BY id"))
            .await?
        {
            rows.push(Row {
                id: row.try_get("", "id")?,
                name: row.try_get("", "name")?,
                path: row.try_get("", "path")?,
                parent_id: row.try_get("", "parent_id")?,
                alias: row.try_get("", "alias")?,
            });
        }
        let live: HashSet<i32> = rows.iter().map(|row| row.id).collect();
        // root id → 成员（root 自己排第一）。
        let mut families: BTreeMap<i32, Vec<&Row>> = BTreeMap::new();
        for row in &rows {
            let root = row
                .parent_id
                .filter(|id| live.contains(id))
                .unwrap_or(row.id);
            let members = families.entry(root).or_default();
            if root == row.id {
                members.insert(0, row);
            } else {
                members.push(row);
            }
        }

        for members in families.values() {
            let root = members[0];
            let main = members
                .iter()
                .find(|member| Path::new(&member.path).join(HUB_MARKER).is_file())
                .unwrap_or(&root);
            let name = root.alias.clone().unwrap_or_else(|| root.name.clone());
            let inserted = txn
                .query_one(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    "INSERT INTO project (name, main_folder_id, sort_order, pinned_at, created_at, updated_at) \
                     SELECT ?, ?, sort_order, pinned_at, created_at, updated_at FROM folder WHERE id = ? \
                     RETURNING id",
                    [name.into(), main.id.into(), root.id.into()],
                ))
                .await?
                .ok_or_else(|| DbErr::Custom(format!("project for folder {} not created", root.id)))?;
            let project_id: i32 = inserted.try_get("", "id")?;
            let ids = members
                .iter()
                .map(|member| member.id.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            txn.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                format!("UPDATE folder SET project_id = ? WHERE id IN ({ids})"),
                [project_id.into()],
            ))
            .await?;
        }

        txn.execute(sql("DROP INDEX IF EXISTS idx_folder_sort_order"))
            .await?;
        for column in [
            "parent_id",
            "alias",
            "pinned_at",
            "sort_order",
            "color",
            "is_open",
        ] {
            txn.execute(sql(&format!("ALTER TABLE folder DROP COLUMN {column}")))
                .await?;
        }
        txn.commit().await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // 家族已并成项目、旧列已删，无法还原原来的 parent / alias 分布。
        Err(DbErr::Custom(
            "project membership requires a forward migration; reverting is not supported"
                .to_owned(),
        ))
    }
}
