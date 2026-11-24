use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{Json, Response},
};
use serde::{Deserialize, Serialize};
use tauri::Runtime;
use tokio::sync::oneshot;

use crate::target::{Target, resolve_target};
use crate::{BridgeState, EvalResult};

/// Default timeout for JS round-trips through the eval callback.
pub const EVAL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
pub struct EvalRequest {
    pub js: String,
    /// Optional webview label ("main", "live-main", or "main/live-main").
    /// Defaults to "main".
    pub window: Option<String>,
}

#[derive(Deserialize)]
pub struct ClickRequest {
    pub selector: String,
    pub window: Option<String>,
}

#[derive(Deserialize)]
pub struct FillRequest {
    pub selector: String,
    pub text: String,
    pub window: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct SnapshotElement {
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub interactive: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<SnapshotElement>,
}

#[derive(Serialize, Deserialize)]
pub struct SnapshotResponse {
    pub title: String,
    pub url: String,
    pub elements: Vec<SnapshotElement>,
}

#[derive(Deserialize, Default)]
pub struct SnapshotQuery {
    pub interactive: Option<bool>,
    pub window: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct ScreenshotQuery {
    pub window: Option<String>,
}

/// Inject JS that evaluates code and sends the result back via the plugin's
/// `eval_callback` Tauri command. Returns the result via a oneshot channel.
pub async fn eval_with_result<R: Runtime>(
    state: &BridgeState<R>,
    target: &Target<R>,
    js_code: &str,
    timeout: Duration,
) -> Result<EvalResult, (StatusCode, String)> {
    let id = uuid_v4();
    let (tx, rx) = oneshot::channel();

    {
        let mut pending = state.pending.lock().await;
        pending.insert(id.clone(), tx);
    }

    // Wrap the user's JS so it evaluates and calls back with the result.
    // Use __TAURI_INTERNALS__ which is always available in the Tauri webview,
    // unlike window.__TAURI__ which requires the @tauri-apps/api import.
    //
    // For single-line expressions (like `document.title`), auto-add `return`.
    // For multi-line code or code with statement keywords, pass through as-is
    // (callers must use `return` explicitly).
    // Note: we avoid eval() since webview CSP may not include 'unsafe-eval'.
    //
    // A misclassified expression (e.g. `el.click(); 'done'` — one line, but
    // two statements) turns `return (…)` into a SyntaxError. The injection
    // is fire-and-forget, so a parse error used to surface as nothing but a
    // 10s timeout. On macOS the injection now watches the JS error: parse
    // errors on the expression form retry as statements, and anything else
    // fulfills the pending request with the real exception message.
    let primary = wrap_eval_js(js_code, &id, looks_like_expression(js_code));
    let fallback = looks_like_expression(js_code).then(|| wrap_eval_js(js_code, &id, false));

    inject(state, target, &id, primary, fallback)?;

    // Wait for result with timeout.
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "eval callback channel dropped".to_string(),
        )),
        Err(_) => {
            // Clean up the pending entry.
            let mut pending = state.pending.lock().await;
            pending.remove(&id);
            Err((
                StatusCode::GATEWAY_TIMEOUT,
                format!("eval timed out after {}s", timeout.as_secs()),
            ))
        }
    }
}

/// Build the injected script for one wrapping strategy. `as_expression`
/// auto-returns the code's value; otherwise the code runs as statements and
/// must `return` explicitly. The whole thing is `void`-prefixed so the
/// script's own completion value is undefined, not a Promise — WKWebView
/// reports Promise results as unsupported-type errors.
fn wrap_eval_js(js_code: &str, id: &str, as_expression: bool) -> String {
    let code_body = if as_expression {
        // A trailing semicolon inside `return (…)` is a SyntaxError; shed it.
        let expr = js_code
            .trim()
            .trim_end_matches(|c: char| c == ';' || c.is_whitespace());
        format!("return ({expr})")
    } else {
        js_code.to_string()
    };

    format!(
        r#"void (async () => {{
            try {{
                const __result = await (async () => {{ {code} }})();
                await window.__TAURI_INTERNALS__.invoke(
                    'plugin:debug-bridge|eval_callback',
                    {{ id: '{id}', success: true, value: __result, error: null }}
                );
            }} catch(__e) {{
                await window.__TAURI_INTERNALS__.invoke(
                    'plugin:debug-bridge|eval_callback',
                    {{ id: '{id}', success: false, value: null, error: __e.toString() }}
                );
            }}
        }})()"#,
        code = code_body,
        id = id,
    )
}

/// macOS: inject via `evaluateJavaScript:completionHandler:` so JS-level
/// failures are observable. A SyntaxError on the auto-return (expression)
/// form retries once with the statement form; any remaining error fulfills
/// the pending request immediately instead of leaving it to time out.
#[cfg(any())] // Berth vendored：CEF 下不是 WKWebView，原生分支停用，见 VENDORED.md
fn inject<R: Runtime>(
    state: &BridgeState<R>,
    target: &Target<R>,
    id: &str,
    primary: String,
    fallback: Option<String>,
) -> Result<(), (StatusCode, String)> {
    let pending = state.pending.clone();
    let id = id.to_string();

    target
        .with_webview(move |platform_webview| {
            use objc2::runtime::AnyObject;
            use objc2_foundation::{NSError, NSString};
            use objc2_web_kit::{WKErrorCode, WKWebView};

            let ptr = platform_webview.inner();
            // SAFETY: Tauri guarantees this is a valid WKWebView pointer.
            let wkwebview: &WKWebView = unsafe { &*(ptr as *const WKWebView) };

            // Pull the JS exception text out of an evaluateJavaScript error.
            // Ignores unsupported-result-type noise (code 5) — the script is
            // `void`-prefixed, so that would be spurious anyway.
            let describe = |error: *mut NSError| -> Option<String> {
                if error.is_null() {
                    return None;
                }
                // SAFETY: non-null NSError from the completion handler.
                let error: &NSError = unsafe { &*error };
                if error.code() == WKErrorCode::JavaScriptResultTypeIsUnsupported.0 {
                    return None;
                }
                let user_info = error.userInfo();
                let message = user_info
                    .objectForKey(&*NSString::from_str("WKJavaScriptExceptionMessage"))
                    .and_then(|m| m.downcast::<NSString>().ok())
                    .map(|m| m.to_string())
                    .unwrap_or_else(|| error.localizedDescription().to_string());
                Some(message)
            };

            // Fulfill the pending eval with a JS-side failure. Runs on the
            // main thread, so hop to the async runtime for the tokio lock.
            let report = {
                let pending = pending.clone();
                let id = id.clone();
                move |message: String| {
                    let pending = pending.clone();
                    let id = id.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(tx) = pending.lock().await.remove(&id) {
                            let _ = tx.send(EvalResult {
                                success: false,
                                value: None,
                                error: Some(message),
                            });
                        }
                    });
                }
            };

            // Completion for the statement-form retry: any error is terminal.
            let retry_report = report.clone();
            let retry_block =
                block2::RcBlock::new(move |_result: *mut AnyObject, error: *mut NSError| {
                    if let Some(message) = describe(error) {
                        retry_report(message);
                    }
                });

            // The retry needs the webview again after the first completion
            // fires; keep a strong reference. SAFETY: ptr is a live WKWebView.
            let retained: objc2::rc::Retained<WKWebView> =
                unsafe { objc2::rc::Retained::retain(ptr.cast()) }
                    .expect("WKWebView pointer is non-null");
            let fallback = std::sync::Mutex::new(fallback);
            let first_block =
                block2::RcBlock::new(move |_result: *mut AnyObject, error: *mut NSError| {
                    let Some(message) = describe(error) else {
                        return;
                    };
                    let retry = message
                        .contains("SyntaxError")
                        .then(|| fallback.lock().unwrap().take())
                        .flatten();
                    match retry {
                        Some(script) => unsafe {
                            retained.evaluateJavaScript_completionHandler(
                                &NSString::from_str(&script),
                                Some(&retry_block),
                            );
                        },
                        None => report(message),
                    }
                });

            unsafe {
                wkwebview.evaluateJavaScript_completionHandler(
                    &NSString::from_str(&primary),
                    Some(&first_block),
                );
            }
        })
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Non-macOS: plain fire-and-forget injection. Parse errors still surface
/// only as timeouts here.
fn inject<R: Runtime>(
    _state: &BridgeState<R>,
    target: &Target<R>,
    _id: &str,
    primary: String,
    _fallback: Option<String>,
) -> Result<(), (StatusCode, String)> {
    target
        .eval(&primary)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// POST /eval — execute JS in the webview and return the result.
pub async fn webview_eval<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
    Json(req): Json<EvalRequest>,
) -> Result<Json<EvalResult>, (StatusCode, String)> {
    let target = resolve_target(&state, req.window.as_deref())?;
    let result = eval_with_result(&state, &target, &req.js, EVAL_TIMEOUT).await?;
    Ok(Json(result))
}

/// GET /screenshot — capture a webview as a PNG image.
pub async fn screenshot<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
    Query(query): Query<ScreenshotQuery>,
) -> Result<Response, (StatusCode, String)> {
    let target = resolve_target(&state, query.window.as_deref())?;

    let png_data = native_screenshot(&target).await?;

    Ok(axum::response::Response::builder()
        .header("Content-Type", "image/png")
        .body(axum::body::Body::from(png_data))
        .unwrap())
}

/// macOS: Use WKWebView's native takeSnapshot API.
#[cfg(any())] // Berth vendored：CEF 下不是 WKWebView，原生分支停用，见 VENDORED.md
async fn native_screenshot<R: Runtime>(
    target: &Target<R>,
) -> Result<Vec<u8>, (StatusCode, String)> {
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();

    target
        .with_webview(move |platform_webview| {
            use objc2_app_kit::NSImage;
            use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

            let ptr = platform_webview.inner();
            // SAFETY: Tauri guarantees this is a valid WKWebView pointer.
            let wkwebview: &WKWebView = unsafe { &*(ptr as *const WKWebView) };

            // afterScreenUpdates forces a fresh render pass before capture.
            // Without it, an occluded/backgrounded window returns the last
            // composited frame — DOM changes made via the bridge (an opened
            // modal, streamed text) silently don't appear in the capture.
            // with_webview runs on the main thread, so the marker is present;
            // fall back to a default snapshot rather than panicking if not.
            let config = objc2_foundation::MainThreadMarker::new()
                .map(|mtm| unsafe { WKSnapshotConfiguration::new(mtm) });
            if let Some(c) = &config {
                unsafe { c.setAfterScreenUpdates(true) };
            }

            // Use a Mutex to allow the closure to be called as Fn (block2 requires Fn).
            // The completion handler is only called once by WKWebView.
            let tx = std::sync::Mutex::new(Some(tx));
            let block = block2::RcBlock::new(
                move |image: *mut NSImage, error: *mut objc2_foundation::NSError| {
                    let result = if !image.is_null() && error.is_null() {
                        // SAFETY: WKWebView guarantees image is valid when error is nil.
                        let image: &NSImage = unsafe { &*image };
                        match image_to_png(image) {
                            Some(data) => Ok(data),
                            None => Err("failed to convert NSImage to PNG".to_string()),
                        }
                    } else if !error.is_null() {
                        let error: &objc2_foundation::NSError = unsafe { &*error };
                        Err(format!("WKWebView takeSnapshot failed: {error}"))
                    } else {
                        Err("takeSnapshot returned nil image".to_string())
                    };
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(result);
                    }
                },
            );

            unsafe {
                wkwebview
                    .takeSnapshotWithConfiguration_completionHandler(config.as_deref(), &block);
            }
        })
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("with_webview failed: {e}"),
            )
        })?;

    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(Ok(data))) => Ok(data),
        Ok(Ok(Err(e))) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
        Ok(Err(_)) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "screenshot channel dropped".to_string(),
        )),
        Err(_) => Err((
            StatusCode::GATEWAY_TIMEOUT,
            "screenshot timed out after 10s".to_string(),
        )),
    }
}

/// Convert NSImage to PNG bytes.
#[cfg(any())] // Berth vendored：CEF 下不是 WKWebView，原生分支停用，见 VENDORED.md
fn image_to_png(image: &objc2_app_kit::NSImage) -> Option<Vec<u8>> {
    use objc2_app_kit::NSBitmapImageRep;

    unsafe {
        // Get TIFF representation from NSImage
        let tiff_data = image.TIFFRepresentation()?;

        // Create NSBitmapImageRep from TIFF data
        let rep = NSBitmapImageRep::imageRepWithData(&tiff_data)?;

        // Convert to PNG
        let png_data = rep.representationUsingType_properties(
            objc2_app_kit::NSBitmapImageFileType::PNG,
            &objc2_foundation::NSDictionary::new(),
        )?;

        Some(png_data.to_vec())
    }
}

/// Non-macOS fallback: not yet implemented.
async fn native_screenshot<R: Runtime>(
    _target: &Target<R>,
) -> Result<Vec<u8>, (StatusCode, String)> {
    Err((
        StatusCode::NOT_IMPLEMENTED,
        "screenshot not yet implemented on this platform".to_string(),
    ))
}

/// GET /snapshot — dump the DOM as a ref-based accessibility tree.
/// Pass `?interactive=true` to prune non-interactive leaf nodes.
pub async fn snapshot<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<SnapshotResponse>, (StatusCode, String)> {
    let target = resolve_target(&state, query.window.as_deref())?;

    let js = SNAPSHOT_JS;
    let result = eval_with_result(&state, &target, js, EVAL_TIMEOUT).await?;

    match result.value {
        Some(val) => {
            let mut snapshot: SnapshotResponse = serde_json::from_value(val).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to parse snapshot: {e}"),
                )
            })?;

            if query.interactive == Some(true) {
                snapshot.elements = prune_non_interactive(snapshot.elements);
            }

            Ok(Json(snapshot))
        }
        None => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("snapshot failed: {}", result.error.unwrap_or_default()),
        )),
    }
}

/// Recursively prune non-interactive leaf nodes from the snapshot tree.
/// Keeps any element that is interactive, or that has a descendant that is interactive.
fn prune_non_interactive(elements: Vec<SnapshotElement>) -> Vec<SnapshotElement> {
    elements
        .into_iter()
        .filter_map(|mut el| {
            el.children = prune_non_interactive(el.children);
            if el.interactive || !el.children.is_empty() {
                Some(el)
            } else {
                None
            }
        })
        .collect()
}

/// POST /click — click an element by @ref or CSS selector.
pub async fn click<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
    Json(req): Json<ClickRequest>,
) -> Result<Json<EvalResult>, (StatusCode, String)> {
    let target = resolve_target(&state, req.window.as_deref())?;

    let js = if req.selector.starts_with('@') {
        // Ref-based: find element by data-debug-ref attribute
        format!(
            r#"
            const el = document.querySelector('[data-debug-ref="{}"]');
            if (!el) throw new Error('Ref not found: {}');
            el.scrollIntoView({{block: 'center'}});
            el.click();
            return true;
            "#,
            &req.selector[1..],
            req.selector,
        )
    } else {
        format!(
            r#"
            const el = document.querySelector({});
            if (!el) throw new Error('Element not found: {}');
            el.scrollIntoView({{block: 'center'}});
            el.click();
            return true;
            "#,
            serde_json::to_string(&req.selector).unwrap(),
            req.selector,
        )
    };

    let result = eval_with_result(&state, &target, &js, EVAL_TIMEOUT).await?;
    Ok(Json(result))
}

/// POST /fill — fill an input element with text.
pub async fn fill<R: Runtime>(
    State(state): State<Arc<BridgeState<R>>>,
    Json(req): Json<FillRequest>,
) -> Result<Json<EvalResult>, (StatusCode, String)> {
    let target = resolve_target(&state, req.window.as_deref())?;

    let text_json = serde_json::to_string(&req.text).unwrap();
    let selector_json = if req.selector.starts_with('@') {
        serde_json::to_string(&format!("[data-debug-ref=\"{}\"]", &req.selector[1..])).unwrap()
    } else {
        serde_json::to_string(&req.selector).unwrap()
    };

    // Set the value through the element's *prototype* setter, not `el.value=`.
    // Controlled frameworks (React) install an instance-level value tracker
    // that dedupes the subsequent input event when the value is assigned
    // directly, so the app's state never updates. The prototype setter
    // bypasses the tracker and the dispatched events register normally.
    let js = format!(
        r#"
        const el = document.querySelector({selector});
        if (!el) throw new Error('Element not found: {label}');
        el.scrollIntoView({{block: 'center'}});
        el.focus();
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (desc && desc.set) {{ desc.set.call(el, {text}); }} else {{ el.value = {text}; }}
        el.dispatchEvent(new Event('input', {{bubbles: true}}));
        el.dispatchEvent(new Event('change', {{bubbles: true}}));
        return true;
        "#,
        selector = selector_json,
        label = req.selector,
        text = text_json,
    );

    let result = eval_with_result(&state, &target, &js, EVAL_TIMEOUT).await?;
    Ok(Json(result))
}

/// Detect if JS code is a simple expression (no statements).
/// Single-line code without statement keywords gets auto-wrapped with `return`.
fn looks_like_expression(code: &str) -> bool {
    let trimmed = code.trim();
    if trimmed.contains('\n') {
        return false;
    }
    let keywords = [
        "return ",
        "return;",
        "const ",
        "let ",
        "var ",
        "if ",
        "if(",
        "for ",
        "for(",
        "while ",
        "while(",
        "switch ",
        "switch(",
        "throw ",
        "try ",
        "try{",
        "class ",
        "function ",
        "async function",
    ];
    !keywords.iter().any(|kw| trimmed.starts_with(kw))
}

/// Generate a random 128-bit hex ID for correlating eval requests.
pub fn uuid_v4() -> String {
    use rand::Rng;
    let bytes: [u8; 16] = rand::thread_rng().r#gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// JavaScript that walks the DOM and builds a ref-based accessibility tree.
/// Same pattern as agent-browser — assigns data-debug-ref attributes to
/// interactive elements and returns a structured tree.
const SNAPSHOT_JS: &str = r#"
    return (() => {
        let refCounter = 0;

        const INTERACTIVE_TAGS = new Set([
            'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS',
            'SUMMARY', 'LABEL', 'OPTION'
        ]);

        const INTERACTIVE_ROLES = new Set([
            'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
            'listbox', 'menuitem', 'tab', 'switch', 'slider', 'spinbutton',
            'searchbox', 'option', 'menuitemcheckbox', 'menuitemradio',
            'treeitem'
        ]);

        function isInteractive(el) {
            if (INTERACTIVE_TAGS.has(el.tagName)) return true;
            const role = el.getAttribute('role');
            if (role && INTERACTIVE_ROLES.has(role)) return true;
            if (el.getAttribute('tabindex') !== null) return true;
            if (el.onclick || el.getAttribute('onclick')) return true;
            return false;
        }

        function isVisible(el) {
            if (el === document.body || el === document.documentElement) return true;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' &&
                   style.visibility !== 'hidden' &&
                   style.opacity !== '0' &&
                   el.offsetParent !== null;
        }

        function getTextContent(el) {
            let text = '';
            for (const child of el.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    const t = child.textContent.trim();
                    if (t) text += (text ? ' ' : '') + t;
                }
            }
            return text || null;
        }

        function walkNode(el) {
            if (el.nodeType !== Node.ELEMENT_NODE) return null;
            if (!isVisible(el)) return null;

            const tag = el.tagName.toLowerCase();

            // Skip script, style, and other non-visual elements
            if (['script', 'style', 'noscript', 'template'].includes(tag)) return null;

            const interactive = isInteractive(el);
            let ref_id = null;

            if (interactive) {
                ref_id = 'e' + (++refCounter);
                el.setAttribute('data-debug-ref', ref_id);
            }

            const children = [];
            for (const child of el.children) {
                const node = walkNode(child);
                if (node) children.push(node);
            }

            // Skip non-interactive containers with no text and only one child
            const text = getTextContent(el);
            if (!interactive && !text && children.length <= 1 && !el.getAttribute('role')) {
                return children[0] || null;
            }

            const node = {
                tag: tag,
                ref: ref_id,
                interactive: interactive,
            };

            const role = el.getAttribute('role');
            if (role) node.role = role;
            if (text) node.text = text;

            const ariaLabel = el.getAttribute('aria-label');
            const name = ariaLabel || el.getAttribute('name') || el.getAttribute('placeholder');
            if (name) node.name = name;

            if (el.value !== undefined && el.value !== '') {
                node.value = String(el.value);
            }

            if (children.length > 0) node.children = children;

            return node;
        }

        const tree = walkNode(document.body);
        return {
            title: document.title,
            url: window.location.href,
            elements: tree ? (tree.children || [tree]) : [],
        };
    })();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expression_detection() {
        // Simple expressions — should auto-return
        assert!(looks_like_expression("document.title"));
        assert!(looks_like_expression("1 + 2"));
        assert!(looks_like_expression("foo()"));
        assert!(looks_like_expression(
            "document.querySelectorAll('li').length"
        ));
        assert!(looks_like_expression("await fetch('/api')"));

        // Statements — should NOT auto-return
        assert!(!looks_like_expression("return 42"));
        assert!(!looks_like_expression("const x = 1"));
        assert!(!looks_like_expression("let x = 1"));
        assert!(!looks_like_expression("var x = 1"));
        assert!(!looks_like_expression("if (true) { }"));
        assert!(!looks_like_expression("for (;;) {}"));
        assert!(!looks_like_expression("throw new Error()"));

        // Multi-line — always treated as statements
        assert!(!looks_like_expression("const x = 1;\nreturn x"));
    }

    #[test]
    fn expression_wrap_sheds_trailing_semicolon() {
        // `return (document.title;)` is a SyntaxError; the wrap must strip
        // trailing semicolons before parenthesizing.
        let js = wrap_eval_js("document.title;", "abc", true);
        assert!(js.contains("return (document.title)"), "{js}");
        let js = wrap_eval_js("document.title ; ;", "abc", true);
        assert!(js.contains("return (document.title)"), "{js}");
    }

    #[test]
    fn statement_wrap_passes_code_through() {
        let js = wrap_eval_js("const x = 1; return x", "abc", false);
        assert!(js.contains("const x = 1; return x"), "{js}");
        assert!(!js.contains("return (const"), "{js}");
    }

    #[test]
    fn wrap_is_void_prefixed() {
        // The script's completion value must be undefined, not a Promise —
        // WKWebView reports Promise results as unsupported-type errors.
        for as_expression in [true, false] {
            let js = wrap_eval_js("document.title", "abc", as_expression);
            assert!(js.trim_start().starts_with("void ("), "{js}");
        }
    }

    #[test]
    fn uuid_format() {
        let id = uuid_v4();
        assert_eq!(id.len(), 32, "should be 32 hex chars");
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit()),
            "should only contain hex chars"
        );
    }

    #[test]
    fn uuid_uniqueness() {
        let ids: Vec<String> = (0..100).map(|_| uuid_v4()).collect();
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(ids.len(), unique.len(), "100 IDs should all be unique");
    }

    #[test]
    fn prune_removes_non_interactive_leaves() {
        let tree = vec![SnapshotElement {
            tag: "div".to_string(),
            r#ref: None,
            role: None,
            text: Some("container".to_string()),
            name: None,
            value: None,
            interactive: false,
            children: vec![
                SnapshotElement {
                    tag: "button".to_string(),
                    r#ref: Some("e1".to_string()),
                    role: None,
                    text: Some("Click me".to_string()),
                    name: None,
                    value: None,
                    interactive: true,
                    children: vec![],
                },
                SnapshotElement {
                    tag: "span".to_string(),
                    r#ref: None,
                    role: None,
                    text: Some("static text".to_string()),
                    name: None,
                    value: None,
                    interactive: false,
                    children: vec![],
                },
            ],
        }];

        let pruned = prune_non_interactive(tree);
        assert_eq!(
            pruned.len(),
            1,
            "container should remain (has interactive child)"
        );
        assert_eq!(pruned[0].children.len(), 1, "only the button should remain");
        assert_eq!(pruned[0].children[0].tag, "button");
    }

    #[test]
    fn prune_removes_empty_branches() {
        let tree = vec![SnapshotElement {
            tag: "div".to_string(),
            r#ref: None,
            role: None,
            text: None,
            name: None,
            value: None,
            interactive: false,
            children: vec![SnapshotElement {
                tag: "p".to_string(),
                r#ref: None,
                role: None,
                text: Some("just text".to_string()),
                name: None,
                value: None,
                interactive: false,
                children: vec![],
            }],
        }];

        let pruned = prune_non_interactive(tree);
        assert!(
            pruned.is_empty(),
            "no interactive elements means empty result"
        );
    }
}
