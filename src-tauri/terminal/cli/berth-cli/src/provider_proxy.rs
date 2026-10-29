//! `berth provider proxy|list`：在本机起服务商凭据代理（`berth-provider-proxy`），以及列出可经代理
//! 使用的档案。档案与 Key 的读法与 `terminal create --agent` 的注入相同（`provider_launch`）；
//! 端点 / 分组 Key 按协议名与请求的 `model` 选取，不按 Agent id。令牌整个实例一个，存在
//! 本地凭据文件，每次请求重新读取，`berth provider token --rotate` 后立即生效。

use std::sync::Arc;

use berth_project_core::instance::DataInstance;
use berth_provider_proxy::{
    provider_base_url, serve, upstream_client, Denied, Resolver, Route, RouteRequest,
};
use berth_tool_core::provider_injection::{
    endpoint_protocols, resolve_endpoint_override, resolve_upstream,
};

use crate::provider_launch::LoadedProvider;
use crate::CliError;

pub(crate) struct CliResolver {
    pub(crate) instance: DataInstance,
}

impl Resolver for CliResolver {
    async fn resolve(&self, request: RouteRequest) -> Result<Route, Denied> {
        if crate::provider_launch::proxy_token(&self.instance)
            .map_err(|_| Denied::InvalidToken)?
            .as_deref()
            != Some(request.token.as_str())
        {
            return Err(Denied::InvalidToken);
        }
        let id = request
            .provider
            .parse::<i32>()
            .map_err(|_| Denied::UnknownProvider)?;
        let loaded =
            match crate::provider_launch::load_with_secrets(&self.instance, id, &request.protocol)
                .await
            {
                Ok(Some(loaded)) => loaded,
                Ok(None) => return deny(id, "not found or official"),
                Err(error) => return deny(id, &error),
            };
        route(&loaded, &request.protocol, request.model.as_deref())
            .or_else(|reason| deny(id, reason))
    }
}

/// 某协议的上游根地址与 Key（与启动注入同一套解析）；Key 可以为空。
pub(crate) fn route(
    loaded: &LoadedProvider,
    protocol: &str,
    model: Option<&str>,
) -> Result<Route, &'static str> {
    let (url, key) = resolve_upstream(
        loaded.discovery.as_deref(),
        protocol,
        &loaded.launch.provider.api_url,
        &loaded.api_key,
        model,
    );
    // 无 Key 也放行（本地 Ollama 等）：代理不带凭据转发。
    if url.trim().is_empty() {
        return Err("no endpoint for this protocol");
    }
    Ok(Route {
        upstream_base: url,
        key,
    })
}

/// 档案声明了端点的协议；旧档案只有 `api_url`，记作 `any`。
pub(crate) fn protocols(loaded: &LoadedProvider) -> Vec<String> {
    endpoint_protocols(loaded.discovery.as_deref())
}

pub(crate) fn token(rotate: bool, json: bool) -> Result<(), CliError> {
    let instance = crate::project::resolve_instance(json)?;
    let token = match crate::provider_launch::proxy_token(&instance).map_err(CliError::user)? {
        Some(token) if !rotate => token,
        _ => crate::provider_launch::rotate_proxy_token(&instance).map_err(CliError::user)?,
    };
    if json {
        println!(
            "{}",
            serde_json::json!({ "token": token, "rotated": rotate })
        );
    } else {
        println!("{token}");
    }
    Ok(())
}

pub(crate) fn set_key(reference: &str, json: bool) -> Result<(), CliError> {
    use std::io::{IsTerminal, Read};
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err(CliError::user(
            "read the key from stdin, e.g. `printf %s \"$KEY\" | berth provider set-key <id>`",
        ));
    }
    let mut key = String::new();
    stdin
        .read_to_string(&mut key)
        .map_err(|error| CliError::user(format!("cannot read stdin: {error}")))?;
    let key = key.trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return Err(CliError::user(
            "stdin must contain exactly one non-empty key",
        ));
    }
    let instance = crate::project::resolve_instance(json)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    let id = runtime
        .block_on(crate::provider_launch::provider_id(&instance, reference))
        .map_err(CliError::user)?;
    // 只认自定义档案（官方档案不存 Key）；`api_key_account` 与 GUI 同一条目。
    let loaded = runtime
        .block_on(crate::provider_launch::load_with_secrets(&instance, id, ""))
        .map_err(CliError::user)?
        .ok_or_else(|| CliError::user(format!("provider {id} not found or official")))?;
    crate::provider_launch::store_api_key(&instance, id, key).map_err(CliError::user)?;
    let name = &loaded.launch.provider.name;
    if json {
        println!(
            "{}",
            serde_json::json!({ "id": id, "name": name, "saved": true })
        );
    } else {
        println!("key saved for provider {id} ({name})");
    }
    Ok(())
}

/// 打印不含 Key 的档案导出（`berth.providers/1`），可直接重定向成备份文件。
pub(crate) fn export() -> Result<(), CliError> {
    // 输出本身是 JSON，错误也按 JSON 报。
    let instance = crate::project::resolve_instance(true)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    let exported = runtime
        .block_on(crate::provider_launch::export(&instance))
        .map_err(CliError::user)?;
    let text = serde_json::to_string_pretty(&exported)
        .map_err(|error| CliError::user(error.to_string()))?;
    println!("{text}");
    Ok(())
}

/// 档案目录模型 id（`model` 列：对象数组或字符串数组），供脚本挑默认模型。
pub(crate) fn model_ids(raw: Option<&str>) -> Vec<String> {
    let rows: Vec<serde_json::Value> = raw
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    rows.iter()
        .filter_map(|row| row.as_str().or_else(|| row.get("id")?.as_str()))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 按终端显示宽度补齐：非 ASCII（中日韩等）按两列计。
// ponytail: 粗略宽度，emoji / 组合字符会偏；遇到再换 unicode-width。
fn pad(text: &str, width: usize) -> String {
    let used: usize = text.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum();
    format!("{text}{}", " ".repeat(width.saturating_sub(used)))
}

pub(crate) fn list(port: Option<u16>, json: bool) -> Result<(), CliError> {
    let instance = crate::project::resolve_instance(json)?;
    let port = port.unwrap_or_else(|| crate::provider_launch::proxy_port(&instance));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    let providers = runtime
        .block_on(crate::provider_launch::list_with_secrets(&instance))
        .map_err(CliError::user)?;
    let mut rows = Vec::new();
    for loaded in &providers {
        let provider = &loaded.launch.provider;
        for protocol in protocols(loaded) {
            let lookup = protocol.as_str();
            let route = route(loaded, lookup, None);
            let upstream = resolve_endpoint_override(
                loaded.discovery.as_deref(),
                lookup,
                &provider.api_url,
                "",
            )
            .0;
            rows.push(serde_json::json!({
                "id": provider.id,
                "name": provider.name,
                "protocol": protocol,
                "upstream": upstream,
                "hasKey": route.as_ref().is_ok_and(|route| !route.key.trim().is_empty()),
                "models": model_ids(provider.model.as_deref()),
                "proxyBaseUrl": format!("{}/{protocol}", provider_base_url(port, provider.id)),
            }));
        }
    }
    if json {
        println!("{}", serde_json::Value::Array(rows));
        return Ok(());
    }
    for row in &rows {
        println!(
            "{:>4}  {}  {:<7}  {:<3}  {:<44}  {}",
            row["id"].as_i64().unwrap_or_default(),
            pad(row["name"].as_str().unwrap_or_default(), 24),
            row["protocol"].as_str().unwrap_or_default(),
            if row["hasKey"] == true { "key" } else { "-" },
            row["proxyBaseUrl"].as_str().unwrap_or_default(),
            row["upstream"].as_str().unwrap_or_default(),
        );
    }
    Ok(())
}

/// 拒绝原因只进 stderr（不含 Key），调用方只拿到 404。
fn deny(id: i32, reason: &str) -> Result<Route, Denied> {
    eprintln!("provider {id}: {reason}");
    Err(Denied::UnknownProvider)
}

pub(crate) fn run(port: Option<u16>) -> Result<(), CliError> {
    let instance = crate::project::resolve_instance(false)?;
    let port = port.unwrap_or_else(|| crate::provider_launch::proxy_port(&instance));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(CliError::from_runtime)?;
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|error| {
                CliError::user(format!("cannot listen on 127.0.0.1:{port}: {error}"))
            })?;
        let client = upstream_client().map_err(|error| CliError::user(error.to_string()))?;
        let token = match crate::provider_launch::proxy_token(&instance).map_err(CliError::user)? {
            Some(token) => token,
            None => {
                crate::provider_launch::rotate_proxy_token(&instance).map_err(CliError::user)?
            }
        };
        println!("Berth provider proxy: http://127.0.0.1:{port}/p/<provider-id>/<protocol>");
        println!("token: {token}  (berth provider token --rotate to replace it)");
        serve(listener, client, Arc::new(CliResolver { instance }))
            .await
            .map_err(CliError::from_runtime)
    })
}

#[cfg(test)]
mod tests {
    use super::model_ids;

    #[test]
    fn model_ids_reads_objects_and_strings() {
        assert_eq!(
            model_ids(Some(
                r#"[{"id":"jev-latest","name":"Jev"}," b ",{"name":"x"}]"#
            )),
            ["jev-latest", "b"]
        );
        assert!(model_ids(Some("not json")).is_empty());
        assert!(model_ids(None).is_empty());
    }
}
