//! 决策协议（`discovery_json.endpoints.systemone`，如 TypeSafe Jev）：用已保存档案的地址与
//! Key 代发一次 `POST <url>/v1/systemone`，响应 JSON 原样交回设置页的决策面板。
//! Key 经 `secrets`（本地凭据文件）读取，只在后端内存里使用，不回传前端。

use std::time::Duration;

use sea_orm::DatabaseConnection;
use serde_json::{json, Value};

use crate::app_error::AppCommandError;
use berth_project_core::service::model_provider_launch;
use berth_tool_core::provider_injection::resolve_upstream;

pub const PROTOCOL: &str = "systemone";

pub async fn evaluate(
    conn: &DatabaseConnection,
    provider_id: i32,
    model: &str,
    state: Value,
    questions: Value,
    timeout: Duration,
) -> Result<Value, AppCommandError> {
    let launch = model_provider_launch::load(conn, provider_id, PROTOCOL)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("model provider not found"))?;
    let provider = &launch.provider;
    let discovery = super::secrets::load_discovery(conn, provider)
        .await
        .map_err(AppCommandError::from)?;
    if declared_url(discovery.as_deref()).is_none() {
        return Err(AppCommandError::configuration_missing(
            "this provider has no decision (systemone) endpoint",
        ));
    }
    let api_key = super::secrets::load_api_key(conn, provider)
        .await
        .map_err(AppCommandError::from)?;
    let (root, key) = resolve_upstream(
        discovery.as_deref(),
        PROTOCOL,
        &provider.api_url,
        &api_key,
        Some(model),
    );
    if key.trim().is_empty() {
        return Err(AppCommandError::configuration_missing(
            "this provider has no API key",
        ));
    }

    // 每次新建 client：reqwest 在 build 时读系统代理变量（同 `declared`）。
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| AppCommandError::network(error.to_string()))?;
    let response = client
        .post(endpoint_url(&root))
        .bearer_auth(key.trim())
        .json(&json!({ "state": state, "model": model, "questions": questions }))
        .send()
        .await
        .map_err(|error| AppCommandError::network(error.without_url().to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppCommandError::network(error.without_url().to_string()))?;
    if !status.is_success() {
        let detail: String = body.trim().chars().take(500).collect();
        return Err(AppCommandError::task_execution_failed(format!(
            "decision request failed: HTTP {}",
            status.as_u16()
        ))
        .with_detail(detail));
    }
    serde_json::from_str(&body)
        .map_err(|_| AppCommandError::task_execution_failed("decision response is not JSON"))
}

/// 档案显式声明的决策端点；不回退主地址（主地址可能是 chat 协议）。
fn declared_url(discovery: Option<&str>) -> Option<String> {
    let value: Value = serde_json::from_str(discovery?).ok()?;
    let endpoint = value.get("endpoints")?.get(PROTOCOL)?;
    endpoint
        .get("apiUrl")
        .or_else(|| endpoint.get("api_url"))?
        .as_str()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
}

/// 用户填根地址（`https://api.typesafe.ai`）；带 `/v1` 或完整路径也认。
fn endpoint_url(root: &str) -> String {
    let root = root.trim().trim_end_matches('/');
    if root.ends_with("/v1/systemone") {
        root.to_owned()
    } else if root.ends_with("/v1") {
        format!("{root}/systemone")
    } else {
        format!("{root}/v1/systemone")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_accepts_root_v1_or_full_path() {
        for root in [
            "https://api.typesafe.ai",
            "https://api.typesafe.ai/",
            "https://api.typesafe.ai/v1",
            "https://api.typesafe.ai/v1/systemone",
        ] {
            assert_eq!(endpoint_url(root), "https://api.typesafe.ai/v1/systemone");
        }
    }

    #[test]
    fn only_an_explicit_systemone_endpoint_counts() {
        assert_eq!(
            declared_url(Some(
                r#"{"endpoints":{"systemone":{"apiUrl":" https://j "}}}"#
            ))
            .as_deref(),
            Some("https://j")
        );
        assert_eq!(
            declared_url(Some(r#"{"endpoints":{"chat":{"apiUrl":"https://c"}}}"#)),
            None
        );
        assert_eq!(declared_url(None), None);
    }
}
