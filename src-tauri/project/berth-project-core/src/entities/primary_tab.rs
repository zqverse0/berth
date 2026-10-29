use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "primary_tab")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(unique)]
    pub tab_key: String,
    pub kind: String,
    pub folder_id: Option<i32>,
    pub launch_source: Option<String>,
    pub conversation_id: Option<i32>,
    pub agent_type: Option<String>,
    pub terminal_id: Option<String>,
    pub backend_instance_id: Option<String>,
    pub title: String,
    pub initial_cwd: Option<String>,
    pub last_known_cwd: Option<String>,
    pub shell: Option<String>,
    pub detached_folder_label: Option<String>,
    pub detached_folder_path: Option<String>,
    pub position: i32,
    pub is_pinned: bool,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::folder::Entity",
        from = "Column::FolderId",
        to = "super::folder::Column::Id"
    )]
    Folder,

    #[sea_orm(
        belongs_to = "super::conversation::Entity",
        from = "Column::ConversationId",
        to = "super::conversation::Column::Id"
    )]
    Conversation,
}

impl Related<super::folder::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Folder.def()
    }
}

impl Related<super::conversation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Conversation.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
