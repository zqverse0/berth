use std::{collections::HashMap, sync::Arc};

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{Json, Response},
    routing::{get, post},
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};
use tokio::sync::{Mutex, oneshot};

mod backend;
mod events;
mod logs;
mod record;
mod target;
mod webview;

pub use record::{Level, Record};

/// Push a line from the host app into the bridge's record ring, where
/// `tauri-browser logs` and `GET /records` can find it.
///
/// The bridge captures JS console output and Rust panics on its own. This is
/// for everything else an app already knows went wrong — a failed background
/// sweep, a server that couldn't bind, its own error log — so that one place
/// answers "what has this app been complaining about" instead of several.
///
/// Cheap and infallible: when the plugin isn't initialized (a release build
/// with the feature off) the ring simply isn't read by anyone.
pub fn record(level: Level, kind: impl Into<String>, message: impl Into<String>) {
    record::push(record::make(level, "rust", kind, message));
}

/// Same, with a stack trace, backtrace, or other long-form detail attached.
pub fn record_detailed(
    level: Level,
    kind: impl Into<String>,
    message: impl Into<String>,
    detail: impl Into<String>,
) {
    let mut rec = record::make(level, "rust", kind, message);
    rec.detail = Some(detail.into());
    record::push(rec);
}

/// Plugin configuration, read from tauri.conf.json plugin section.
#[derive(Debug, Deserialize, Default)]
pub struct Config {
    /// Port for the debug HTTP/WS server. Defaults to 9229.
    pub port: Option<u16>,
}

/// Pending JS evaluation results, keyed by request ID.
pub type PendingResults = Arc<Mutex<HashMap<String, oneshot::Sender<EvalResult>>>>;

/// Result from a JS evaluation in the webview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalResult {
    pub success: bool,
    pub value: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// Shared state accessible to all axum route handlers.
pub struct BridgeState<R: Runtime> {
    pub app: AppHandle<R>,
    pub pending: PendingResults,
    /// Windows learned from `on_webview_ready` — covers multiwebview windows
    /// that `webview_windows()` can't see. See [`target::WindowRegistry`].
    pub windows: target::WindowRegistry<R>,
}

/// Health check response.
#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    plugin: &'static str,
    version: &'static str,
}

/// Generate a random 32-character hex token for auth.
fn generate_auth_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = Rng::r#gen(&mut rng);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Well-known directory for discovery files.
const DISCOVERY_DIR: &str = "/tmp/tauri-debug-bridge";

/// Write a discovery file so the CLI can auto-find this app's port and token.
fn write_discovery_file(identifier: &str, port: u16, token: &str) -> std::io::Result<()> {
    let dir = std::path::Path::new(DISCOVERY_DIR);
    std::fs::create_dir_all(dir)?;

    let file_path = dir.join(format!("{identifier}.json"));
    let content = serde_json::json!({ "port": port, "token": token });
    std::fs::write(&file_path, content.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

/// Middleware that checks the `X-Debug-Bridge-Token` header on every request
/// except `/health`.
async fn auth_middleware(
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, (StatusCode, String)> {
    // Skip auth for health check endpoint.
    if req.uri().path() == "/health" {
        return Ok(next.run(req).await);
    }

    let expected = req
        .extensions()
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();

    let provided = req
        .headers()
        .get("X-Debug-Bridge-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if provided != expected {
        // A bare 401 renders as an empty, undiagnosable "eval failed:" in
        // the CLI. Say what actually went wrong: the token rotates on every
        // app launch, so a stale discovery read (another instance rewrote
        // the file, or a --port override paired with the wrong file) is the
        // usual culprit.
        return Err((
            StatusCode::UNAUTHORIZED,
            "invalid or missing X-Debug-Bridge-Token — the token rotates on every app \
             launch; if the app restarted or several instances are running, drop any \
             --port/--token overrides so discovery re-reads the current pair, or restart \
             the app"
                .to_string(),
        ));
    }

    Ok(next.run(req).await)
}

/// Wrapper to store the auth token in request extensions.
#[derive(Clone)]
struct AuthToken(String);

/// Tauri command: receives JS eval results from the webview.
/// Called by injected JS via `window.__TAURI__.invoke('plugin:debug-bridge|eval_callback', ...)`.
#[tauri::command]
async fn eval_callback(
    pending: tauri::State<'_, PendingResults>,
    id: String,
    success: bool,
    value: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let mut map = pending.lock().await;
    if let Some(tx) = map.remove(&id) {
        let _ = tx.send(EvalResult {
            success,
            value,
            error,
        });
    }
    Ok(())
}

/// Tauri command: receives JS console messages from the webview.
/// Called by the injected console hook via `__TAURI_INTERNALS__.invoke`.
/// `label` identifies the source webview; hooks injected by plugin versions
/// before 0.5 don't send it.
#[tauri::command]
async fn console_callback(
    level: String,
    message: String,
    label: Option<String>,
    kind: Option<String>,
    detail: Option<String>,
) -> Result<(), String> {
    // Into the ring, which broadcasts to the live streams as a side effect.
    // Recording first is the whole point: an agent that connects after the
    // error can still see it.
    let mut rec = record::make(
        record::Level::parse(&level),
        "js",
        kind.unwrap_or_else(|| "console".to_string()),
        message,
    );
    rec.webview = label;
    rec.detail = detail;
    record::push(rec);
    Ok(())
}

/// GET /records — the ring, filtered. `limit`, `level`, and `origin` are all
/// optional query parameters.
async fn records(
    axum::extract::Query(query): axum::extract::Query<record::Query>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "records": record::recent(&query) }))
}

/// Build the axum router with all debug bridge routes.
fn build_router<R: Runtime>(state: Arc<BridgeState<R>>, token: String) -> Router {
    let auth_token = AuthToken(token);

    // Stateful routes (require BridgeState via axum State extractor).
    let stateful = Router::new()
        // Webview
        .route("/eval", post(webview::webview_eval::<R>))
        .route("/screenshot", get(webview::screenshot::<R>))
        .route("/snapshot", get(webview::snapshot::<R>))
        .route("/click", post(webview::click::<R>))
        .route("/fill", post(webview::fill::<R>))
        // Backend
        .route("/invoke", post(backend::invoke::<R>))
        .route("/commands", get(backend::commands::<R>))
        .route("/state", get(backend::state::<R>))
        .route("/windows", get(backend::windows::<R>))
        .route("/config", get(backend::config::<R>))
        // Events
        .route("/events/emit", post(events::emit::<R>))
        .route("/events/list", get(events::list::<R>))
        .route("/events/listen", get(events::listen::<R>))
        // Records: history first (GET), live second (WebSocket)
        .route("/logs", get(logs::logs_ws::<R>))
        .route("/console", get(logs::console_ws::<R>))
        .with_state(state);

    // Combine stateless health route with stateful routes, then apply security layers.
    // Layer order: outermost layer is the LAST .layer() call.
    // Extension must be outer so auth_middleware can read it from request extensions.
    Router::new()
        .route("/health", get(health))
        .route("/records", get(records))
        .merge(stateful)
        // Security: 1 MB body size limit
        .layer(DefaultBodyLimit::max(1_048_576))
        // Security: auth token check (reads AuthToken from extensions)
        .layer(middleware::from_fn(auth_middleware))
        // Inject auth token into request extensions (must be outermost)
        .layer(axum::Extension(auth_token))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        plugin: "tauri-plugin-debug-bridge",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Initialize the debug bridge plugin.
///
/// ```rust,no_run
/// // In your Tauri app's lib.rs:
/// #[cfg(feature = "debug")]
/// app.plugin(tauri_plugin_debug_bridge::init());
/// ```
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> {
    let pending: PendingResults = Arc::new(Mutex::new(HashMap::new()));
    let window_registry: target::WindowRegistry<R> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));

    Builder::<R, Option<Config>>::new("debug-bridge")
        .invoke_handler(tauri::generate_handler![eval_callback, console_callback])
        // Track every window that hosts a webview — including multiwebview
        // windows (`Window::add_child`), which `webview_windows()` skips.
        .on_webview_ready({
            let registry = window_registry.clone();
            move |webview| target::register_window(&registry, &webview)
        })
        // Hook the console on every page load so output from all webviews
        // (children included) streams, and navigation can't shed the hook.
        .on_page_load(|webview, _payload| {
            let _ = webview.eval(logs::console_hook_js(webview.label()));
        })
        .on_event({
            let registry = window_registry.clone();
            move |_app, event| {
                if let tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } = event
                {
                    registry.lock().unwrap().remove(label);
                }
            }
        })
        .setup(move |app, api| {
            // Every app that adds the bridge gets Rust panics captured, with
            // no code of its own (see record::install_panic_hook).
            record::install_panic_hook();
            record::set_log_path(record::log_path_for(&app.config().identifier));

            // Self-grant the ACL capability for the callback commands so
            // consuming apps need zero capability configuration. Without
            // this, the webview's `eval_callback` invoke is denied by
            // Tauri's ACL and every eval/snapshot/invoke round-trip times
            // out at the server, while native ops (screenshot, windows)
            // keep working — a confusing half-broken state.
            if let Err(e) = app.add_capability(
                r#"{
                    "identifier": "debug-bridge-runtime",
                    "description": "Runtime-granted callback permissions for the debug bridge (dev-only plugin)",
                    "windows": ["*"],
                    "permissions": ["debug-bridge:default"]
                }"#,
            ) {
                tracing::error!(
                    "debug-bridge: failed to self-grant capability — eval/snapshot/invoke will time out: {e}"
                );
            }

            let port = api.config().as_ref().and_then(|c| c.port).unwrap_or(9229);

            // Generate auth token for this session.
            let token = generate_auth_token();
            println!("debug-bridge auth token: {token}");
            tracing::info!("debug-bridge auth token: {token}");

            // Console messages and Rust records share one channel now: the
            // record ring broadcasts them (see record.rs), so there is
            // nothing per-instance to hand around.
            app.manage(pending.clone());

            let state = Arc::new(BridgeState {
                app: app.clone(),
                pending,
                windows: window_registry.clone(),
            });

            let router = build_router(state, token.clone());
            let identifier = app.config().identifier.clone();

            tauri::async_runtime::spawn(async move {
                let addr = format!("127.0.0.1:{port}");
                let listener = match tokio::net::TcpListener::bind(&addr).await {
                    Ok(l) => l,
                    Err(e) => {
                        tracing::error!("failed to bind debug-bridge on {addr}: {e}");
                        return;
                    }
                };

                let actual_port = listener.local_addr().unwrap().port();
                tracing::info!("debug-bridge listening on http://127.0.0.1:{actual_port}");

                // Write discovery file after binding so we have the real port
                // (important when configured port is 0 = OS-assigned).
                if let Err(e) = write_discovery_file(&identifier, actual_port, &token) {
                    tracing::warn!("failed to write discovery file: {e}");
                } else {
                    tracing::info!("debug-bridge discovery: {DISCOVERY_DIR}/{identifier}.json");
                }

                if let Err(e) = axum::serve(listener, router).await {
                    tracing::error!("debug-bridge server error: {e}");
                }
            });

            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_token_format() {
        let token = generate_auth_token();
        assert_eq!(token.len(), 32, "token should be 32 hex chars");
        assert!(
            token.chars().all(|c| c.is_ascii_hexdigit()),
            "token should only contain hex chars"
        );
    }

    #[test]
    fn auth_tokens_are_unique() {
        let t1 = generate_auth_token();
        let t2 = generate_auth_token();
        assert_ne!(t1, t2, "consecutive tokens should differ");
    }
}
