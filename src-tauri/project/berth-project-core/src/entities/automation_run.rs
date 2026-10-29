use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    #[sea_orm(string_value = "running")]
    Running,
    #[sea_orm(string_value = "succeeded")]
    Succeeded,
    #[sea_orm(string_value = "failed")]
    Failed,
    #[sea_orm(string_value = "cancelled")]
    Cancelled,
    #[sea_orm(string_value = "skipped")]
    Skipped,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "automation_run")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub automation_id: i32,
    pub status: AutomationRunStatus,
    pub trigger: String,
    pub scheduled_for: Option<DateTimeUtc>,
    pub started_at: Option<DateTimeUtc>,
    pub ended_at: Option<DateTimeUtc>,
    pub conversation_id: Option<i32>,
    pub connection_id: Option<String>,
    pub worktree_folder_id: Option<i32>,
    pub terminal_id: Option<String>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
    pub summary: Option<String>,
    /// 人工检查时间;NULL 表示该运行尚未被用户检查过。
    pub reviewed_at: Option<DateTimeUtc>,
    /// 人工关联的项目内结果文件路径;与检查状态相互独立。
    pub result_path: Option<String>,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::automation::Entity",
        from = "Column::AutomationId",
        to = "super::automation::Column::Id"
    )]
    Automation,
}
impl Related<super::automation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Automation.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}
