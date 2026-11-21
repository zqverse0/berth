use sea_orm::entity::prelude::*;

/// 项目：Berth 的逻辑容器，不对应磁盘目录。代码成员是 `folder.project_id` 指向它的 folder 行，
/// 参考成员在 [`super::project_reference`]。项目级属性（名称、置顶、排序）只存在这里。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "project")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
    /// 主成员：放 `.berth/` 的那份 checkout（hub）；没有 hub 时是 git 主 worktree。
    pub main_folder_id: i32,
    pub sort_order: i32,
    /// 置顶时间；`None` 未置顶。列表按置顶时间倒序排在前面。
    pub pinned_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
