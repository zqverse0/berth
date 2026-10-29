//! 文件工具插件的宿主侧：解析 `org.berth.install` 声明的程序、执行包内安装脚本，
//! 以及 Office 实时预览（watch）命令。程序名、后缀、参数、安装脚本都来自插件
//! （`berth_tool_core::file_tools`），这里不写死任何工具。

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::app_error::AppCommandError;
use crate::event_bridge::EventEmitter;
use crate::platform::process::{collect_lines_lossy, tokio_command};
use berth_tool_core::file_tools::{self, FileTool, Install, Latest};

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum PreviewToolsError {
    #[error("no enabled plugin provides this file type")]
    NoProvider,
    #[error("io error: {0}")]
    Io(String),
    #[error("command failed: {0}")]
    CommandFailed(String),
}

impl Serialize for PreviewToolsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<io::Error> for PreviewToolsError {
    fn from(err: io::Error) -> Self {
        PreviewToolsError::Io(err.to_string())
    }
}

// ─── Concurrency ───────────────────────────────────────────────────────

fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ─── Public types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewToolInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// Set when the binary file is present (`installed = true`) but actually
    /// running it failed — e.g. a self-contained-.NET startup failure from a
    /// missing system library (libicu) on a slim Linux server image. Carries a
    /// human-readable, actionable diagnostic; `None` when the tool runs fine or
    /// isn't installed at all.
    pub runtime_error: Option<String>,
    /// 包内有 `install.sh` / `install.ps1`，Berth 能代为安装。
    pub install_script: bool,
    /// 已安装且有更新途径：程序自带更新参数，或可重跑安装脚本。
    pub can_update: bool,
}

/// 与 `latest` 来源比对后的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub latest: String,
    pub update_available: bool,
}
// ─── Binary resolution ─────────────────────────────────────────────────

/// `install.bin` 先查 PATH，再查声明的已知安装位置（覆盖 Windows 上安装脚本刚改的
/// User PATH 尚未进入本进程的窗口）。
pub(crate) fn resolve_bin(install: &Install) -> Option<PathBuf> {
    which::which(&install.bin)
        .ok()
        .or_else(|| install.paths.iter().find(|path| path.is_file()).cloned())
}

/// Last `max` chars of `s` (char-boundary safe), prefixed with `…` when
/// truncated. Bounds installer diagnostics surfaced to the UI toast.
fn bounded_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/// 解析到程序后用 `install.version` 参数试跑：确认它能执行。装上但跑不起来（如缺
/// 系统库）时 `runtime_error` 带 stderr 尾部，可操作的提示由插件安装脚本给出。
async fn detect(tool: &FileTool) -> PreviewToolInfo {
    let install_script = install_script(&tool.dir).is_some();
    let Some(path) = resolve_bin(&tool.install) else {
        return PreviewToolInfo {
            installed: false,
            version: None,
            path: None,
            runtime_error: None,
            install_script,
            can_update: false,
        };
    };
    let (version, runtime_error) = match tokio_command(&path)
        .args(&tool.install.version)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            // 只取首个非空行：如 `gh --version` 第二行是发布页链接。
            let stdout = String::from_utf8_lossy(&output.stdout);
            let version = stdout
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or_default()
                .to_string();
            ((!version.is_empty()).then_some(version), None)
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            let detail = if stderr.is_empty() {
                format!("{} exited with an error and produced no output", tool.name)
            } else {
                format!("{} error: {}", tool.name, bounded_tail(stderr, 600))
            };
            (None, Some(detail))
        }
        Err(e) => (None, Some(format!("failed to run {}: {e}", tool.name))),
    };
    PreviewToolInfo {
        installed: true,
        version,
        path: Some(path.to_string_lossy().to_string()),
        runtime_error,
        install_script,
        can_update: install_script || !tool.install.update.is_empty(),
    }
}

/// 包内约定安装脚本：Unix `install.sh`（bash），Windows `install.ps1`。
fn install_script(dir: &Path) -> Option<(String, Vec<String>)> {
    if cfg!(windows) {
        let script = dir.join("install.ps1");
        script.is_file().then(|| {
            (
                "powershell.exe".to_string(),
                ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
                    .map(str::to_string)
                    .into_iter()
                    .chain([script.to_string_lossy().to_string()])
                    .collect(),
            )
        })
    } else {
        let script = dir.join("install.sh");
        script.is_file().then(|| {
            (
                "bash".to_string(),
                vec![script.to_string_lossy().to_string()],
            )
        })
    }
}

/// 安装脚本整体时限（脚本下载 + 它再拉的多 MB 二进制）。超时杀整棵进程树，
/// 见 `stream_install_or_kill_tree`。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

// ─── Commands: install / uninstall ─────────────────────────────────────

// ─── Streamed install progress events ──────────────────────────────────
//
// The official installer downloads a multi-MB binary; on a slow network that
// looks like a hang. Mirror the ACP agent-install UX: stream the installer's
// stdout/stderr to the settings page line-by-line over a dedicated event
// channel, tagged with the caller's `task_id` so concurrent installs don't
// cross-contaminate. Shape matches `AgentInstallEvent` in `commands::acp`.

const PREVIEW_INSTALL_EVENT: &str = "app://preview-tool-install";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum PreviewInstallEventKind {
    Started,
    Log,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
struct PreviewInstallEvent {
    task_id: String,
    kind: PreviewInstallEventKind,
    payload: String,
}

fn emit_preview_install_event(
    emitter: &EventEmitter,
    task_id: &str,
    kind: PreviewInstallEventKind,
    payload: impl Into<String>,
) {
    crate::event_bridge::emit_event(
        emitter,
        PREVIEW_INSTALL_EVENT,
        PreviewInstallEvent {
            task_id: task_id.to_string(),
            kind,
            payload: payload.into(),
        },
    );
}

/// Tauri command: run the preview plugin's installer, streaming progress as
/// `app://preview-tool-install` events tagged with `task_id`. The work lives in
/// `install_preview_tool_core` so the web handler can share it with its own emitter.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn install_preview_tool(
    task_id: String,
    path: String,
    tool_id: Option<String>,
    update: Option<bool>,
    app: tauri::AppHandle,
) -> Result<PreviewToolInfo, PreviewToolsError> {
    install_preview_tool_core(
        task_id,
        path,
        tool_id,
        update.unwrap_or(false),
        &EventEmitter::Tauri(app),
    )
    .await
}

/// Tauri command: 按插件声明的 `latest` 来源查最新版本并与已装版本比对；没声明时为 `None`。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tool_update_check(tool_id: String) -> Result<Option<UpdateCheck>, PreviewToolsError> {
    let Some(tool) = file_tools::installable(&tool_id) else {
        return Ok(None);
    };
    let Some(source) = &tool.install.latest else {
        return Ok(None);
    };
    let raw = fetch_latest(source)
        .await
        .map_err(PreviewToolsError::CommandFailed)?;
    let latest = version_numbers(&raw)
        .ok_or_else(|| PreviewToolsError::CommandFailed(format!("unrecognized version: {raw}")))?;
    let installed = detect(&tool)
        .await
        .version
        .as_deref()
        .and_then(version_numbers);
    Ok(Some(UpdateCheck {
        update_available: installed.is_some_and(|installed| latest > installed),
        latest: latest
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join("."),
    }))
}

/// 第一个形如 `1.2.3` 的数字段：`rust-v0.160.0`、`gh version 2.101.0 (2026-09-15)` 都能取出。
fn version_numbers(text: &str) -> Option<Vec<u64>> {
    text.split(|c: char| !c.is_ascii_digit() && c != '.')
        .map(|token| token.trim_matches('.'))
        .filter(|token| token.contains('.'))
        .find_map(|token| token.split('.').map(|part| part.parse().ok()).collect())
}

async fn fetch_latest(source: &Latest) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("berth")
        .build()
        .map_err(|e| e.to_string())?;
    match source {
        Latest::Npm(name) => {
            let url = format!(
                "https://registry.npmjs.org/{}/latest",
                name.replace('/', "%2F")
            );
            let body: serde_json::Value = client
                .get(url)
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("npm registry: {e}"))?
                .json()
                .await
                .map_err(|e| format!("npm registry: {e}"))?;
            body.get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("npm registry: no version for {name}"))
        }
        // releases/latest 跳转到 .../tag/<tag>：不调 API，避开未登录的速率限制。
        Latest::Github(repo) => {
            let response = client
                .head(format!("https://github.com/{repo}/releases/latest"))
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("GitHub: {e}"))?;
            let url = response.url().path().to_string();
            url.rsplit_once("/tag/")
                .map(|(_, tag)| tag.to_string())
                .ok_or_else(|| format!("GitHub: {repo} has no published release"))
        }
    }
}

/// Tauri command: 插件 `tool_id` 声明的程序装没装、能不能跑；没有安装声明时为 `None`。
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn preview_tool_status(tool_id: String) -> Option<PreviewToolInfo> {
    let tool = file_tools::installable(&tool_id)?;
    Some(detect(&tool).await)
}

/// 为插件 `tool_id`（未给时取预览 `path` 这类文件的插件）运行其包内安装脚本，输出按行流成
/// `app://preview-tool-install` 事件。下载、校验、安装位置、PATH 都归脚本。
pub(crate) async fn install_preview_tool_core(
    task_id: String,
    path: String,
    tool_id: Option<String>,
    update: bool,
    emitter: &EventEmitter,
) -> Result<PreviewToolInfo, PreviewToolsError> {
    emit_preview_install_event(emitter, &task_id, PreviewInstallEventKind::Started, "");
    let fail = |msg: String| {
        emit_preview_install_event(emitter, &task_id, PreviewInstallEventKind::Failed, &msg);
        PreviewToolsError::CommandFailed(msg)
    };
    let tool = match tool_id.as_deref() {
        Some(id) => file_tools::installable(id)
            .ok_or_else(|| fail(format!("plugin {id} declares no installable program")))?,
        None => file_tools::provider_for(file_tools::PREVIEW, Path::new(&path))
            .ok_or_else(|| fail(PreviewToolsError::NoProvider.to_string()))?,
    };
    let name = &tool.name;
    let manual = tool
        .homepage
        .as_deref()
        .map_or_else(String::new, |url| format!(" — install manually from {url}"));
    // 更新优先用程序自带的更新命令（它知道自己从哪个渠道装的，不会另装一份）。
    let self_update = update
        .then(|| resolve_bin(&tool.install))
        .flatten()
        .filter(|_| !tool.install.update.is_empty());
    let (program, args) = match self_update {
        Some(bin) => (
            bin.to_string_lossy().to_string(),
            tool.install.update.clone(),
        ),
        None => install_script(&tool.dir)
            .ok_or_else(|| fail(format!("plugin {} has no install script{manual}", tool.id)))?,
    };

    // Install calls share `mutation_lock`. Acquire it AFTER the first stream
    // event so the panel is responsive immediately, and surface a waiting hint
    // when another install already holds it (e.g. a second web client).
    let _guard = match mutation_lock().try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            emit_preview_install_event(
                emitter,
                &task_id,
                PreviewInstallEventKind::Log,
                "Waiting for another install to finish…",
            );
            mutation_lock().lock().await
        }
    };

    emit_preview_install_event(
        emitter,
        &task_id,
        PreviewInstallEventKind::Log,
        format!("Running {} {}…", program, args.join(" ")),
    );
    let child = tokio_command(&program)
        .args(&args)
        // Pipe output so we can stream it; null stdin so the installer can't
        // block waiting on input it will never get.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| fail(format!("failed to run the {name} installer: {e}{manual}")))?;

    // Stream stdout+stderr line-by-line as Log events, bounded by the install
    // timeout. On timeout the whole process tree is killed — not just the direct
    // shell — so the script's download descendant can't keep installing in the
    // background and race a later retry once `mutation_lock` is released.
    let (maybe_status, stdout_tail, stderr_tail) =
        stream_install_or_kill_tree(child, INSTALL_TIMEOUT, &task_id, emitter)
            .await
            .map_err(|e| fail(format!("failed to run the {name} installer: {e}{manual}")))?;

    let Some(status) = maybe_status else {
        return Err(fail(format!(
            "{name} install timed out after {}s — check your network{manual}",
            INSTALL_TIMEOUT.as_secs()
        )));
    };
    if !status.success() {
        // Install scripts report failures on stdout as much as stderr: prefer
        // stderr, fall back to stdout, and bound the tail.
        let detail = if stderr_tail.trim().is_empty() {
            stdout_tail.trim()
        } else {
            stderr_tail.trim()
        };
        return Err(fail(format!(
            "{name} install failed: {}{manual}",
            bounded_tail(detail, 800)
        )));
    }

    let info = detect(&tool).await;
    if !info.installed {
        return Err(fail(format!(
            "installation completed but {} was not found{manual}",
            tool.install.bin
        )));
    }
    // Present but unrunnable (e.g. a missing system library) is not a usable install.
    if let Some(runtime_error) = &info.runtime_error {
        return Err(fail(runtime_error.clone()));
    }

    let done = match &info.version {
        Some(version) => format!("{name} {version} installed successfully"),
        None => format!("{name} installed successfully"),
    };
    emit_preview_install_event(emitter, &task_id, PreviewInstallEventKind::Completed, done);
    Ok(info)
}

/// Stream `child`'s stdout+stderr line-by-line as install Log events,
/// bounded by `timeout`. Returns the exit status (`None` on timeout) plus the
/// collected stdout/stderr tails for failure diagnostics.
///
/// Killing the *tree* (via `kill_tree`) on timeout rather than just the direct
/// child matters: the vendor installer script downloads the multi-MB binary in a
/// descendant process (`curl` under `install.sh`, `Invoke-WebRequest` under
/// `install.ps1`). On timeout, dropping the wait future detaches the direct
/// shell but would leave that descendant running — it could finish installing
/// in the background and race a later retry/uninstall once `mutation_lock` is
/// released. We deliberately do NOT use `Command::kill_on_drop`: it SIGKILLs the
/// shell first, reparenting the descendant away so `kill_tree` could no longer
/// reach it. Capturing the pid before the wait and killing the tree on timeout
/// keeps the descendant reachable. `kill_tree` is best-effort (a pid that has
/// already exited is a no-op); Tokio's orphan reaper reaps the killed children.
async fn stream_install_or_kill_tree(
    mut child: tokio::process::Child,
    timeout: Duration,
    task_id: &str,
    emitter: &EventEmitter,
) -> io::Result<(Option<std::process::ExitStatus>, String, String)> {
    use tokio::io::BufReader;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_handle = tokio::spawn({
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        async move {
            match stdout {
                Some(out) => {
                    collect_lines_lossy(BufReader::new(out), |line| {
                        emit_preview_install_event(
                            &emitter,
                            &task_id,
                            PreviewInstallEventKind::Log,
                            line,
                        );
                    })
                    .await
                }
                None => String::new(),
            }
        }
    });

    let stderr_handle = tokio::spawn({
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        async move {
            match stderr {
                Some(err) => {
                    collect_lines_lossy(BufReader::new(err), |line| {
                        emit_preview_install_event(
                            &emitter,
                            &task_id,
                            PreviewInstallEventKind::Log,
                            line,
                        );
                    })
                    .await
                }
                None => String::new(),
            }
        }
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            // `wait()` itself failed (rare). Best-effort kill the tree in case
            // the process is still alive — same rationale as the timeout path —
            // then abort the readers (which may never EOF) and surface the error.
            if let Some(pid) = pid {
                if let Err(err) = kill_tree::tokio::kill_tree(pid).await {
                    tracing::error!("[preview-tool] kill_tree failed for install pid {pid}: {err}");
                }
            }
            stdout_handle.abort();
            stderr_handle.abort();
            return Err(e);
        }
        Err(_) => {
            // Timed out: kill the whole tree (see note above), then return
            // WITHOUT joining the readers. A descendant that survived a
            // best-effort kill keeps its pipe write-end open, so the reader
            // would never hit EOF — awaiting it here would pin `mutation_lock`
            // forever, defeating the timeout. The timeout diagnostic doesn't
            // need the collected tails, so abort the readers and return.
            if let Some(pid) = pid {
                if let Err(err) = kill_tree::tokio::kill_tree(pid).await {
                    tracing::error!("[preview-tool] kill_tree failed for install pid {pid}: {err}");
                }
            }
            stdout_handle.abort();
            stderr_handle.abort();
            return Ok((None, String::new(), String::new()));
        }
    };

    // Normal exit: the process is gone, so the pipes are at EOF and these joins
    // return promptly with the collected tails (used for failure diagnostics).
    let stdout_tail = stdout_handle.await.unwrap_or_default();
    let stderr_tail = stderr_handle.await.unwrap_or_default();

    Ok((Some(status), stdout_tail, stderr_tail))
}

// ─── Commands: live file preview (watch) ─────────────────────────────

/// Start (or share, by ref-count) a long-lived watch HTTP preview server —
/// started from the enabled plugin's `org.berth.preview` declaration — for an
/// office file and return its loopback port. The preview tool drives its own
/// SSE refresh, so it never races the agent's edits for the file on disk.
/// See `crate::preview_watch`.
/// Also starts forwarding the watch's own pushes (content / marks / goto) to
/// the webview as `app://preview-watch-update`, so agent edits show before the
/// disk flush, and returns the watch's latest marks for a remounting preview.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn start_preview_watch(
    root_path: String,
    path: String,
    app: tauri::AppHandle,
) -> Result<crate::preview_watch::PreviewWatchStarted, AppCommandError> {
    let mut started = crate::preview_watch::start_preview_watch_core(root_path, path).await?;
    crate::preview_watch::ensure_update_pump(started.port, EventEmitter::Tauri(app));
    started.marks = crate::preview_watch::last_marks(started.port);
    Ok(started)
}

/// Release one reference to the watch preview for an office file; kills the
/// server when the last viewer goes away.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stop_preview_watch(root_path: String, path: String) -> Result<(), AppCommandError> {
    crate::preview_watch::stop_preview_watch_core(root_path, path)
        .await
        .map_err(Into::into)
}

/// Re-fetch the current preview HTML of a live preview server by
/// port (server-side GET of the loopback origin). The desktop preview moved
/// from a visible child WebView to a sandboxed srcdoc document, so refreshes
/// pull a fresh snapshot instead of reloading the loopback page in place.
/// `start_preview_watch` already returns the first snapshot; this covers
/// subsequent refreshes (watch SSE / file-change driven).
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn preview_watch_refresh_html(port: u16) -> Result<String, AppCommandError> {
    crate::preview_watch::preview_watch_html_core(port)
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 安装走启用插件的包内 `install.sh`：装好后按 `install.bin` / `paths` 找到程序并用
    /// `version` 试跑；停用插件即无提供者。Unix-only（`bash`）。
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn install_runs_the_plugin_script_and_detects_the_binary() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().unwrap();
        let package = home.path().join("tools/fixture");
        let bin = home.path().join("bin/fixture-preview");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("tool.json"),
            serde_json::json!({
                "id": "fixture",
                "identity": { "name": "Fixture" },
                "extensions": {
                    "org.berth.preview": { "extensions": ["fx"], "argv": ["watch", "{file}"], "protocol": "watch/1" },
                    "org.berth.install": {
                        "bin": "berth-fixture-not-on-path",
                        "paths": { "unix": [bin.to_string_lossy()] },
                        "version": ["--version"]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            package.join("install.sh"),
            format!(
                "mkdir -p '{dir}' && printf '#!/bin/sh\necho 9.9\n' > '{bin}' && chmod +x '{bin}' && echo installed",
                dir = bin.parent().unwrap().display(),
                bin = bin.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(
            package.join("install.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        // 只声明程序、不接入预览的包（如 Agent）也能按 id 查到。
        let agent = home.path().join("tools/agentish");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(
            agent.join("tool.json"),
            serde_json::json!({
                "id": "agentish",
                "identity": { "name": "Agentish" },
                "extensions": { "org.berth.install": { "bin": "berth-agentish", "version": ["--version"] } }
            })
            .to_string(),
        )
        .unwrap();

        // 全局 BERTH_HOME 由 TEST_ENV_LOCK 串行化；current-thread 运行时下跨 await 持锁无碍。
        let lock = berth_tool_core::paths::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("BERTH_HOME");
        std::env::set_var("BERTH_HOME", home.path());
        let info = install_preview_tool_core(
            "t".into(),
            "doc.fx".into(),
            None,
            false,
            &EventEmitter::Noop,
        )
        .await;
        let missing = install_preview_tool_core(
            "t".into(),
            "doc.txt".into(),
            None,
            false,
            &EventEmitter::Noop,
        )
        .await;
        let by_id = install_preview_tool_core(
            "t".into(),
            String::new(),
            Some("fixture".into()),
            false,
            &EventEmitter::Noop,
        )
        .await;
        let agentish = file_tools::installable("agentish");
        let unknown_id = install_preview_tool_core(
            "t".into(),
            String::new(),
            Some("nope".into()),
            false,
            &EventEmitter::Noop,
        )
        .await;
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let info = info.unwrap();
        assert!(info.installed);
        assert_eq!(info.version.as_deref(), Some("9.9"));
        assert_eq!(info.path.as_deref(), Some(bin.to_string_lossy().as_ref()));
        assert!(missing
            .unwrap_err()
            .to_string()
            .contains("no enabled plugin"));
        assert_eq!(by_id.unwrap().version.as_deref(), Some("9.9"));
        let agentish = agentish.expect("install-only package is installable");
        assert_eq!(agentish.name, "Agentish");
        let agentish = detect(&agentish).await;
        assert!(!agentish.installed);
        assert!(!agentish.install_script);
        assert!(unknown_id
            .unwrap_err()
            .to_string()
            .contains("declares no installable program"));
    }

    #[test]
    fn version_numbers_skip_prefixes_and_dates() {
        assert_eq!(version_numbers("rust-v0.160.0"), Some(vec![0, 160, 0]));
        assert_eq!(
            version_numbers("gh version 2.101.0 (2026-09-15)"),
            Some(vec![2, 101, 0])
        );
        assert_eq!(
            version_numbers("grok 1.0.46 (2765805b9442)"),
            Some(vec![1, 0, 46])
        );
        assert_eq!(version_numbers("v1.2.3-beta.1"), Some(vec![1, 2, 3]));
        assert_eq!(version_numbers("no version"), None);
        assert!(version_numbers("2.1.288") > version_numbers("2.1.284 (Claude Code)"));
        assert!(version_numbers("0.160.0") > version_numbers("0.159.2"));
    }

    /// On timeout the *whole tree* must die, not just the direct shell — the
    /// vendor script downloads the binary in a descendant. Models that with
    /// `sh` spawning a long-lived `sleep` grandchild and asserts the grandchild
    /// is killed. Unix-only (relies on `sh`/`kill(2)`).
    #[cfg(unix)]
    #[tokio::test]
    async fn install_timeout_kills_whole_process_tree() {
        use std::time::Duration;

        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("grandchild.pid");
        // `sh` (direct child) backgrounds `sleep` (grandchild), records its pid,
        // and `wait`s — so the tree outlives our short timeout.
        let child = tokio_command("sh")
            .arg("-c")
            .arg(format!(
                "sleep 30 & echo $! > '{}'; wait",
                pidfile.display()
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");

        let (status, _stdout, _stderr) = stream_install_or_kill_tree(
            child,
            Duration::from_millis(300),
            "test",
            &EventEmitter::Noop,
        )
        .await
        .expect("no io error");
        assert!(status.is_none(), "expected a timeout (no exit status)");

        // Grandchild pid is written almost immediately; poll briefly for it.
        let mut gpid = None;
        for _ in 0..100 {
            if let Ok(s) = std::fs::read_to_string(&pidfile) {
                if let Ok(p) = s.trim().parse::<i32>() {
                    gpid = Some(p);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let gpid = gpid.expect("grandchild recorded its pid");

        // Poll until the grandchild is gone: `kill(pid, 0)` returns -1/ESRCH
        // once it no longer exists (reparented + reaped after the tree kill).
        let mut alive = true;
        for _ in 0..150 {
            // SAFETY: signal 0 only probes for existence; it sends no signal.
            if unsafe { libc::kill(gpid, 0) } != 0 {
                alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            !alive,
            "grandchild {gpid} survived — the process tree was not killed"
        );
    }

    #[test]
    fn bounded_tail_is_char_safe_and_bounded() {
        assert_eq!(bounded_tail("short", 800), "short");

        let long = "x".repeat(1000);
        let tail = bounded_tail(&long, 800);
        assert!(tail.starts_with('…'));
        assert_eq!(tail.chars().filter(|c| *c == 'x').count(), 800);

        // Multibyte input must not panic and must stay on a char boundary.
        let multibyte = "あ".repeat(500); // 1500 bytes
        let tail = bounded_tail(&multibyte, 800);
        assert!(tail.starts_with('…'));
        assert!(tail.chars().skip(1).all(|c| c == 'あ'));
    }
}
