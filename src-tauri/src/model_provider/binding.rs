//! Agent ↔ 服务商档案绑定(启动栏两级下拉的读写通道)。
//!
//! 绑定记录"这个 agent 用哪份档案 + 档案内选中的默认启动模型键",
//! 存在 `agent_setting.model_provider_id` / `model_key`;它只决定启动栏的默认选项,
//! 启动注入只信当次传入的 `provider_id` / `model_id`(`injection::resolve_for_launch`)。

use crate::app_error::AppCommandError;
use crate::db::service::{agent_setting_service, model_provider_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;

/// 一个 agent 当前的模型绑定:`provider_id` 为 `None` = 未绑定(不注入);
/// `model_key` 是档案内选中的具体模型键(档案 model 为角色 JSON 时),
/// `None` = 档案整体绑定(单模型名档案 / 未选具体模型)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderBinding {
    pub provider_id: Option<i32>,
    pub model_key: Option<String>,
}

fn parse_agent_type(agent_type: &str) -> Result<AgentType, AppCommandError> {
    serde_json::from_value(serde_json::Value::String(agent_type.to_string()))
        .map_err(|_| AppCommandError::invalid_input(format!("Invalid agent type: {agent_type}")))
}

/// 读取一个 agent 当前的模型服务商绑定;无设置行 = 未绑定。
pub async fn get(
    db: &AppDatabase,
    agent_type: &str,
) -> Result<AgentProviderBinding, AppCommandError> {
    let parsed = parse_agent_type(agent_type)?;
    let setting = agent_setting_service::get_by_agent_type(&db.conn, parsed)
        .await
        .map_err(AppCommandError::from)?;
    Ok(match setting {
        Some(row) => AgentProviderBinding {
            provider_id: row.model_provider_id,
            model_key: row.model_key,
        },
        None => AgentProviderBinding {
            provider_id: None,
            model_key: None,
        },
    })
}

/// 设置 / 清除一个 agent 的模型服务商绑定。只校验 provider 存在;
/// 协议匹配由前端下拉过滤保证(注入是纯字符串替换,绑错档案无解析
/// 风险,不值得在 Rust 侧重建协议映射)。
pub async fn set(
    db: &AppDatabase,
    agent_type: &str,
    provider_id: Option<i32>,
    model_key: Option<String>,
) -> Result<(), AppCommandError> {
    let parsed = parse_agent_type(agent_type)?;
    if let Some(id) = provider_id {
        model_provider_service::get_by_id(&db.conn, id)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| {
                AppCommandError::invalid_input(format!("Model provider {id} not found"))
            })?;
    }
    agent_setting_service::set_model_binding(&db.conn, parsed, provider_id, model_key)
        .await
        .map_err(AppCommandError::from)
}
