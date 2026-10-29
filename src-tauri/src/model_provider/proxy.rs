//! GUI 托管的服务商凭据代理（`berth-provider-proxy`，与 `berth provider proxy` 同一实现）：
//! 启动时在本实例端口监听，端口已被占（CLI 代理在跑）则跳过。Key 经 `secrets`
//! （本地凭据文件）读取，只在代理内存里用于替换，不进日志与响应。

use std::sync::Arc;

use berth_project_core::service::model_provider_launch;
use berth_provider_proxy::{serve, upstream_client, Denied, Resolver, Route, RouteRequest};
use berth_tool_core::provider_injection::resolve_upstream;
use sea_orm::DatabaseConnection;

use crate::platform::keyring_store;

/// 本实例的代理端口：debug 构建（dev 实例）与正式版各一个，与 CLI 一致。
pub fn port() -> u16 {
    berth_provider_proxy::port(cfg!(debug_assertions))
}

/// 当前令牌，没有则生成并存入本地凭据文件。
pub async fn token() -> Result<String, String> {
    keyring_store::run_blocking(keyring_store::get_or_create_provider_proxy_token).await?
}

/// 设置页「调用地址」所需：本实例代理根地址、是否在监听、令牌（占位凭据，不是 Key）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAccess {
    /// `http://127.0.0.1:<port>`；档案端点地址为 `{base_url}/p/<id>/<端点名>`。
    pub base_url: String,
    pub listening: bool,
    pub token: String,
}

pub async fn access() -> Result<ProxyAccess, String> {
    let port = port();
    Ok(ProxyAccess {
        base_url: format!("http://127.0.0.1:{port}"),
        listening: berth_provider_proxy::is_listening(port),
        token: token().await?,
    })
}

struct GuiResolver {
    conn: DatabaseConnection,
}

impl Resolver for GuiResolver {
    async fn resolve(&self, request: RouteRequest) -> Result<Route, Denied> {
        // 每次请求重读：`berth provider token --rotate` 后立即生效。
        let token = keyring_store::run_blocking(keyring_store::get_provider_proxy_token)
            .await
            .and_then(|value| value)
            .map_err(|_| Denied::InvalidToken)?;
        if token.as_deref() != Some(request.token.as_str()) {
            return Err(Denied::InvalidToken);
        }
        let id = request
            .provider
            .parse::<i32>()
            .map_err(|_| Denied::UnknownProvider)?;
        let launch = model_provider_launch::load(&self.conn, id, &request.protocol)
            .await
            .ok()
            .flatten()
            .ok_or(Denied::UnknownProvider)?;
        let provider = &launch.provider;
        let api_key = super::secrets::load_api_key(&self.conn, provider)
            .await
            .map_err(|_| Denied::UnknownProvider)?;
        let discovery = super::secrets::load_discovery(&self.conn, provider)
            .await
            .map_err(|_| Denied::UnknownProvider)?;
        let (url, key) = resolve_upstream(
            discovery.as_deref(),
            &request.protocol,
            &provider.api_url,
            &api_key,
            request.model.as_deref(),
        );
        // 无 Key 也放行（本地 Ollama 等）：代理不带凭据转发。
        if url.trim().is_empty() {
            tracing::warn!(
                "[provider-proxy] provider {id}: no endpoint for {}",
                request.protocol
            );
            return Err(Denied::UnknownProvider);
        }
        Ok(Route {
            upstream_base: url,
            key,
        })
    }
}

/// 启动时调用一次；失败只记日志，不影响 GUI。
pub async fn host(conn: DatabaseConnection) {
    let port = port();
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::info!("[provider-proxy] 127.0.0.1:{port} unavailable ({error}); not hosting");
            return;
        }
    };
    let client = match upstream_client() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!("[provider-proxy] upstream client: {error}");
            return;
        }
    };
    tracing::info!("[provider-proxy] listening on 127.0.0.1:{port}");
    if let Err(error) = serve(listener, client, Arc::new(GuiResolver { conn })).await {
        tracing::warn!("[provider-proxy] stopped: {error}");
    }
}
