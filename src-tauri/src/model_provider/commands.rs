//! 账号用量与余额命令(见 `model_provider::usage` / `model_provider::balance`)。
//!
//! 两个 command 服务两个稳定消费面:状态栏聚合查询(轮询)与模型服务商
//! 余额点查(设置页档案卡片),共用 `usage::execute` 一个执行器。
//! 不塞进 launchbar——那是纯文件读取通道,这里出网。
//! 挂在领域模块内而非 commands/ 平铺目录(skills 模块同款先例)。

use crate::app_error::AppCommandError;
use crate::model_provider::usage::UsageState;

/// 执行 `tools/<agent>/tool.json` 声明的聚合查询。
/// 坏声明/网络失败都折叠为对应状态(见 `usage::read_all`),不 reject。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_account_usage() -> Result<Vec<UsageState>, AppCommandError> {
    Ok(crate::model_provider::usage::read_all().await)
}

/// 按档案 api_url 匹配站点模板查余额(见 `balance`)。
/// api_key 与 `fetch_provider_models` 前例一致由调用方直传,无新增暴露。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn fetch_provider_balance(
    api_url: String,
    api_key: String,
) -> Result<UsageState, AppCommandError> {
    crate::model_provider::balance::query(&api_url, &api_key)
        .await
        .map_err(AppCommandError::task_execution_failed)
}

/// 按 Agent 类型与可选的凭证内容查询账户配额与用量。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn fetch_official_account_usage(
    agent_type: String,
    raw_credential: Option<String>,
) -> Result<UsageState, AppCommandError> {
    let _ = raw_credential;
    crate::model_provider::usage::read_for_agent(&agent_type, None)
        .await
        .map_err(AppCommandError::task_execution_failed)
}

/// 声明式登录凭证卡（不落库）：每条 = 一个 Agent 的一个登录来源。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_login_cards(
) -> Result<Vec<crate::model_provider::login::LoginEntry>, AppCommandError> {
    Ok(
        tokio::task::spawn_blocking(crate::model_provider::login::list_entries)
            .await
            .unwrap_or_default(),
    )
}

/// 按登录声明读模型（本地文件或包内脚本；不联网、不读 token），并入用户预选项。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn fetch_login_models(
    agent_id: String,
    login_id: String,
) -> Result<crate::model_provider::login::LoginModels, AppCommandError> {
    crate::model_provider::login::fetch_models(&agent_id, &login_id)
        .await
        .map_err(AppCommandError::invalid_input)
}

/// 覆盖保存某个登录的预选模型（工具包 `login-presets.json`，不落库、不含凭证）。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_login_presets(
    agent_id: String,
    login_id: String,
    models: Vec<crate::model_provider::login::LoginModel>,
) -> Result<(), AppCommandError> {
    crate::model_provider::login::save_presets(&agent_id, &login_id, models)
        .map_err(AppCommandError::invalid_input)
}
