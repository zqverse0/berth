use sea_orm::entity::prelude::*;

/// 中转站档案：启动时按 tool.json Agent extension 的 providerInjection 注入 url/key。
pub const KIND_CUSTOM: &str = "custom";
/// 官方登录:启动时不注入,CLI 走原生订阅。
pub const KIND_OFFICIAL: &str = "official";

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "model_provider")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    pub agent_types_json: String,
    pub agent_type: String,
    pub model: Option<String>,
    /// 供应商官网(详情页展示;NULL = 未填)。
    pub website: Option<String>,
    /// `custom` = 中转站档案(注入 url/key);`official` = 官方登录(不注入)。
    pub kind: String,
    /// 发现请求方言：`openai` | `anthropic`。
    pub flavor: String,
    /// 上次 GET 模型列表缓存(不含密钥)。
    pub discovery_json: Option<String>,
    /// 自定义可见 Agent 白名单(JSON 数组)。
    pub agent_allowlist: String,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
