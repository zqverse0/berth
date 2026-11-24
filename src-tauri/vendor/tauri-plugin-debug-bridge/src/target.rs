use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use tauri::{Manager, Runtime, Webview, WebviewWindow, Window};

use crate::BridgeState;

/// Windows learned from the plugin's `on_webview_ready` hook, keyed by window
/// label. `Manager::webview_windows()` only returns windows whose every
/// webview shares the window's label, so a window that gains a child webview
/// (`Window::add_child`, e.g. a live web view) silently drops out of it — and
/// out of `get_webview_window()`. The registry keeps a `Window` handle for
/// every window that ever hosted a webview; live webviews are enumerated from
/// the handle at request time, so closed children disappear automatically.
pub type WindowRegistry<R> = Arc<Mutex<HashMap<String, Window<R>>>>;

/// A single addressable webview: a real `Webview` handle (from the registry —
/// covers child webviews) or a `WebviewWindow` (from `webview_windows()` —
/// covers windows created before the plugin registered, which the registry
/// never saw).
pub enum Target<R: Runtime> {
    Webview(Webview<R>),
    WebviewWindow(WebviewWindow<R>),
}

impl<R: Runtime> Target<R> {
    pub fn label(&self) -> String {
        match self {
            Target::Webview(w) => w.label().to_string(),
            Target::WebviewWindow(w) => w.label().to_string(),
        }
    }

    /// Inject JS via Tauri's `Webview::eval`. Arbitrary-code execution is this
    /// dev-only plugin's purpose; access is gated by the per-session auth token.
    pub fn eval(&self, js: &str) -> tauri::Result<()> {
        match self {
            Target::Webview(w) => w.eval(js),
            Target::WebviewWindow(w) => w.eval(js),
        }
    }

    pub fn url(&self) -> Option<String> {
        match self {
            Target::Webview(w) => w.url().ok().map(|u| u.to_string()),
            Target::WebviewWindow(w) => w.url().ok().map(|u| u.to_string()),
        }
    }

    #[cfg(any())] // Berth vendored：CEF 下不是 WKWebView，原生分支停用，见 VENDORED.md
    pub fn with_webview<F: FnOnce(tauri::webview::PlatformWebview) + Send + 'static>(
        &self,
        f: F,
    ) -> tauri::Result<()> {
        match self {
            Target::Webview(w) => w.with_webview(f),
            Target::WebviewWindow(w) => w.with_webview(f),
        }
    }
}

/// A window and its addressable webviews. The webview whose label matches the
/// window label (the primary content webview) sorts first.
pub struct WindowEntry<R: Runtime> {
    pub label: String,
    pub title: Option<String>,
    pub visible: bool,
    pub focused: bool,
    pub targets: Vec<Target<R>>,
}

/// Enumerate every window and its live webviews: registry windows first
/// (covers multiwebview windows), then `webview_windows()` for windows the
/// registry hasn't seen. Sorted by label for stable output.
pub fn list_windows<R: Runtime>(state: &BridgeState<R>) -> Vec<WindowEntry<R>> {
    let mut entries: Vec<WindowEntry<R>> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let windows: Vec<Window<R>> = state.windows.lock().unwrap().values().cloned().collect();
    for window in windows {
        // A destroyed window that missed its prune has no live webviews.
        let mut webviews = window.webviews();
        if webviews.is_empty() {
            continue;
        }
        // `webviews()` iterates a HashMap — order it: primary first, then by label.
        webviews.sort_by_key(|w| (w.label() != window.label(), w.label().to_string()));
        seen.insert(window.label().to_string());
        entries.push(WindowEntry {
            label: window.label().to_string(),
            title: window.title().ok(),
            visible: window.is_visible().unwrap_or(false),
            focused: window.is_focused().unwrap_or(false),
            targets: webviews.into_iter().map(Target::Webview).collect(),
        });
    }

    for (label, window) in state.app.webview_windows() {
        if seen.contains(&label) {
            continue;
        }
        entries.push(WindowEntry {
            label: label.clone(),
            title: window.title().ok(),
            visible: window.is_visible().unwrap_or(false),
            focused: window.is_focused().unwrap_or(false),
            targets: vec![Target::WebviewWindow(window)],
        });
    }

    entries.sort_by(|a, b| a.label.cmp(&b.label));
    entries
}

/// Register a window in the registry. Called from `on_webview_ready` — child
/// webviews re-register their (already known) window, which is a no-op.
pub fn register_window<R: Runtime>(registry: &WindowRegistry<R>, webview: &Webview<R>) {
    let window = webview.window();
    registry
        .lock()
        .unwrap()
        .insert(window.label().to_string(), window);
}

/// Resolve a webview target by label. Defaults to "main".
pub fn resolve_target<R: Runtime>(
    state: &BridgeState<R>,
    label: Option<&str>,
) -> Result<Target<R>, (StatusCode, String)> {
    let requested = label.unwrap_or("main");
    let mut entries = list_windows(state);
    let shape: Vec<(String, Vec<String>)> = entries
        .iter()
        .map(|e| {
            (
                e.label.clone(),
                e.targets.iter().map(Target::label).collect(),
            )
        })
        .collect();
    match resolve_indices(&shape, requested) {
        Ok((wi, vi)) => Ok(entries.swap_remove(wi).targets.swap_remove(vi)),
        Err(msg) => Err((StatusCode::NOT_FOUND, msg)),
    }
}

/// Pure label resolution over (window label, webview labels) pairs, returning
/// (window index, webview index). Precedence: exact webview label anywhere →
/// "window/webview" compound form → the sole webview of the named window.
fn resolve_indices(
    windows: &[(String, Vec<String>)],
    requested: &str,
) -> Result<(usize, usize), String> {
    for (wi, (_, webviews)) in windows.iter().enumerate() {
        if let Some(vi) = webviews.iter().position(|v| v == requested) {
            return Ok((wi, vi));
        }
    }
    if let Some((win, view)) = requested.split_once('/')
        && let Some(wi) = windows.iter().position(|(w, _)| w == win)
        && let Some(vi) = windows[wi].1.iter().position(|v| v == view)
    {
        return Ok((wi, vi));
    }
    if let Some(wi) = windows.iter().position(|(w, _)| w == requested)
        && windows[wi].1.len() == 1
    {
        return Ok((wi, 0));
    }

    let available = addressable(windows);
    Err(if available.is_empty() {
        format!("webview '{requested}' not found — no webviews are open")
    } else {
        format!(
            "webview '{requested}' not found — available: {}",
            available.join(", ")
        )
    })
}

/// Human-facing list of addressable targets: bare labels for primary webviews,
/// "window/webview" for children.
fn addressable(windows: &[(String, Vec<String>)]) -> Vec<String> {
    let mut out = Vec::new();
    for (window, webviews) in windows {
        for webview in webviews {
            if webview == window {
                out.push(webview.clone());
            } else {
                out.push(format!("{window}/{webview}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(pairs: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
        pairs
            .iter()
            .map(|(w, vs)| {
                (
                    w.to_string(),
                    vs.iter().map(|v| v.to_string()).collect::<Vec<_>>(),
                )
            })
            .collect()
    }

    #[test]
    fn resolves_plain_window() {
        let windows = shape(&[("main", &["main"])]);
        assert_eq!(resolve_indices(&windows, "main"), Ok((0, 0)));
    }

    #[test]
    fn resolves_primary_webview_in_multiwebview_window() {
        // The Alchemy live-view shape: window "main" with a child webview.
        let windows = shape(&[("main", &["main", "live-main"])]);
        assert_eq!(resolve_indices(&windows, "main"), Ok((0, 0)));
    }

    #[test]
    fn resolves_child_webview_by_bare_label() {
        let windows = shape(&[("main", &["main", "live-main"])]);
        assert_eq!(resolve_indices(&windows, "live-main"), Ok((0, 1)));
    }

    #[test]
    fn resolves_child_webview_by_compound_label() {
        let windows = shape(&[("main", &["main", "live-main"])]);
        assert_eq!(resolve_indices(&windows, "main/live-main"), Ok((0, 1)));
    }

    #[test]
    fn exact_webview_label_wins_over_compound_parse() {
        // A webview literally labeled "a/b" is matched before splitting.
        let windows = shape(&[("a", &["a", "b"]), ("x", &["a/b"])]);
        assert_eq!(resolve_indices(&windows, "a/b"), Ok((1, 0)));
    }

    #[test]
    fn window_label_falls_back_to_sole_webview() {
        // Window whose only webview has a different label.
        let windows = shape(&[("main", &["content"])]);
        assert_eq!(resolve_indices(&windows, "main"), Ok((0, 0)));
    }

    #[test]
    fn ambiguous_window_label_errors_with_targets() {
        let windows = shape(&[("tools", &["left", "right"])]);
        let err = resolve_indices(&windows, "tools").unwrap_err();
        assert!(
            err.contains("tools/left"),
            "error should list targets: {err}"
        );
        assert!(err.contains("tools/right"));
    }

    #[test]
    fn missing_label_lists_available_targets() {
        let windows = shape(&[("main", &["main", "live-main"])]);
        let err = resolve_indices(&windows, "nope").unwrap_err();
        assert!(err.contains("main"), "{err}");
        assert!(err.contains("main/live-main"), "{err}");
    }

    #[test]
    fn no_webviews_message() {
        let err = resolve_indices(&[], "main").unwrap_err();
        assert!(err.contains("no webviews are open"), "{err}");
    }
}
