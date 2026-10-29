use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    #[sea_orm(string_value = "schedule")]
    Schedule,
    #[sea_orm(string_value = "manual")]
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum IsolationMode {
    #[sea_orm(string_value = "worktree_per_run")]
    WorktreePerRun,
    #[sea_orm(string_value = "shared_in_root")]
    SharedInRoot,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "automation")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
    pub enabled: bool,
    pub trigger_kind: TriggerKind,
    pub cron: Option<String>,
    pub timezone: String,
    pub next_run_at: Option<DateTimeUtc>,
    pub agent_type: String,
    pub root_folder_id: Option<i32>,
    pub isolation: IsolationMode,
    pub branch: Option<String>,
    pub is_remote_branch: bool,
    #[sea_orm(column_type = "Text")]
    pub config: String,
    pub last_run_at: Option<DateTimeUtc>,
    pub last_run_status: Option<String>,
    pub last_run_conversation_id: Option<i32>,
    pub unseen_failures: i32,
    pub missed_run_grace_minutes: i32,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::automation_run::Entity")]
    Runs,
}
impl Related<super::automation_run::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Runs.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}
