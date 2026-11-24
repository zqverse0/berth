use std::sync::Arc;

use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use tauri::Runtime;

use crate::BridgeState;

/// JavaScript that hooks console.log/warn/error/info and forwards messages
/// to the debug bridge plugin via `__TAURI_INTERNALS__.invoke`, tagged with
/// the source webview's label. Idempotent — checks a flag to avoid
/// double-hooking.
pub fn console_hook_js(label: &str) -> String {
    let label_json = serde_json::to_string(label).unwrap_or_else(|_| "null".to_string());
    format!(
        r#"
(function() {{
    if (window.__debugBridgeConsoleHooked) return;
    window.__debugBridgeConsoleHooked = true;
    const __label = {label_json};

    function send(level, message, kind, detail) {{
        window.__TAURI_INTERNALS__.invoke(
            'plugin:debug-bridge|console_callback',
            {{
                level: level,
                message: message,
                label: __label,
                kind: kind || 'console',
                detail: detail || null,
            }}
        );
    }}

    function hook(level, origFn) {{
        return function(...args) {{
            origFn.apply(console, args);
            try {{
                const parts = args.map(a => {{
                    try {{ return typeof a === 'string' ? a : JSON.stringify(a); }}
                    catch {{ return String(a); }}
                }});
                send(level, parts.join(' '));
            }} catch(e) {{}}
        }};
    }}

    console.log = hook('log', console.log.bind(console));
    console.warn = hook('warn', console.warn.bind(console));
    console.error = hook('error', console.error.bind(console));
    console.info = hook('info', console.info.bind(console));
    console.debug = hook('debug', console.debug.bind(console));

    // Unhandled errors and rejections, with their stacks. The stack is the
    // whole value of catching these — "TypeError: undefined is not an object"
    // without one names a symptom and nothing else.
    window.addEventListener('error', function(e) {{
        const where = e.filename ? (' at ' + e.filename + ':' + e.lineno + ':' + e.colno) : '';
        const stack = (e.error && e.error.stack) ? String(e.error.stack) : null;
        send('error', String(e.message || e.error || 'unknown error') + where, 'error', stack);
    }});
    window.addEventListener('unhandledrejection', function(e) {{
        const r = e.reason;
        const message = (r && r.message) ? String(r.message) : String(r);
        const stack = (r && r.stack) ? String(r.stack) : null;
        send('error', message, 'unhandledrejection', stack);
    }});
}})();
"#
    )
}

/// GET /logs — WebSocket endpoint for streaming Rust-side logs.
pub async fn logs_ws<R: Runtime>(
    State(_state): State<Arc<BridgeState<R>>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(handle_logs)
}

async fn handle_logs(socket: WebSocket) {
    // Rust-side records: panics the plugin caught, plus whatever the host app
    // pushed in through `tauri_plugin_debug_bridge::record`. This used to be
    // a stub that told you to integrate tracing yourself.
    pump(socket, Some("rust")).await
}

/// Replay the matching history, then forward new records until the client
/// goes away. Replaying first is what makes these endpoints useful to an
/// agent that connects *after* the interesting failure.
async fn pump(mut socket: WebSocket, origin: Option<&'static str>) {
    let mut rx = crate::record::subscribe();

    let history = crate::record::recent(&crate::record::Query {
        limit: Some(200),
        level: None,
        origin: origin.map(|o| o.to_string()),
    });
    for rec in history {
        let Ok(json) = serde_json::to_string(&rec) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            Ok(msg) = rx.recv() => {
                // The ring broadcasts everything; each endpoint keeps its own
                // side of the bridge.
                if let Some(want) = origin {
                    let matches = serde_json::from_str::<serde_json::Value>(&msg)
                        .ok()
                        .and_then(|v| v.get("origin").and_then(|o| o.as_str()).map(|o| o == want))
                        .unwrap_or(false);
                    if !matches {
                        continue;
                    }
                }
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            Some(Ok(msg)) = socket.recv() => {
                if matches!(msg, Message::Close(_)) {
                    break;
                }
            }
            else => break,
        }
    }
}

/// GET /console — WebSocket endpoint for streaming JS console output.
/// The plugin hooks every webview's console on page load; this re-injects on
/// connect as a safety net (e.g. pages loaded before the plugin registered),
/// then streams all console messages to the client.
pub async fn console_ws<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_console(socket, state))
}

async fn handle_console<R: Runtime>(socket: WebSocket, state: Arc<BridgeState<R>>) {
    // Inject the console hook into every webview (idempotent) — a page loaded
    // before the plugin registered would otherwise never be hooked.
    for entry in crate::target::list_windows(&state) {
        for target in &entry.targets {
            let _ = target.eval(&console_hook_js(&target.label()));
        }
    }
    pump(socket, Some("js")).await
}
