use std::sync::Arc;
use std::time::Duration;

use axum::{extract::State, http::StatusCode, response::Json};
use serde::{Deserialize, Serialize};
use tauri::Runtime;

use crate::target::{list_windows, resolve_target};
use crate::webview::eval_with_result;
use crate::{BridgeState, EvalResult};

/// Commands can do real work (DB queries, network) — allow more than eval.
const INVOKE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
pub struct InvokeRequest {
    pub command: String,
    #[serde(default)]
    pub args: serde_json::Value,
    /// Optional webview label to route the invoke through. Defaults to "main".
    pub window: Option<String>,
}

#[derive(Serialize)]
pub struct CommandInfo {
    pub name: String,
}

#[derive(Serialize)]
pub struct WebviewInfo {
    pub label: String,
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct WindowInfo {
    pub label: String,
    pub title: Option<String>,
    pub url: Option<String>,
    pub is_visible: bool,
    pub is_focused: bool,
    /// All webviews hosted by this window. A plain window has exactly one,
    /// sharing the window's label; `Window::add_child` webviews appear here
    /// and are targetable as "<label>" or "<window>/<label>".
    pub webviews: Vec<WebviewInfo>,
}

/// POST /invoke — call a registered Tauri command by routing through a webview.
/// Since Tauri doesn't expose a Rust-side command invocation API, we inject JS
/// that calls `window.__TAURI_INTERNALS__.invoke()` and captures the result.
pub async fn invoke<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
    Json(req): Json<InvokeRequest>,
) -> Result<Json<EvalResult>, (StatusCode, String)> {
    let target = resolve_target(&state, req.window.as_deref())?;

    let args_json = serde_json::to_string(&req.args)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid args: {e}")))?;

    let invoke_js = format!(
        r#"
        try {{
            const result = await window.__TAURI_INTERNALS__.invoke({cmd}, {args});
            return result;
        }} catch(e) {{
            throw new Error('invoke failed: ' + e);
        }}
        "#,
        cmd = serde_json::to_string(&req.command).unwrap(),
        args = args_json,
    );

    let result = eval_with_result(&state, &target, &invoke_js, INVOKE_TIMEOUT).await?;
    Ok(Json(result))
}

/// GET /commands — list all registered Tauri commands.
/// Since Tauri doesn't expose a public command registry, this endpoint
/// is a placeholder that apps can populate via the plugin API.
pub async fn commands<R: Runtime>(
    State(_state): State<Arc<BridgeState<R>>>,
) -> Result<Json<Vec<CommandInfo>>, (StatusCode, String)> {
    // TODO: Allow apps to register command metadata with the plugin.
    Ok(Json(vec![]))
}

/// GET /state — dump managed state.
/// Placeholder — apps need to register serializable state with the plugin.
pub async fn state<R: Runtime>(
    State(_state): State<Arc<BridgeState<R>>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    Ok(Json(serde_json::json!({
        "note": "state inspection requires app integration — register state types with the plugin"
    })))
}

/// GET /windows — list all open windows and their webviews, including child
/// webviews that `webview_windows()` can't see.
pub async fn windows<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
) -> Result<Json<Vec<WindowInfo>>, (StatusCode, String)> {
    let windows: Vec<WindowInfo> = list_windows(&state)
        .into_iter()
        .map(|entry| {
            let webviews: Vec<WebviewInfo> = entry
                .targets
                .iter()
                .map(|t| WebviewInfo {
                    label: t.label(),
                    url: t.url(),
                })
                .collect();
            // Targets are ordered primary-first, so this is the window's own
            // content webview when one exists.
            let url = entry.targets.first().and_then(|t| t.url());
            WindowInfo {
                label: entry.label,
                title: entry.title,
                url,
                is_visible: entry.visible,
                is_focused: entry.focused,
                webviews,
            }
        })
        .collect();

    Ok(Json(windows))
}

/// GET /config — return the app's Tauri config.
pub async fn config<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let config = state.app.config();
    let json = serde_json::to_value(config)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json))
}
