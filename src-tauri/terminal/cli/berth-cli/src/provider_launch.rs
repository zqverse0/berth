//! `terminal create --agent` 的服务商注入：与 GUI 启动同一份声明投影、档案读取与启动档案
//! （`berth-tool-core` / `berth-project-core`）。服务商 Key 取自本地凭据文件（库里残留的旧明文
//! 只读不迁移），只进一次性启动档案（0600，launch.js 读完即删）或代理内存，不进输出。写入
//! 另有两处：代理令牌（占位凭据）与 `berth provider set-key` 从 stdin 读到的主 Key（与 GUI 同一本地凭据文件）。

use berth_project_core::agent::parse_known_agent_type;
use berth_project_core::instance::{DataInstance, DEV_DB_FILE_NAME};
use berth_project_core::open::open_or_upgrade;
use berth_project_core::service::model_provider_launch::{
    self, api_key_account, merge_secrets, secrets_account, split_secrets, SecretMap,
    PROXY_TOKEN_ACCOUNT,
};
use berth_tool_core::provider_injection::{self, LaunchProfile, ProviderProfile, ProxyRoute};
use serde_json::Value;

/// 与 GUI `terminal_create` 的注入同语义：缺任一环则不注入（返回空参数），否则把档案写成
/// 一次性启动档案，返回追加给 launch.js 的 `--berth-provider <文件>`。`force_proxy` 为真时
/// 无视档案开关一律经代理（`berth provider run`：真 Key 永不进子进程）。
pub(crate) async fn resolve(
    instance: &DataInstance,
    agent_id: &str,
    provider_id: Option<i32>,
    model_id: Option<&str>,
    force_proxy: bool,
) -> Result<Vec<String>, String> {
    let asset = berth_tool_core::repository::load_tool_asset(agent_id)
        .ok()
        .flatten();
    let extension = asset.as_ref().and_then(|asset| asset.agent_extension());
    let spec = extension.and_then(provider_injection::from_extension);
    let project_type = extension
        .and_then(|extension| extension.get("projectType"))
        .and_then(Value::as_str)
        .filter(|value| parse_known_agent_type(value).is_some());
    let (Some(id), Some(spec), Some(project_type)) = (provider_id, spec, project_type) else {
        return Ok(Vec::new());
    };
    let apis = spec.apis.as_deref();
    let Some(profile) =
        launch_profile(instance, project_type, apis, id, model_id, force_proxy).await?
    else {
        return Ok(Vec::new());
    };
    provider_injection::write_launch_profile(&profile)
}

async fn launch_profile(
    instance: &DataInstance,
    project_type: &str,
    agent_apis: Option<&[String]>,
    provider_id: i32,
    model_id: Option<&str>,
    force_proxy: bool,
) -> Result<Option<LaunchProfile>, String> {
    let Some(loaded) = load_with_secrets(instance, provider_id, project_type).await? else {
        return Ok(None);
    };
    let provider = &loaded.launch.provider;
    let proxy = if force_proxy || provider_injection::via_proxy(loaded.discovery.as_deref()) {
        let port = proxy_port(instance);
        if !berth_provider_proxy::is_listening(port) {
            return Err(format!(
                "provider {provider_id} is set to use the Berth proxy, but nothing listens on \
                 127.0.0.1:{port}; open Berth or run `berth provider proxy`"
            ));
        }
        let token = ensure_proxy_token(instance)?;
        Some((
            berth_provider_proxy::provider_base_url(port, provider_id),
            token,
        ))
    } else {
        None
    };
    provider_injection::launch_profile(
        &ProviderProfile {
            name: &provider.name,
            api_url: &provider.api_url,
            api_key: &loaded.api_key,
            discovery: loaded.discovery.as_deref(),
            overlay_models: loaded.launch.overlay_models.as_deref(),
            directory_models: provider.model.as_deref(),
            proxy: proxy
                .as_ref()
                .map(|(base_url, token)| ProxyRoute { base_url, token }),
        },
        agent_apis,
        model_id,
    )
    .map(Some)
}

/// 档案连同 Key：主 Key 与 `discovery_json` 内的分组 / 端点 Key 已从本地凭据文件回填。
pub(crate) struct LoadedProvider {
    pub(crate) launch: model_provider_launch::LaunchProvider,
    pub(crate) api_key: String,
    pub(crate) discovery: Option<String>,
}

/// 读档案与 Key；官方档案或不存在为 `None`。`agent_type` 只用于取该栏 overlay 模型。
pub(crate) async fn load_with_secrets(
    instance: &DataInstance,
    provider_id: i32,
    agent_type: &str,
) -> Result<Option<LoadedProvider>, String> {
    let (conn, state) = open_or_upgrade(instance).await;
    let conn = conn.ok_or_else(|| format!("data instance is not ready: {state:?}"))?;
    let Some(launch) = model_provider_launch::load(&conn, provider_id, agent_type)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    Ok(Some(with_secrets(instance, launch)?))
}

/// 全部非官方档案连同 Key（不带 overlay 模型）。
/// `<provider>` 参数：数字即 id；否则按名字（不分大小写）先精确、再包含唯一匹配。
pub(crate) async fn provider_id(instance: &DataInstance, reference: &str) -> Result<i32, String> {
    if let Ok(id) = reference.trim().parse::<i32>() {
        return Ok(id);
    }
    let (conn, state) = open_or_upgrade(instance).await;
    let conn = conn.ok_or_else(|| format!("data instance is not ready: {state:?}"))?;
    let rows: Vec<(i32, String)> = model_provider_launch::list_custom(&conn)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|row| (row.id, row.name))
        .collect();
    match_provider(&rows, reference)
}

fn match_provider(rows: &[(i32, String)], reference: &str) -> Result<i32, String> {
    let wanted = reference.trim().to_lowercase();
    let exact: Vec<_> = rows
        .iter()
        .filter(|(_, name)| name.to_lowercase() == wanted)
        .collect();
    let candidates = if exact.is_empty() {
        rows.iter()
            .filter(|(_, name)| name.to_lowercase().contains(&wanted))
            .collect()
    } else {
        exact
    };
    match candidates.as_slice() {
        [(id, _)] => Ok(*id),
        [] => Err(format!(
            "no provider named like '{reference}'; see `berth provider list`"
        )),
        many => Err(format!(
            "'{reference}' matches several providers, use the id: {}",
            many.iter()
                .map(|(id, name)| format!("{id} {name}"))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// 全部自定义档案的导出文档（不含 Key，见 `model_provider_export`）。
pub(crate) async fn export(
    instance: &DataInstance,
) -> Result<berth_project_core::service::model_provider_export::ProviderExport, String> {
    let (conn, state) = open_or_upgrade(instance).await;
    let conn = conn.ok_or_else(|| format!("data instance is not ready: {state:?}"))?;
    berth_project_core::service::model_provider_export::export(&conn)
        .await
        .map_err(|error| error.to_string())
}

pub(crate) async fn list_with_secrets(
    instance: &DataInstance,
) -> Result<Vec<LoadedProvider>, String> {
    let (conn, state) = open_or_upgrade(instance).await;
    let conn = conn.ok_or_else(|| format!("data instance is not ready: {state:?}"))?;
    let providers = model_provider_launch::list_custom(&conn)
        .await
        .map_err(|error| error.to_string())?;
    providers
        .into_iter()
        .map(|provider| {
            with_secrets(
                instance,
                model_provider_launch::LaunchProvider {
                    provider,
                    overlay_models: None,
                },
            )
        })
        .collect()
}

fn with_secrets(
    instance: &DataInstance,
    launch: model_provider_launch::LaunchProvider,
) -> Result<LoadedProvider, String> {
    let provider = &launch.provider;
    let api_key = local_get(instance, &api_key_account(provider.id))?
        .filter(|key| !key.trim().is_empty())
        .unwrap_or_else(|| provider.api_key.trim().to_owned());
    let discovery = provider
        .discovery_json
        .as_deref()
        .map(|raw| -> Result<String, String> {
            let Some((sanitized, legacy, _)) = split_secrets(raw) else {
                return Ok(raw.to_owned());
            };
            let mut secrets: SecretMap = local_get(instance, &secrets_account(provider.id))?
                .map(|raw| {
                    serde_json::from_str(&raw)
                        .map_err(|_| "Invalid local provider discovery credentials".to_string())
                })
                .transpose()?
                .unwrap_or_default();
            secrets.extend(legacy);
            Ok(merge_secrets(&sanitized, &secrets))
        })
        .transpose()?;
    Ok(LoadedProvider {
        launch,
        api_key,
        discovery,
    })
}

/// 本实例的代理端口（dev 与正式实例各一个，与 GUI 托管的代理一致）。
pub(crate) fn proxy_port(instance: &DataInstance) -> u16 {
    berth_provider_proxy::port(instance.db_file_name() == DEV_DB_FILE_NAME)
}

fn local_get(instance: &DataInstance, account: &str) -> Result<Option<String>, String> {
    berth_project_core::credentials::get(instance.data_dir(), account)
        .map_err(|error| error.to_string())
}

/// 保存档案主 Key（与 GUI 设置页同一本地凭据文件）。
pub(crate) fn store_api_key(
    instance: &DataInstance,
    provider_id: i32,
    key: &str,
) -> Result<(), String> {
    berth_project_core::credentials::set(instance.data_dir(), &api_key_account(provider_id), key)
        .map_err(|error| error.to_string())
}

/// 当前代理令牌；`None` = 尚未生成；文件不可读时返回错误。
pub(crate) fn proxy_token(instance: &DataInstance) -> Result<Option<String>, String> {
    Ok(local_get(instance, PROXY_TOKEN_ACCOUNT)?.filter(|token| !token.is_empty()))
}

/// 当前令牌，没有则生成。
pub(crate) fn ensure_proxy_token(instance: &DataInstance) -> Result<String, String> {
    berth_project_core::credentials::get_or_create(instance.data_dir(), PROXY_TOKEN_ACCOUNT)
        .map_err(|error| error.to_string())
}

/// 生成并保存新令牌，旧令牌立即失效（代理每次请求都重新读取）。
pub(crate) fn rotate_proxy_token(instance: &DataInstance) -> Result<String, String> {
    let token = format!("berth-tk-{}", uuid::Uuid::new_v4().simple());
    berth_project_core::credentials::set(instance.data_dir(), PROXY_TOKEN_ACCOUNT, &token)
        .map_err(|error| error.to_string())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_reference_matches_exact_then_unique_substring() {
        let rows = vec![
            (68, "Deepseek".to_owned()),
            (41, "wuming".to_owned()),
            (46, "wuming".to_owned()),
            (73, "TypeSafe Jev".to_owned()),
            (74, "百炼 决策模型（Token Plan）".to_owned()),
            (52, "Bailian token".to_owned()),
        ];
        assert_eq!(match_provider(&rows, "deepseek"), Ok(68));
        assert_eq!(match_provider(&rows, "jev"), Ok(73));
        assert_eq!(match_provider(&rows, "决策"), Ok(74));
        assert!(match_provider(&rows, "wuming")
            .unwrap_err()
            .contains("41 wuming, 46 wuming"));
        assert!(match_provider(&rows, "token")
            .unwrap_err()
            .contains("several"));
        assert!(match_provider(&rows, "nope")
            .unwrap_err()
            .contains("no provider"));
    }
}
