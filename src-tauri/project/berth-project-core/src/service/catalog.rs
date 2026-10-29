//! 项目目录投影：GUI 与 CLI 共用的唯一判据。
//!
//! 这里决定「哪些 folder 算项目」与「是否已打开」；GUI control 与 CLI 只在各自
//! 传输层把 [`CatalogEntry`] 映射成线上 DTO，不复制过滤条件或 `is_open` 判据。

use std::collections::HashSet;

use sea_orm::DatabaseConnection;

use crate::entities::folder::FolderKind;
use crate::error::DbError;
use crate::service::folder_service::{list_all_folder_details, list_open_folder_details};

/// 目录查询范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogScope {
    /// 仅当前打开的项目。
    Open,
    /// 全部已注册项目（含无 live 终端的项目）。
    All,
}

/// 项目目录条目；传输层各自映射为 control DTO 或 CLI JSON。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEntry {
    pub id: i32,
    pub path: String,
    pub name: String,
    pub is_open: bool,
    /// 内部归属事实；线上 project ls 仍只映射既有四个字段。
    pub project_runtime_id: String,
}

/// 唯一目录投影。
///
/// - 隐藏的 `chat` folder 对项目目录不可见；
/// - `is_open` 判据是「出现在打开集合里」，即持久列 `is_open` 的投影。
pub async fn list_catalog(
    conn: &DatabaseConnection,
    scope: CatalogScope,
) -> Result<Vec<CatalogEntry>, DbError> {
    let open = list_open_folder_details(conn).await?;
    let open_ids: HashSet<i32> = open.iter().map(|detail| detail.id).collect();
    let details = match scope {
        CatalogScope::Open => open,
        CatalogScope::All => list_all_folder_details(conn)
            .await?
            .into_iter()
            .filter(|detail| matches!(detail.kind, FolderKind::Regular))
            .collect(),
    };

    Ok(details
        .into_iter()
        .map(|detail| CatalogEntry {
            is_open: open_ids.contains(&detail.id),
            id: detail.id,
            path: detail.path,
            name: detail.name,
            project_runtime_id: detail.project_runtime_id,
        })
        .collect())
}
