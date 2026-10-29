//! Centralized resolution of berth-owned filesystem paths.
//!
//! Mirrors the conventions already used by `preferences.rs` (`~/.berth/`)
//! and `experts.rs` (`~/.berth/skills/`). New features that need a
//! user-scoped persistent directory should call into this module instead of
//! re-deriving `dirs::home_dir().join(".berth")` themselves.

use std::path::{Path, PathBuf};

/// Read an operator-facing environment variable by its bare suffix.
///
/// Canonical name is `BERTH_{suffix}` only. The legacy `CODEG_{suffix}` prefix
/// is no longer accepted as a successful config path. Pass the suffix without a
/// prefix, e.g. `env_var("PORT")` reads `BERTH_PORT`.
///
/// Prefer [`reject_legacy_operator_env`] / [`reject_known_legacy_operator_envs`] at
/// startup (or other silent-misconfig entry points) so a deployment that only
/// set `CODEG_*` fails loudly with a rename hint instead of falling back to
/// defaults.
pub fn env_var(suffix: &str) -> Option<String> {
    std::env::var(format!("BERTH_{suffix}")).ok()
}

/// Operator-facing error when a legacy `CODEG_{suffix}` is present but the
/// corresponding `BERTH_{suffix}` is not. Never includes the variable value
/// (tokens / secrets must stay out of logs and stderr).
pub fn legacy_operator_env_error(suffix: &str) -> String {
    format!("CODEG_{suffix} is no longer supported; set BERTH_{suffix}")
}

/// Returns `Err` with [`legacy_operator_env_error`] when `CODEG_{suffix}` is set
/// (even empty) and `BERTH_{suffix}` is unset. When `BERTH_{suffix}` is set,
/// legacy is ignored (new name wins; no dual-read of the value).
pub fn reject_legacy_operator_env(suffix: &str) -> Result<(), String> {
    let berth_key = format!("BERTH_{suffix}");
    let codeg_key = format!("CODEG_{suffix}");
    if std::env::var_os(&berth_key).is_some() {
        return Ok(());
    }
    if std::env::var_os(&codeg_key).is_some() {
        return Err(legacy_operator_env_error(suffix));
    }
    Ok(())
}

/// Known operator-facing suffixes that historically used a `CODEG_` prefix.
/// Checked at process startup so misconfigured deployments fail before
/// binding a port or accepting traffic.
pub const KNOWN_OPERATOR_ENV_SUFFIXES: &[&str] = &[
    "PORT",
    "HOST",
    "TOKEN",
    "STATIC_DIR",
    "DATA_DIR",
    "HOME",
    "MCP_BIN",
    "SKIP_SIDECAR",
    "UPLOAD_MAX_TOTAL_BYTES",
    "UPLOAD_QUOTA_STRICT",
    "LOG",
    "LOG_MAX_FILES",
    "ACP_IDLE_TIMEOUT_SECS",
    "ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS",
    "ACP_BACKGROUND_KEEPALIVE_MAX_SECS",
    "ACP_DEBUG",
    "PREVIEW_WATCH_IDLE_TIMEOUT_SECS",
    "BACKUP_UPLOAD_MAX_BYTES",
    "WORKSPACE_UPLOAD_MAX_CONCURRENCY",
    "WORKSPACE_ZIP_MAX_CONCURRENCY",
    "SUPERVISED",
    "RESTART_DELAY_MS",
    "RUNTIME",
    "UPGRADE_TRIAL_SECS",
];

/// Reject any known legacy `CODEG_*` operator env that has no matching
/// `BERTH_*`. First failure wins (message names that one suffix).
pub fn reject_known_legacy_operator_envs() -> Result<(), String> {
    for suffix in KNOWN_OPERATOR_ENV_SUFFIXES {
        reject_legacy_operator_env(suffix)?;
    }
    Ok(())
}

const BERTH_DIR_NAME: &str = ".berth";
const UPLOADS_DIR_NAME: &str = "uploads";
const LOGS_DIR_NAME: &str = "logs";
const BACKGROUNDS_DIR_NAME: &str = "backgrounds";

/// `$BERTH_HOME` if set (and non-empty), else `~/.berth/`.
///
/// Returns the relative `.berth` path when no home directory is available;
/// callers must still handle creation failures gracefully.
///
/// 实现委托 `berth-tool-core::paths`（09-10 design D3：路径根单处公共
/// 实现，CLI 与桌面不得各自猜测）。
pub fn berth_home_dir() -> PathBuf {
    berth_tool_core::paths::berth_home_dir()
}

/// App-data subdirectory: db-adjacent files (uploads, logs).
///
/// `$BERTH_DATA_DIR` 优先；开发实例把数据库、uploads 和 logs 放在
/// `~/.berth-dev`，不与正式版共用应用数据。
/// `$BERTH_HOME` is only the fallback when DATA_DIR is unset.
fn berth_app_data_subdir(name: &str) -> PathBuf {
    if let Some(data) = std::env::var_os("BERTH_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(name);
    }
    if let Some(home) = std::env::var_os("BERTH_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(home).join(name);
    }
    dirs::home_dir()
        .map(|h| h.join(BERTH_DIR_NAME).join(name))
        .unwrap_or_else(|| PathBuf::from(BERTH_DIR_NAME).join(name))
}

/// Root directory for attachments uploaded from the web client.
///
/// Resolution order:
/// 1. `$BERTH_DATA_DIR/uploads` (application data)
/// 2. `$BERTH_HOME/uploads` (only when DATA_DIR is unset)
/// 3. `~/.berth/uploads` (desktop default)
///
/// Files in this directory are not garbage-collected by berth itself —
/// later conversations may still reference them via `file://` URIs
/// embedded in session history. To bound the long-term footprint on
/// shared / multi-tenant servers, operators can set
/// `BERTH_UPLOAD_MAX_TOTAL_BYTES` (see `web::handlers::files`): new
/// uploads beyond the cap are rejected at the API boundary while
/// existing files stay readable.
///
/// **Concurrency contract:** the quota check uses a process-local
/// in-flight reservation counter to make `BERTH_UPLOAD_MAX_TOTAL_BYTES`
/// a hard ceiling within one `berth-server` process. Multiple
/// `berth-server` processes sharing the same uploads root (e.g.
/// horizontally-scaled containers mounted on the same volume) will
/// each enforce the cap independently and can collectively exceed it.
/// Berth is designed for single-process deployments; horizontal
/// scaling would require external coordination (file lock, Redis,
/// reverse-proxy quota) that this codebase does not provide.
pub fn berth_uploads_root() -> PathBuf {
    berth_app_data_subdir(UPLOADS_DIR_NAME)
}

/// Root directory for durable CLI Tool Manifests and agent identity dirs.
///
/// Tools are user-editable resources (like `~/.berth/skills/`), so the root
/// follows `berth_home_dir()`: `$BERTH_HOME/tools`, else `~/.berth/tools`.
/// `BERTH_DATA_DIR` deliberately does NOT apply here — it is the
/// application-data root (database, uploads) and the desktop startup code
/// overwrites it with Tauri's `app_data_dir()` at runtime
/// (`lib.rs` setup: `set_var("BERTH_DATA_DIR", app_data_dir)`), which would
/// otherwise silently relocate tools away from the user's home layout.
///
/// Each manifest lives at `<id>.json`; `index.json` inside this directory is
/// a derived, disposable cache (see `cli_tools::index`).
pub fn cli_tools_root() -> PathBuf {
    // 规则实现在 core（与 CLI 共用）；此处仅保持桌面调用路径不变。
    berth_tool_core::paths::tools_root()
}

/// Root directory for user-provided provider balance declarations.
///
/// Resolution mirrors the other data roots exactly:
/// 1. `$BERTH_HOME/provider-usage`
/// 2. `$BERTH_DATA_DIR/provider-usage` (server-mode data directory)
/// 3. `~/.berth/provider-usage` (desktop default)
///
/// Each declaration lives at `<id>.json` (same shape as the built-in
/// `balance_templates.json` entries); user entries override built-ins with
/// the same id and add new sites.
pub fn provider_usage_root() -> PathBuf {
    const PROVIDER_USAGE_DIR_NAME: &str = "provider-usage";
    if let Some(custom) = std::env::var_os("BERTH_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(PROVIDER_USAGE_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("BERTH_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(PROVIDER_USAGE_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(BERTH_DIR_NAME).join(PROVIDER_USAGE_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(BERTH_DIR_NAME).join(PROVIDER_USAGE_DIR_NAME))
}

/// Root directory for the user-selected workspace background image.
///
/// Resolution mirrors the other data roots exactly:
/// 1. `$BERTH_HOME/backgrounds` (explicit override)
/// 2. `$BERTH_DATA_DIR/backgrounds` (server-mode data directory)
/// 3. `~/.berth/backgrounds` (desktop default)
pub fn berth_backgrounds_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("BERTH_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(BACKGROUNDS_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("BERTH_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(BACKGROUNDS_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(BERTH_DIR_NAME).join(BACKGROUNDS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(BERTH_DIR_NAME).join(BACKGROUNDS_DIR_NAME))
}

/// Root directory for application diagnostic logs (rotating files written by
/// the `tracing` file appender; see `crate::logging`).
///
/// Resolution mirrors [`berth_uploads_root`] so logs land with the database:
/// 1. `$BERTH_DATA_DIR/logs` (application data)
/// 2. `$BERTH_HOME/logs` (only when DATA_DIR is unset)
/// 3. `~/.berth/logs` (default for the desktop app)
///
/// Pure env + `dirs::home_dir()`, so it is callable at the very start of a
/// process — before the database (or, in `berth-server`, the tokio runtime)
/// exists — which is exactly when the subscriber must be installed.
pub fn berth_logs_root() -> PathBuf {
    berth_app_data_subdir(LOGS_DIR_NAME)
}

/// 决策模型（Jev）调用记录目录，跟数据库放一起：dev 实例与正式版各记各的。
pub fn berth_decisions_root() -> PathBuf {
    berth_app_data_subdir("decisions")
}

/// Single source of truth for "where does the database live, and where
/// do `paths::*` resolve their roots against."
///
/// Resolution:
/// 1. If `BERTH_DATA_DIR` is set and non-empty, return its absolutized
///    form. Honors the operator's choice even on desktop, where a
///    pre-set env var should override Tauri's identifier-derived path.
/// 2. Otherwise return the absolutized form of `tauri_fallback` —
///    typically `app.path().app_data_dir()` on desktop or the
///    server's default data dir.
///
/// Always returns an absolute path (`absolutize` re-bases against the
/// process CWD if needed). Callers should treat the result as
/// authoritative and not re-read `BERTH_DATA_DIR` themselves; the
/// startup code in `lib.rs` / `bin/berth_server.rs` writes the
/// resolved value back to the env so subprocess inheritance works,
/// but the in-process source of truth is this function.
///
/// This exists because Tauri's `app.path().app_data_dir()` does **not**
/// consult `BERTH_DATA_DIR` — it returns the identifier-derived path
/// unconditionally. Call sites that pass `app_data_dir()` straight
/// into git credential helpers, ACP, terminal sessions, etc. would
/// otherwise generate scripts pointing at an empty DB when the
/// operator pre-set `BERTH_DATA_DIR` to a custom location.
pub fn resolve_effective_data_dir(tauri_fallback: &Path) -> PathBuf {
    if let Some(custom) = std::env::var_os("BERTH_DATA_DIR").filter(|s| !s.is_empty()) {
        return crate::git::credential::absolutize(Path::new(&custom));
    }
    crate::git::credential::absolutize(tauri_fallback)
}

// Path resolution depends on global env vars (`BERTH_HOME`, `BERTH_DATA_DIR`),
// so unit tests would need cross-test serialization to avoid races. The
// behaviour is covered end-to-end by the filesystem feature tests which set
// `BERTH_HOME`
// inside a serialized test mutex; we deliberately don't duplicate that here.

#[cfg(test)]
mod tests {
    #[test]
    fn default_home_uses_berth_directory() {
        if std::env::var_os("BERTH_HOME").is_some() {
            return;
        }
        let path = super::berth_home_dir();
        assert_eq!(path.file_name(), Some(std::ffi::OsStr::new(".berth")));
    }

    #[test]
    fn env_var_reads_only_berth_prefix() {
        temp_env::with_vars(
            [("BERTH_PORT", None::<&str>), ("CODEG_PORT", Some("9999"))],
            || {
                assert_eq!(super::env_var("PORT"), None);
            },
        );
        temp_env::with_var("BERTH_PORT", Some("3080"), || {
            assert_eq!(super::env_var("PORT").as_deref(), Some("3080"));
        });
    }

    #[test]
    fn reject_legacy_operator_env_fails_when_only_codeg_set() {
        temp_env::with_vars(
            [
                ("BERTH_TOKEN", None::<&str>),
                ("CODEG_TOKEN", Some("secret-must-not-appear")),
            ],
            || {
                let err = super::reject_legacy_operator_env("TOKEN").unwrap_err();
                assert_eq!(err, "CODEG_TOKEN is no longer supported; set BERTH_TOKEN");
                assert!(!err.contains("secret"));
            },
        );
    }

    #[test]
    fn reject_legacy_operator_env_ok_when_berth_set() {
        temp_env::with_vars(
            [("BERTH_TOKEN", Some("new")), ("CODEG_TOKEN", Some("old"))],
            || {
                assert!(super::reject_legacy_operator_env("TOKEN").is_ok());
                assert_eq!(super::env_var("TOKEN").as_deref(), Some("new"));
            },
        );
    }

    #[test]
    fn reject_legacy_operator_env_ok_when_neither_set() {
        temp_env::with_vars(
            [("BERTH_HOST", None::<&str>), ("CODEG_HOST", None::<&str>)],
            || {
                assert!(super::reject_legacy_operator_env("HOST").is_ok());
            },
        );
    }

    #[test]
    fn uploads_and_logs_follow_data_dir_when_home_differs() {
        temp_env::with_vars(
            [
                ("BERTH_HOME", Some("/tmp/berth-home-assets")),
                ("BERTH_DATA_DIR", Some("/tmp/berth-data-app")),
            ],
            || {
                assert_eq!(
                    super::berth_uploads_root(),
                    std::path::PathBuf::from("/tmp/berth-data-app/uploads")
                );
                assert_eq!(
                    super::berth_logs_root(),
                    std::path::PathBuf::from("/tmp/berth-data-app/logs")
                );
                assert_eq!(
                    super::berth_home_dir(),
                    std::path::PathBuf::from("/tmp/berth-home-assets")
                );
            },
        );
    }
}
