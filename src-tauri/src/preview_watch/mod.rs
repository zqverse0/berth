//! Long-lived file preview servers provided by plugins (`org.berth.preview`,
//! protocol `watch/1`, see `docs/contribution-points.md`).
//!
//! One provider child process per previewed file, shared across preview tabs
//! by ref-count, reaped on tab-close / folder-removal / app-exit / plugin
//! disable.
//!
//! A long-lived server (rather than re-rendering on every change) keeps one
//! process owning the file while an agent edits it through the same tool, so
//! the preview never re-reads and locks the file mid-edit (on Windows that made
//! the agent's write fail with "file is in use").
//!
//! ## Concurrency model (mirrors `workspace_state::WORKSPACE_STREAMS`)
//!
//! A process-level `static` registry keyed by the file's canonical path,
//! with ref-count sharing. Not on `AppState`: the pool holds only OS resources
//! (child handles + ports) so it needs no DB/emitter injection.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::TcpStream;
use tokio::process::Child;

use crate::app_error::AppCommandError;
use crate::commands::path_guard::resolve_tree_path;
use crate::commands::preview_tools::resolve_bin;
use crate::platform::process::tokio_command;
use berth_tool_core::file_tools::{self, FileTool};

// ─── Tunables ───────────────────────────────────────────────────────────

/// Upper bound on how long we wait for a freshly-spawned watch server to
/// announce readiness (its `Watch: http://…:<port>` stdout line) before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Per-attempt TCP connect timeout for the post-announce reachability confirm.
const READY_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// Hard cap on concurrent watch processes — a backstop against a pathological
/// burst of tab-opens spawning unbounded preview processes.
const MAX_CONCURRENT_WATCHES: usize = 32;

/// Default idle threshold for the sweep (5 minutes). Override via
/// `BERTH_PREVIEW_WATCH_IDLE_TIMEOUT_SECS`; `0` disables the sweep.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 300;
/// Sweep cadence — once per minute, like the ACP idle sweep.
pub const SWEEP_INTERVAL_SECS: u64 = 60;

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    /// 提供预览的插件声明了程序，但本机找不到（带插件名，前端安装提示用）。
    #[error("{0} is not installed")]
    NotInstalled(String),
    #[error("no enabled plugin previews this file type")]
    NoProvider,
    #[error("unsupported preview protocol: {0}")]
    Protocol(String),
    #[error("path is outside the workspace root")]
    OutsideRoot,
    #[error("failed to start the preview server: {0}")]
    StartFailed(String),
    #[error("the preview server did not become ready in time: {0}")]
    PortTimeout(String),
    #[error("no free port available for the preview server")]
    NoPort,
    #[error("too many preview servers are already running")]
    TooMany,
    #[error("io error: {0}")]
    Io(String),
}

impl WatchError {
    /// Stable machine code the frontend switches on to render the right
    /// degraded UI (install guide vs. retry). Carried into `AppCommandError`
    /// via `i18n_params` at the command boundary.
    pub fn code(&self) -> &'static str {
        match self {
            WatchError::NotInstalled(_) => "NOT_INSTALLED",
            WatchError::NoProvider => "NO_PROVIDER",
            WatchError::Protocol(_) => "PROTOCOL",
            WatchError::OutsideRoot => "OUTSIDE_ROOT",
            WatchError::StartFailed(_) => "START_FAILED",
            WatchError::PortTimeout(_) => "PORT_TIMEOUT",
            WatchError::NoPort => "NO_PORT",
            WatchError::TooMany => "TOO_MANY",
            WatchError::Io(_) => "IO",
        }
    }
}

impl From<std::io::Error> for WatchError {
    fn from(err: std::io::Error) -> Self {
        WatchError::Io(err.to_string())
    }
}

impl From<WatchError> for AppCommandError {
    /// Carry the stable `code()` into `i18n_params.watchCode` so the frontend
    /// can branch on it (install guide vs. retry) without substring-matching
    /// the English message.
    fn from(err: WatchError) -> Self {
        let mut params = BTreeMap::from([("watchCode".to_string(), err.code().to_string())]);
        if let WatchError::NotInstalled(tool) = &err {
            params.insert("tool".to_string(), tool.clone());
        }
        let base = match &err {
            WatchError::NotInstalled(_) => AppCommandError::dependency_missing(err.to_string()),
            WatchError::NoProvider | WatchError::OutsideRoot => {
                AppCommandError::invalid_input(err.to_string())
            }
            _ => AppCommandError::task_execution_failed(err.to_string()),
        };
        base.with_i18n("Folder.fileWorkspacePanel.previewWatchError", params)
    }
}

/// Returned by `start_preview_watch_core` — the loopback port the watch HTTP
/// server is listening on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWatchStarted {
    pub port: u16,
    /// 服务端预取的首版预览 HTML（GET loopback 一次）。桌面端把 watch 从
    /// 「可见 WebView 加载 loopback」改为「沙箱 srcdoc 显示快照」后，第一帧
    /// 不再需要前端自行抓取；后续刷新走 `preview_watch_refresh_html_core`。
    #[serde(default)]
    pub html: Option<String>,
    /// Latest provider marks for this watch (as pushed by `watch mark`), so a
    /// remounting preview restores them; filled by the desktop command.
    #[serde(default)]
    pub marks: Option<serde_json::Value>,
    /// 提供者插件声明的预览脚本（`org.berth.preview.script`），前端注入 iframe。
    #[serde(default)]
    pub script: Option<String>,
}

// ─── Process-pool state ─────────────────────────────────────────────────

struct WatchInstance {
    child: Child,
    port: u16,
    file_canonical: PathBuf,
    ref_count: usize,
    last_activity: Instant,
}

/// File-canonical-path → live watch process. Short critical sections only.
static PREVIEW_WATCHES: LazyLock<Mutex<HashMap<String, WatchInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per-key async lock serializing concurrent starts for the same file, so two
/// tabs opening the same file in one tick can't each spawn a process. Held
/// across the async ready wait, hence a `tokio::sync::Mutex`. Entries are pruned
/// after a spawn so the map can't grow unbounded over a long server's lifetime.
static SPAWN_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_watches() -> MutexGuard<'static, HashMap<String, WatchInstance>> {
    PREVIEW_WATCHES.lock().unwrap_or_else(|p| p.into_inner())
}

/// Reap a child without blocking the caller: kill + `wait()` on a detached task
/// so no zombie lingers. Falls back to `start_kill` (relying on `kill_on_drop`
/// + tokio's orphan reaper) when called outside a runtime, e.g. at shutdown.
fn reap(mut child: Child) {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(async move {
                let _ = child.kill().await;
            });
        }
        Err(_) => {
            let _ = child.start_kill();
        }
    }
}

fn spawn_lock_for(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    SPAWN_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

// ─── Path handling ──────────────────────────────────────────────────────

/// Canonical registry key for a file. Case-folded on Windows so the same file
/// referenced with different casing collapses to one watch.
fn watch_key(canonical: &Path) -> String {
    let s = canonical.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// 预览协议：插件声明的 `org.berth.preview.protocol`，宿主只实现这一种。
const PREVIEW_PROTOCOL: &str = "watch/1";

/// 启用插件里预览这类文件的提供者。
fn preview_provider(path: &Path) -> Result<FileTool, WatchError> {
    let tool = file_tools::provider_for(file_tools::PREVIEW, path).ok_or(WatchError::NoProvider)?;
    match tool.protocol.as_deref() {
        Some(PREVIEW_PROTOCOL) => Ok(tool),
        other => Err(WatchError::Protocol(other.unwrap_or("none").to_string())),
    }
}

/// Resolve `rel_path` against `root_path`, canonicalize and confine to the root
/// (so a tab path can never escape the workspace). Which plugin previews the
/// file is decided at spawn (`preview_provider`).
fn resolve_preview_target(root_path: &str, rel_path: &str) -> Result<PathBuf, WatchError> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err(WatchError::Io("workspace root does not exist".to_string()));
    }
    let target = resolve_tree_path(&root, rel_path).map_err(|e| WatchError::Io(e.to_string()))?;
    let canonical_root = std::fs::canonicalize(&root)?;
    let canonical_target = std::fs::canonicalize(&target)?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(WatchError::OutsideRoot);
    }
    if !canonical_target.is_file() {
        return Err(WatchError::Io("path is not a file".to_string()));
    }
    Ok(canonical_target)
}

/// Best-effort key for `stop` — falls back to a loose canonicalization so a
/// since-deleted file can still be released by key.
fn loose_key(root_path: &str, rel_path: &str) -> Option<String> {
    if let Ok(canonical) = resolve_preview_target(root_path, rel_path) {
        return Some(watch_key(&canonical));
    }
    let root = PathBuf::from(root_path);
    let target = resolve_tree_path(&root, rel_path).ok()?;
    let canonical = std::fs::canonicalize(&target).unwrap_or(target);
    Some(watch_key(&canonical))
}

// ─── Spawn / readiness ──────────────────────────────────────────────────

/// Ask the OS for a free loopback port by binding to `:0` then releasing it.
/// There's an inherent (microsecond) TOCTOU window before the provider binds it;
/// the readiness probe catches the rare loss as `PortTimeout`/`StartFailed`.
fn allocate_free_port() -> Result<u16, WatchError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| WatchError::NoPort)?;
    let port = listener
        .local_addr()
        .map_err(|_| WatchError::NoPort)?
        .port();
    drop(listener);
    Ok(port)
}

/// Parse the provider's readiness line, e.g. `Watch: http://localhost:26411`, into
/// the port it actually bound. Returns `None` for any other stdout line.
fn parse_watch_port(line: &str) -> Option<u16> {
    let line = line.trim_start();
    if !line.starts_with("Watch:") {
        return None;
    }
    // Take the run of digits immediately after the last ':' (tolerates an
    // optional trailing path like `…:26411/`).
    let after = line.rsplit(':').next()?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

/// Wait for the freshly-spawned watch to announce readiness on stdout, then
/// confirm it's reachable. Reading *our child's own stdout* for the
/// `Watch: http://…:<port>` line positively identifies the listener as this
/// the provider — closing the gap where the bind-to-`:0`-then-release port could
/// be snatched by another process between release and the provider binding it
/// (a TCP-accept probe alone can't tell whose listener answered). On success
/// the stdout reader is handed to a background drain so a chatty watch can't
/// dead-lock on a full pipe.
async fn await_ready(port: u16, child: &mut Child) -> Result<(), WatchError> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WatchError::StartFailed("no stdout pipe".to_string()))?;
    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + READY_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WatchError::PortTimeout(
                "the preview server did not announce readiness in time".to_string(),
            ));
        }
        match tokio::time::timeout(remaining, lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let Some(bound) = parse_watch_port(&line) else {
                    continue; // a non-readiness line (Watching:, Press Ctrl+C, …)
                };
                if bound != port {
                    return Err(WatchError::PortTimeout(format!(
                        "the preview server bound port {bound}, expected {port}"
                    )));
                }
                // Confirm the announced server actually accepts a connection.
                if tokio::time::timeout(
                    READY_CONNECT_TIMEOUT,
                    TcpStream::connect(("127.0.0.1", port)),
                )
                .await
                .map(|r| r.is_ok())
                .unwrap_or(false)
                {
                    // Keep the pipe drained for the child's lifetime.
                    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
                    return Ok(());
                }
                return Err(WatchError::PortTimeout(
                    "the preview server announced ready but the port did not accept".to_string(),
                ));
            }
            Ok(Ok(None)) => {
                return Err(WatchError::StartFailed(
                    "the preview server exited before announcing readiness".to_string(),
                ));
            }
            Ok(Err(e)) => return Err(WatchError::StartFailed(e.to_string())),
            Err(_) => {
                return Err(WatchError::PortTimeout(
                    "the preview server did not announce readiness in time".to_string(),
                ));
            }
        }
    }
}

/// Drain a killed child's stderr (best-effort, time-boxed) for diagnostics.
async fn drain_stderr(child: &mut Child) -> String {
    use tokio::io::AsyncReadExt;
    let Some(mut err) = child.stderr.take() else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_millis(500), err.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf).trim().to_string()
}

// ─── Public API: start / stop / introspection ───────────────────────────

/// Ensure a watch server is running for `path` (relative to `root_path`) and
/// return its loopback port. Shares an existing process by ref-count; only
/// spawns when none is live.
pub async fn start_preview_watch_core(
    root_path: String,
    path: String,
) -> Result<PreviewWatchStarted, WatchError> {
    let canonical_target = resolve_preview_target(&root_path, &path)?;
    let key = watch_key(&canonical_target);

    // 插件停用后不再复用它启动的旧进程：先确认仍有启用的提供者。
    let tool = match preview_provider(&canonical_target) {
        Ok(tool) => tool,
        Err(err) => {
            if let Some(entry) = lock_watches().remove(&key) {
                reap(entry.child);
            }
            return Err(err);
        }
    };

    // Fast path: a live process already exists → just share it. This path
    // intentionally does not need the preview binary on disk.
    if let Some(port) = reuse_live(&key) {
        return finish_started(
            &tool,
            PreviewWatchStarted {
                port,
                html: None,
                marks: None,
                script: None,
            },
        )
        .await;
    }

    // Slow path: serialize same-file spawns, then double-check. The per-key
    // entry stays in `SPAWN_LOCKS` for as long as any task references it (so
    // serialization is never broken mid-spawn); the idle sweep prunes entries no
    // task holds (`Arc::strong_count == 1`), bounding the map's growth.
    let spawn_lock = spawn_lock_for(&key);
    let _guard = spawn_lock.lock().await;
    if let Some(port) = reuse_live(&key) {
        return finish_started(
            &tool,
            PreviewWatchStarted {
                port,
                html: None,
                marks: None,
                script: None,
            },
        )
        .await;
    }
    if lock_watches().len() >= MAX_CONCURRENT_WATCHES {
        return Err(WatchError::TooMany);
    }

    let program =
        resolve_bin(&tool.install).ok_or_else(|| WatchError::NotInstalled(tool.name.clone()))?;
    let port = allocate_free_port()?;
    let file = canonical_target.to_string_lossy();
    let port_arg = port.to_string();
    let mut child = tokio_command(&program)
        .args(file_tools::expand_argv(
            &tool.argv,
            &[("file", &file), ("port", &port_arg)],
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| WatchError::StartFailed(format!("{}: {e}", tool.name)))?;

    if let Err(ready_err) = await_ready(port, &mut child).await {
        let _ = child.start_kill();
        let stderr = drain_stderr(&mut child).await;
        let detail = match (ready_err.to_string(), stderr.as_str()) {
            (msg, "") => format!("{}: {msg}", tool.name),
            (msg, err) => format!("{}: {msg} — {err}", tool.name),
        };
        reap(child);
        return Err(match ready_err {
            WatchError::PortTimeout(_) => WatchError::PortTimeout(detail),
            _ => WatchError::StartFailed(detail),
        });
    }

    // Register. Re-check after the async gap: another task may have won the
    // race for this file while we were waiting — if so, adopt theirs and
    // reap ours.
    // 结构约束：`watches` guard 不能跨 `.await`（Send）。先在锁内决出结果
    // （同步分支直接返回；adopt 分支把 winner 数据拷出、锁外再 reap child），
    // 让 guard 在块结束处统一析构，await 全部落在锁外。
    let adopted: Result<PreviewWatchStarted, WatchError> = {
        let mut watches = lock_watches();
        if let Some(entry) = watches.get_mut(&key) {
            if matches!(entry.child.try_wait(), Ok(None)) {
                entry.ref_count += 1;
                entry.last_activity = Instant::now();
                let port = entry.port;
                drop(watches);
                reap(child);
                Ok(PreviewWatchStarted {
                    port,
                    html: None,
                    marks: None,
                    script: None,
                })
            } else {
                // A dead entry squats the key — replace it below.
                watches.remove(&key);
                register_new(watches, key.clone(), child, port, canonical_target)
            }
        } else if watches.len() >= MAX_CONCURRENT_WATCHES {
            // Enforce the cap atomically under the pool lock — per-file spawn
            // locks don't serialize *across different files*, so the early
            // pre-spawn check can be raced past by concurrent first-opens.
            drop(watches);
            reap(child);
            Err(WatchError::TooMany)
        } else {
            register_new(watches, key.clone(), child, port, canonical_target)
        }
    };
    finish_started(&tool, adopted?).await
}

/// Stamp the first preview snapshot onto a watch-start result. Best-effort: a
/// transient GET failure leaves `html: None` and the frontend falls back to its
/// own fetch — the watch itself is already healthy. Also attaches the plugin's
/// preview script.
async fn finish_started(
    tool: &FileTool,
    mut started: PreviewWatchStarted,
) -> Result<PreviewWatchStarted, WatchError> {
    if let Ok(html) = preview_watch_html_core(started.port).await {
        started.html = Some(html);
    }
    started.script = tool.script.as_ref().and_then(|path| {
        std::fs::read_to_string(path)
            .inspect_err(|e| {
                tracing::warn!("[preview-watch] preview script {}: {e}", path.display())
            })
            .ok()
    });
    Ok(started)
}

/// Insert a fresh watch under `key` while holding the pool lock. Factored out so
/// the register path has a single construction site for `WatchInstance`.
fn register_new(
    mut watches: MutexGuard<'static, HashMap<String, WatchInstance>>,
    key: String,
    child: Child,
    port: u16,
    file_canonical: PathBuf,
) -> Result<PreviewWatchStarted, WatchError> {
    watches.insert(
        key,
        WatchInstance {
            child,
            port,
            file_canonical,
            ref_count: 1,
            last_activity: Instant::now(),
        },
    );
    Ok(PreviewWatchStarted {
        port,
        html: None,
        marks: None,
        script: None,
    })
}

/// Fast-path helper: if a live watch exists for `key`, bump its ref-count and
/// return its port; if the entry is dead, reap + prune it so the slow path
/// respawns.
fn reuse_live(key: &str) -> Option<u16> {
    let mut watches = lock_watches();
    let entry = watches.get_mut(key)?;
    match entry.child.try_wait() {
        Ok(None) => {
            entry.ref_count += 1;
            entry.last_activity = Instant::now();
            Some(entry.port)
        }
        _ => {
            // Dead or errored — prune so the slow path respawns.
            if let Some(dead) = watches.remove(key) {
                reap(dead.child);
            }
            None
        }
    }
}

/// Release one reference to the watch for `path`. Kills the process when the
/// last reference goes away. Idempotent (closing an already-stopped tab is OK).
pub async fn stop_preview_watch_core(root_path: String, path: String) -> Result<(), WatchError> {
    let Some(key) = loose_key(&root_path, &path) else {
        return Ok(());
    };

    let mut watches = lock_watches();
    let target_key = if watches.contains_key(&key) {
        Some(key)
    } else {
        // Fallback: a since-moved file may key differently; match by canonical.
        watches
            .iter()
            .find_map(|(k, entry)| (watch_key(&entry.file_canonical) == key).then(|| k.clone()))
    };
    let Some(target_key) = target_key else {
        return Ok(());
    };

    if let Some(entry) = watches.get_mut(&target_key) {
        if entry.ref_count > 1 {
            entry.ref_count -= 1;
            return Ok(());
        }
    }
    if let Some(entry) = watches.remove(&target_key) {
        drop(watches);
        reap(entry.child);
    }
    Ok(())
}

// ─── Update push (provider SSE → app event) ────────────────────────────

/// Desktop event: the provider pushed something for the watch on `port`.
/// Payload `{ port, kind }` with `kind`:
/// - `content` — the document changed. Edits land in the watch's
///   in-memory document immediately while the disk flush lags (resident
///   auto-flush, 2–10s), so file events alone refresh the preview late.
/// - `marks` (+ `marks`) — full mark list (`mark-update`).
/// - `scroll` (+ `target`, an HTML anchor).
pub const PREVIEW_WATCH_UPDATE_EVENT: &str = "app://preview-watch-update";

/// Ports with a live update pump — one SSE subscriber per watch process.
static UPDATE_PUMPS: LazyLock<Mutex<HashSet<u16>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Last mark list per watch port, for previews that (re)mount later.
static LAST_MARKS: LazyLock<Mutex<HashMap<u16, serde_json::Value>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn last_marks(port: u16) -> Option<serde_json::Value> {
    LAST_MARKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&port)
        .cloned()
}

/// Subscribe once to the watch's own `/events` stream and forward pushes as
/// [`PREVIEW_WATCH_UPDATE_EVENT`]. The task ends with the stream, i.e. when the
/// watch process goes away; a later watch on the same port gets a fresh pump.
pub fn ensure_update_pump(port: u16, emitter: crate::event_bridge::EventEmitter) {
    let fresh = UPDATE_PUMPS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(port);
    if !fresh {
        return;
    }
    tokio::spawn(async move {
        let _ = pump_updates(port, &emitter).await;
        // 推送流结束 = 预览进程退出（停用回收、崩溃）：让仍打开的标签重启预览。
        crate::event_bridge::emit_event(
            &emitter,
            PREVIEW_WATCH_UPDATE_EVENT,
            serde_json::json!({ "port": port, "kind": "closed" }),
        );
        UPDATE_PUMPS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&port);
        LAST_MARKS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&port);
    });
}

async fn pump_updates(
    port: u16,
    emitter: &crate::event_bridge::EventEmitter,
) -> Result<(), reqwest::Error> {
    let mut response = reqwest::get(format!("http://127.0.0.1:{port}/events")).await?;
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.windows(2).position(|w| w == b"\n\n") {
            let event: Vec<u8> = buffer.drain(..end + 2).collect();
            let payload = match classify_push(&String::from_utf8_lossy(&event)) {
                Some(WatchPush::Content) => serde_json::json!({ "port": port, "kind": "content" }),
                Some(WatchPush::Marks(marks)) => {
                    LAST_MARKS
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .insert(port, marks.clone());
                    serde_json::json!({ "port": port, "kind": "marks", "marks": marks })
                }
                Some(WatchPush::Scroll(target)) => {
                    serde_json::json!({ "port": port, "kind": "scroll", "target": target })
                }
                None => continue,
            };
            crate::event_bridge::emit_event(emitter, PREVIEW_WATCH_UPDATE_EVENT, payload);
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum WatchPush {
    Content,
    Marks(serde_json::Value),
    Scroll(String),
}

/// watch/1 providers send every viewer push as `event: update` with a JSON `action`:
/// `replace`/… (content), `mark-update`, `scroll`, and `selection-update`
/// (its own viewer's selection — irrelevant to Berth's preview).
fn classify_push(event: &str) -> Option<WatchPush> {
    if !event.lines().any(|line| line.trim_end() == "event: update") {
        return None;
    }
    let data = event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    let value: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
    match value.get("action").and_then(serde_json::Value::as_str) {
        Some("selection-update") => None,
        Some("mark-update") => Some(WatchPush::Marks(
            value
                .get("marks")
                .filter(|marks| marks.is_array())
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        )),
        Some("scroll") => value
            .get("scrollTo")
            .and_then(serde_json::Value::as_str)
            .map(|target| WatchPush::Scroll(target.to_string())),
        _ => Some(WatchPush::Content),
    }
}

/// Fetch the watch server's current preview HTML (server-side GET, so the
/// frontend never needs CSP/CORS exceptions for the loopback origin). The
/// snapshot is re-fetched on every call — the caller drives refresh timing
/// (watch SSE / file events), mirroring how the visible WebView refreshed.
pub async fn preview_watch_html_core(port: u16) -> Result<String, WatchError> {
    let url = format!("http://127.0.0.1:{port}/");
    let response = reqwest::get(&url)
        .await
        .map_err(|e| WatchError::StartFailed(format!("watch snapshot request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(WatchError::StartFailed(format!(
            "watch snapshot returned {}",
            response.status()
        )));
    }
    let html = response
        .text()
        .await
        .map_err(|e| WatchError::StartFailed(format!("watch snapshot read failed: {e}")))?;
    if html.trim().is_empty() {
        return Err(WatchError::StartFailed(
            "watch snapshot produced empty output".to_string(),
        ));
    }
    Ok(html)
}

/// Kill every watch process. Used on app/window/server shutdown.
pub fn stop_all_preview_watches() -> usize {
    let drained: Vec<(String, WatchInstance)> = lock_watches().drain().collect();
    let n = drained.len();
    for (_, entry) in drained {
        reap(entry.child);
    }
    n
}

/// Kill every watch whose file lives under `root_path`. Used when a folder is
/// removed from the workspace (belt-and-suspenders over per-tab unmount).
pub fn stop_preview_watches_under_root(root_path: &str) -> usize {
    let root = PathBuf::from(root_path);
    let root_canonical = std::fs::canonicalize(&root).unwrap_or(root);

    let mut watches = lock_watches();
    let keys: Vec<String> = watches
        .iter()
        .filter(|(_, e)| e.file_canonical.starts_with(&root_canonical))
        .map(|(k, _)| k.clone())
        .collect();

    let mut removed = Vec::with_capacity(keys.len());
    for k in &keys {
        if let Some(entry) = watches.remove(k) {
            removed.push(entry);
        }
    }
    drop(watches);

    let n = removed.len();
    for entry in removed {
        reap(entry.child);
    }
    n
}

// ─── Idle / dead-child sweep ─────────────────────────────────────────────

/// Read the idle timeout from `BERTH_PREVIEW_WATCH_IDLE_TIMEOUT_SECS`. `0`
/// disables the sweep; unparseable falls back to the default.
pub fn idle_timeout_from_env() -> Option<Duration> {
    let secs = match crate::platform::paths::env_var("PREVIEW_WATCH_IDLE_TIMEOUT_SECS") {
        Some(raw) => raw.parse::<u64>().unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS),
        None => DEFAULT_IDLE_TIMEOUT_SECS,
    };
    (secs != 0).then(|| Duration::from_secs(secs))
}

/// 结束提供者已停用（或不再声明该后缀）的预览进程。设置页停用插件时立即调用；
/// CLI 停用由下一轮 sweep 兜底。前端收到 `closed` 推送后重启预览，得到 `NO_PROVIDER`。
pub fn stop_watches_without_provider() -> usize {
    let mut watches = lock_watches();
    let keys: Vec<String> = watches
        .iter()
        .filter(|(_, entry)| preview_provider(&entry.file_canonical).is_err())
        .map(|(key, _)| key.clone())
        .collect();
    let children: Vec<Child> = keys
        .iter()
        .filter_map(|key| watches.remove(key))
        .map(|entry| entry.child)
        .collect();
    drop(watches);
    let n = children.len();
    for child in children {
        reap(child);
    }
    n
}

/// Reap watches that are no longer needed:
/// - **dead children** (a crashed watch must not linger);
/// - **stragglers** — `ref_count == 0` (the tab stopped it) past the idle
///   window. A *live* preview (`ref_count >= 1`) is never swept: it talks to
///   loopback directly so nothing bumps `last_activity`, and reaping it by idle
///   would yank it from under the user.
pub fn sweep_preview_watches(idle_timeout: Duration) -> usize {
    let now = Instant::now();
    let mut watches = lock_watches();
    // First pass (needs `&mut` for `try_wait`): collect the keys to reap.
    let keys: Vec<String> = watches
        .iter_mut()
        .filter_map(|(k, entry)| {
            let idle = now.duration_since(entry.last_activity);
            let dead = matches!(entry.child.try_wait(), Ok(Some(_)));
            let straggler = entry.ref_count == 0 && idle > idle_timeout;
            (dead || straggler).then(|| k.clone())
        })
        .collect();
    let mut children: Vec<Child> = Vec::with_capacity(keys.len());
    for k in &keys {
        if let Some(entry) = watches.remove(k) {
            children.push(entry.child);
        }
    }
    drop(watches);
    let n = children.len();
    for child in children {
        reap(child);
    }

    // Prune spawn-lock entries no in-flight start references. `strong_count == 1`
    // means only the map holds the `Arc` (every active/waiting start holds its
    // own clone), so removing it can't strand a waiter or break per-key
    // serialization — bounding the map's growth over a long server's lifetime.
    SPAWN_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|_, arc| Arc::strong_count(arc) > 1);

    n
}

/// Long-running sweep task, spawned once per binary (desktop + server). Never
/// exits on its own; the process dying cleans everything up (plus kill_on_drop).
pub async fn preview_idle_sweep_task(idle_timeout: Duration, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First tick is immediate — skip it so we don't sweep before any watch settles.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let n = sweep_preview_watches(idle_timeout) + stop_watches_without_provider();
        if n > 0 {
            tracing::info!("[preview-watch] idle sweep reaped {n} watch process(es)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_watch_pushes() {
        assert_eq!(
            classify_push("event: update\ndata: {\"action\":\"replace\",\"slide\":1}\n\n"),
            Some(WatchPush::Content)
        );
        assert_eq!(
            classify_push(
                "event: update\ndata: {\"action\":\"selection-update\",\"paths\":[]}\n\n"
            ),
            None
        );
        assert_eq!(
            classify_push(
                "event: update\ndata: {\"action\":\"mark-update\",\"version\":1,\"marks\":[{\"id\":\"1\",\"path\":\"/body/p[1]\"}]}\n\n"
            ),
            Some(WatchPush::Marks(serde_json::json!([{ "id": "1", "path": "/body/p[1]" }])))
        );
        assert_eq!(
            classify_push(
                "event: update\ndata: {\"action\":\"scroll\",\"scrollTo\":\"#w-p-40\"}\n\n"
            ),
            Some(WatchPush::Scroll("#w-p-40".into()))
        );
        assert_eq!(classify_push(": keepalive\n\n"), None);
    }

    #[test]
    fn error_code_mapping_is_stable() {
        assert_eq!(WatchError::NotInstalled("X".into()).code(), "NOT_INSTALLED");
        assert_eq!(WatchError::NoProvider.code(), "NO_PROVIDER");
        assert_eq!(WatchError::OutsideRoot.code(), "OUTSIDE_ROOT");
        assert_eq!(WatchError::StartFailed("x".into()).code(), "START_FAILED");
        assert_eq!(WatchError::PortTimeout("x".into()).code(), "PORT_TIMEOUT");
        assert_eq!(WatchError::NoPort.code(), "NO_PORT");
        assert_eq!(WatchError::TooMany.code(), "TOO_MANY");
        assert_eq!(WatchError::Io("x".into()).code(), "IO");
    }

    #[test]
    fn watch_key_folds_and_normalizes() {
        // Slashes are normalized; case-folding only on Windows.
        let p = PathBuf::from("/Users/a/Reports/Q1.docx");
        let key = watch_key(&p);
        if cfg!(windows) {
            assert_eq!(key, "/users/a/reports/q1.docx");
        } else {
            assert_eq!(key, "/Users/a/Reports/Q1.docx");
        }
    }

    #[test]
    fn allocate_free_port_is_actually_free() {
        let port = allocate_free_port().expect("should allocate");
        assert!(port > 0);
        // We released it, so we can immediately bind it again.
        let again = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(again.is_ok(), "allocated port should be re-bindable");
    }

    #[test]
    fn parse_watch_port_reads_the_ready_line() {
        assert_eq!(
            parse_watch_port("Watch: http://localhost:26411"),
            Some(26411)
        );
        assert_eq!(
            parse_watch_port("Watch: http://127.0.0.1:8080/"),
            Some(8080)
        );
        assert_eq!(parse_watch_port("  Watch: http://localhost:1"), Some(1));
        // Other lines are ignored — crucially `Watching:` is not a false match.
        assert_eq!(parse_watch_port("Watching: /tmp/p.docx"), None);
        assert_eq!(parse_watch_port("Press Ctrl+C to stop."), None);
    }

    /// `preview_watch_html_core` GETs the loopback origin and surfaces non-2xx /
    /// empty bodies as errors (the frontend falls back to its own fetch).
    #[tokio::test]
    async fn watch_html_fetches_snapshot_body() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = "<html><body><p>snapshot</p></body></html>";
        let body_len = body.len();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(request.starts_with("GET / "), "unexpected request line");
            let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {body_len}\r\n\r\n{body}");
            sock.write_all(response.as_bytes()).await.unwrap();
        });

        let html = preview_watch_html_core(port).await.expect("snapshot");
        assert_eq!(html, body);
        server.abort();
    }

    #[tokio::test]
    async fn watch_html_rejects_dead_port() {
        let port = allocate_free_port().expect("port");
        // Nothing is listening — the GET must fail, not hang or panic.
        let result = preview_watch_html_core(port).await;
        assert!(result.is_err());
    }

    #[test]
    fn resolve_preview_target_confines_and_filters() {
        let dir = std::env::temp_dir().join(format!(
            "codeg-ow-confine-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("a.docx");
        std::fs::write(&docx, b"x").unwrap();
        let txt = dir.join("a.txt");
        std::fs::write(&txt, b"x").unwrap();

        let root = dir.to_string_lossy().to_string();
        // File inside root resolves (provider choice happens at spawn).
        assert!(resolve_preview_target(&root, "a.docx").is_ok());
        // Escape attempt rejected (outside-root or io, never resolves to a file).
        assert!(resolve_preview_target(&root, "../a.docx").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// BERTH_HOME 指向只装了一个预览插件（docx / pptx）的临时目录；持有全局
    /// 环境锁，Drop 时还原。
    struct PreviewFixture {
        home: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
        _guard: MutexGuard<'static, ()>,
    }

    impl Drop for PreviewFixture {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("BERTH_HOME", value),
                None => std::env::remove_var("BERTH_HOME"),
            }
        }
    }

    fn preview_fixture() -> PreviewFixture {
        let lock = berth_tool_core::paths::TEST_ENV_LOCK.get_or_init(|| Mutex::new(()));
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let package = home.path().join("tools/office");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("tool.json"),
            serde_json::json!({
                "id": "office",
                "identity": { "name": "Office Fixture" },
                "extensions": {
                    "org.berth.preview": { "extensions": ["docx", "pptx"], "argv": ["watch", "{file}"], "protocol": "watch/1", "script": "preview.js" },
                    "org.berth.install": { "bin": "berth-office-fixture-missing" }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(package.join("preview.js"), "/* fixture */").unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        std::env::set_var("BERTH_HOME", home.path());
        PreviewFixture {
            home,
            previous,
            _guard: guard,
        }
    }

    fn disable_fixture(fixture: &PreviewFixture) {
        std::fs::write(
            fixture.home.path().join("plugins.json"),
            r#"{"version":1,"plugins":{"office":{"enabled":false}}}"#,
        )
        .unwrap();
    }

    /// 插件的预览脚本随启动结果交给前端（宿主不内置任何渲染器的 DOM 适配）。
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn start_result_carries_the_plugin_script() {
        let _fixture = preview_fixture();
        let tool = preview_provider(Path::new("/x/a.pptx")).unwrap();
        let started = finish_started(
            &tool,
            PreviewWatchStarted {
                port: 1,
                html: None,
                marks: None,
                script: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(started.script.as_deref(), Some("/* fixture */"));
    }

    /// 提供者来自启用插件的 `org.berth.preview`：按后缀匹配、协议须为 watch/1、停用即无。
    #[test]
    fn preview_provider_follows_enabled_plugins() {
        let fixture = preview_fixture();
        assert_eq!(
            preview_provider(Path::new("/x/A.DOCX")).unwrap().id,
            "office"
        );
        assert!(matches!(
            preview_provider(Path::new("/x/a.txt")),
            Err(WatchError::NoProvider)
        ));
        disable_fixture(&fixture);
        assert!(matches!(
            preview_provider(Path::new("/x/a.docx")),
            Err(WatchError::NoProvider)
        ));
    }

    /// 程序缺失时错误带插件名（前端安装提示显示它）。
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn missing_binary_reports_the_plugin_name() {
        let _fixture = preview_fixture();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.docx"), b"x").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let err = start_preview_watch_core(root, "a.docx".into())
            .await
            .unwrap_err();
        assert!(matches!(&err, WatchError::NotInstalled(name) if name == "Office Fixture"));
        let app: AppCommandError = err.into();
        assert_eq!(
            app.i18n_params
                .as_ref()
                .and_then(|p| p.get("tool"))
                .map(String::as_str),
            Some("Office Fixture")
        );
    }

    /// Ref-count sharing + teardown, using a long-lived stand-in child instead
    /// of a real provider (unix-only: a portable never-exiting child).
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn ref_count_sharing_and_teardown() {
        let fixture = preview_fixture();
        let dir = std::env::temp_dir().join(format!("codeg-ow-ref-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("deck.pptx");
        std::fs::write(&docx, b"x").unwrap();
        let root = dir.to_string_lossy().to_string();
        let canonical = std::fs::canonicalize(&docx).unwrap();
        let key = watch_key(&canonical);

        // Seed a live "watch" with a sleep child + a real allocated port.
        let port = allocate_free_port().unwrap();
        let child = tokio_command("sleep").arg("600").spawn().unwrap();
        lock_watches().insert(
            key.clone(),
            WatchInstance {
                child,
                port,
                file_canonical: canonical.clone(),
                ref_count: 1,
                last_activity: Instant::now(),
            },
        );

        // start → fast-path reuse, ref_count 2, same port, no new process.
        let started = start_preview_watch_core(root.clone(), "deck.pptx".into())
            .await
            .unwrap();
        assert_eq!(started.port, port);
        assert_eq!(lock_watches().get(&key).unwrap().ref_count, 2);

        // stop once → still present at ref_count 1.
        stop_preview_watch_core(root.clone(), "deck.pptx".into())
            .await
            .unwrap();
        assert_eq!(lock_watches().get(&key).unwrap().ref_count, 1);

        // stop again → removed.
        stop_preview_watch_core(root.clone(), "deck.pptx".into())
            .await
            .unwrap();
        assert!(lock_watches().get(&key).is_none());

        // 插件停用后，已在运行的进程不再被复用：start 回收它并报 NO_PROVIDER。
        let child = tokio_command("sleep").arg("600").spawn().unwrap();
        lock_watches().insert(
            key.clone(),
            WatchInstance {
                child,
                port,
                file_canonical: canonical.clone(),
                ref_count: 1,
                last_activity: Instant::now(),
            },
        );
        disable_fixture(&fixture);
        assert!(matches!(
            start_preview_watch_core(root.clone(), "deck.pptx".into()).await,
            Err(WatchError::NoProvider)
        ));
        assert!(lock_watches().get(&key).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sweep reaps a dead child and leaves a live (referenced) preview alone
    /// however long it has been idle.
    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_reaping_rules() {
        let stale = Instant::now() - Duration::from_secs(600);

        // (a) dead child → reaped.
        let mut dead = tokio_command("true").spawn().unwrap();
        let _ = dead.wait().await;
        let p_dead = allocate_free_port().unwrap();
        lock_watches().insert(
            "sweep-dead".into(),
            WatchInstance {
                child: dead,
                port: p_dead,
                file_canonical: PathBuf::from("/seed/dead"),
                ref_count: 1,
                last_activity: Instant::now(),
            },
        );

        // (b) live preview (ref_count>=1, idle) → kept.
        let p_desk = allocate_free_port().unwrap();
        lock_watches().insert(
            "sweep-desk".into(),
            WatchInstance {
                child: tokio_command("sleep").arg("600").spawn().unwrap(),
                port: p_desk,
                file_canonical: PathBuf::from("/seed/desk"),
                ref_count: 1,
                last_activity: stale,
            },
        );

        // Don't assert on the returned count: it's racy under parallel tests. A
        // concurrent sweep (e.g. `sweep_prunes_unreferenced_spawn_locks`) can
        // reap these entries first, and this sweep can additionally reap another
        // test's seeded dead child. The post-conditions below are deterministic
        // — after this sweep returns, a dead/abandoned entry is gone no matter
        // which sweep reaped it, and a live preview is never reapable.
        sweep_preview_watches(Duration::from_secs(300));
        assert!(
            lock_watches().get("sweep-dead").is_none(),
            "a dead child must be reaped"
        );
        assert!(
            lock_watches().get("sweep-desk").is_some(),
            "a live preview must not be swept"
        );
        if let Some(e) = lock_watches().remove("sweep-desk") {
            reap(e.child);
        }
    }

    #[test]
    fn sweep_prunes_unreferenced_spawn_locks() {
        // An entry no task references (returned Arc dropped → only the map holds
        // it) is pruned by the sweep…
        let _ = spawn_lock_for("prune-me-unref");
        // …while one a task still holds (we keep this clone) is retained.
        let held = spawn_lock_for("keep-me-ref");

        sweep_preview_watches(Duration::from_secs(300));

        {
            let map = SPAWN_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
            assert!(
                !map.contains_key("prune-me-unref"),
                "an unreferenced spawn lock must be pruned"
            );
            assert!(
                map.contains_key("keep-me-ref"),
                "a spawn lock a task still holds must be kept"
            );
        }

        drop(held);
        // Now unreferenced → next sweep prunes it too.
        sweep_preview_watches(Duration::from_secs(300));
        assert!(!SPAWN_LOCKS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key("keep-me-ref"));
    }

    #[test]
    fn idle_timeout_env_parsing() {
        std::env::set_var("BERTH_PREVIEW_WATCH_IDLE_TIMEOUT_SECS", "0");
        assert!(idle_timeout_from_env().is_none());
        std::env::set_var("BERTH_PREVIEW_WATCH_IDLE_TIMEOUT_SECS", "nope");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
        std::env::set_var("BERTH_PREVIEW_WATCH_IDLE_TIMEOUT_SECS", "120");
        assert_eq!(idle_timeout_from_env().unwrap().as_secs(), 120);
        std::env::remove_var("BERTH_PREVIEW_WATCH_IDLE_TIMEOUT_SECS");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
    }
}
