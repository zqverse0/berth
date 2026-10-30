//! 模型服务商注入(启动链路的核心):把选中的 provider 档案写成一次性启动档案,
//! 以 `--berth-provider <文件>` 交给 Agent 的 launch.js。
//!
//! 数据流：`tools/<id>/tool.json` 声明 × 当次 `terminal_create`
//! 载荷(provider_id/model_id) × overlay/档案 → 启动档案文件。
//! spawn 只信当次载荷，不读 `agent_setting`。官方 kind 不注入。
//! 档案解析与写文件在 `berth_tool_core::provider_injection`，档案读取在
//! `berth_project_core::service::model_provider_launch`，CLI 走同一实现；
//! 本模块只接 GUI 的 本地凭据文件（含旧明文迁移）。

use sea_orm::DatabaseConnection;

use crate::app_error::AppCommandError;
use crate::tool::profile::load_agent_profile;
use berth_project_core::service::model_provider_launch;
use berth_tool_core::provider_injection::{self, ProviderProfile, ProxyRoute};

/// 启动注入：只信当次 `provider_id` / `model_id`。缺任一则不注入（返回空参数，
/// launch.js 用 Agent 自己的登录）；否则写档案文件，返回追加给 launch.js 的参数。
pub async fn resolve_for_launch(
    conn: &DatabaseConnection,
    agent_id: &str,
    provider_id: Option<i32>,
    model_id: Option<&str>,
) -> Result<Vec<String>, AppCommandError> {
    let Some(provider_id) = provider_id else {
        return Ok(Vec::new());
    };
    let Some(profile) = load_agent_profile(agent_id)? else {
        return Ok(Vec::new());
    };
    let Some(spec) = profile.provider_injection else {
        return Ok(Vec::new());
    };
    let Some(project_type) = profile.project_type.as_deref() else {
        return Ok(Vec::new());
    };
    let Some(launch_profile) = launch_profile(
        conn,
        provider_id,
        project_type,
        spec.apis.as_deref(),
        model_id,
    )
    .await?
    else {
        return Ok(Vec::new());
    };
    provider_injection::write_launch_profile(&launch_profile)
        .map_err(AppCommandError::configuration_invalid)
}

/// 服务商档案 → 启动档案（各模型选定的接口与端点、各端点的地址与 Key，经代理时为代理地址）。
/// 官方档案或找不到为 `None`。`agent_type` 决定叠加哪个 Agent 的模型清单；Berth 群成员也用它。
pub async fn launch_profile(
    conn: &DatabaseConnection,
    provider_id: i32,
    agent_type: &str,
    apis: Option<&[String]>,
    model_id: Option<&str>,
) -> Result<Option<provider_injection::LaunchProfile>, AppCommandError> {
    let Some(launch) = model_provider_launch::load(conn, provider_id, agent_type)
        .await
        .map_err(AppCommandError::from)?
    else {
        return Ok(None);
    };
    let provider = &launch.provider;
    let api_key = crate::model_provider::secrets::load_api_key(conn, provider)
        .await
        .map_err(AppCommandError::from)?;
    let discovery = crate::model_provider::secrets::load_discovery(conn, provider)
        .await
        .map_err(AppCommandError::from)?;
    let proxy = if provider_injection::via_proxy(discovery.as_deref()) {
        let port = super::proxy::port();
        if !berth_provider_proxy::is_listening(port) {
            return Err(AppCommandError::configuration_invalid(format!(
                "Provider \"{}\" is set to use the Berth proxy, but nothing listens on 127.0.0.1:{port}",
                provider.name
            )));
        }
        let token = super::proxy::token()
            .await
            .map_err(AppCommandError::configuration_invalid)?;
        Some((
            berth_provider_proxy::provider_base_url(port, provider_id),
            token,
        ))
    } else {
        None
    };
    let launch_profile = provider_injection::launch_profile(
        &ProviderProfile {
            name: &provider.name,
            api_url: &provider.api_url,
            api_key: &api_key,
            discovery: discovery.as_deref(),
            overlay_models: launch.overlay_models.as_deref(),
            directory_models: provider.model.as_deref(),
            proxy: proxy
                .as_ref()
                .map(|(base_url, token)| ProxyRoute { base_url, token }),
        },
        apis,
        model_id,
    )
    .map_err(AppCommandError::configuration_invalid)?;
    Ok(Some(launch_profile))
}
