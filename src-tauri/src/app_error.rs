use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use berth_project_core::error::DbError;

// ─── Shared i18n keys ─────────────────────────────────────────────────
//
// The wire-format strings that backend errors stamp via `with_i18n` and
// the frontend branches on via `extractAppCommandError(err).i18n_key`.
// They live here so multiple emitters and a single TS branch stay aligned.
//
// **MUST stay in lockstep with the TypeScript constants** in
// `src/lib/api.ts` (`UPLOAD_I18N_KEY_TOO_LARGE` /
// `UPLOAD_I18N_KEY_NOT_A_FILE`).

/// Error key emitted when an upload payload exceeds `UPLOAD_MAX_BYTES`.
/// Frontend params: `size`, `limit`.
#[allow(dead_code)] // kept for frontend wire-format parity after remote upload removal
pub const UPLOAD_I18N_KEY_TOO_LARGE: &str = "errors.upload.tooLarge";

/// Error key emitted when an upload path is not a regular file. No params.
#[allow(dead_code)] // kept for frontend wire-format parity after remote upload removal
pub const UPLOAD_I18N_KEY_NOT_A_FILE: &str = "errors.upload.notAFile";

// ─── Backup / restore i18n keys ──────────────────────────────────────
//
// Emitted by `commands::backup::*` and consumed by `BackupSettings` on the
// frontend. MUST stay in lockstep with the TS constants in
// `src/lib/api.ts`. No-param keys unless noted.

/// Decryption failed the GCM tag — wrong passphrase or a tampered/corrupt
/// archive (the two are cryptographically indistinguishable).
pub const BACKUP_I18N_KEY_BAD_PASSPHRASE: &str = "backup.restore.error.badPassphrase";
/// A backup entry's bytes did not match the manifest checksum.
pub const BACKUP_I18N_KEY_CORRUPTED: &str = "backup.restore.error.corrupted";
/// The file is not a codeg backup, or its `format_version` is newer than this
/// binary understands.
pub const BACKUP_I18N_KEY_UNKNOWN_FORMAT: &str = "backup.restore.error.unknownFormat";
/// The backup was taken by a newer app version whose DB schema this binary
/// cannot represent. Params: `backupVersion`, `appVersion`.
pub const BACKUP_I18N_KEY_NEWER_VERSION: &str = "backup.restore.error.newerVersion";
/// Ran out of disk space while writing the archive / staging a restore.
pub const BACKUP_I18N_KEY_DISK_SPACE: &str = "backup.error.diskSpace";
/// The operation was cancelled by the user.
pub const BACKUP_I18N_KEY_CANCELLED: &str = "backup.error.cancelled";
/// A restore is already staged and awaiting restart; only one at a time.
pub const BACKUP_I18N_KEY_ALREADY_PENDING: &str = "backup.restore.error.alreadyPending";

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppErrorCode {
    InvalidInput,
    ConfigurationMissing,
    ConfigurationInvalid,
    NotFound,
    NotAGitRepository,
    AlreadyExists,
    PermissionDenied,
    DependencyMissing,
    NetworkError,
    AuthenticationFailed,
    DatabaseError,
    IoError,
    ExternalCommandFailed,
    WindowOperationFailed,
    TaskExecutionFailed,
    ResourceCapacity,
    /// A prompt was rejected because a turn is already in flight on the
    /// connection (a second, concurrent send). Maps to HTTP 409 — an expected,
    /// recoverable condition in multi-client co-control, not a server fault.
    TurnInProgress,
    /// A legacy client attempted to overwrite shared state containing a
    /// resource kind it cannot represent.
    ClientUpgradeRequired,
    TerminalNotFound,
    TerminalInstanceExpired,
    TerminalExited,
    TerminalLimitReached,
    InvalidWorkingDirectory,
    ShellNotFound,
    InputOutOfOrder,
    InputBackpressure,
    SequenceGap,
    SnapshotUnavailable,
    TerminalTransportDisconnected,
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct AppCommandError {
    pub code: AppErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Optional dotted i18n key (e.g. `"mcp.errors.unsupportedType"`) the
    /// frontend can use to render a localized message. When absent, the
    /// frontend falls back to `message` (English).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n_key: Option<String>,
    /// Optional named parameters substituted into the localized template.
    /// All values are pre-stringified so the wire format stays JSON-safe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n_params: Option<BTreeMap<String, String>>,
}

impl AppCommandError {
    pub fn new(code: AppErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            i18n_key: None,
            i18n_params: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Attach a localized rendering hint. The frontend prefers this over
    /// `message` when displaying the error to the user. `params` may be empty.
    pub fn with_i18n(mut self, key: impl Into<String>, params: BTreeMap<String, String>) -> Self {
        self.i18n_key = Some(key.into());
        if !params.is_empty() {
            self.i18n_params = Some(params);
        }
        self
    }

    pub fn db(err: DbError) -> Self {
        Self::new(AppErrorCode::DatabaseError, "Database operation failed")
            .with_detail(err.to_string())
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::InvalidInput, message)
    }

    pub fn configuration_missing(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ConfigurationMissing, message)
    }

    pub fn configuration_invalid(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ConfigurationInvalid, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::NotFound, message)
    }

    pub fn not_a_git_repository(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::NotAGitRepository, message)
    }

    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::AlreadyExists, message)
    }

    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::PermissionDenied, message)
    }

    pub fn dependency_missing(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::DependencyMissing, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::NetworkError, message)
    }

    pub fn authentication_failed(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::AuthenticationFailed, message)
    }

    pub fn database_error(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::DatabaseError, message)
    }

    pub fn io_error(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::IoError, message)
    }

    pub fn task_execution_failed(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::TaskExecutionFailed, message)
    }

    pub fn resource_capacity(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ResourceCapacity, message)
    }

    pub fn io(err: std::io::Error) -> Self {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => AppErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => AppErrorCode::PermissionDenied,
            std::io::ErrorKind::AlreadyExists => AppErrorCode::AlreadyExists,
            _ => AppErrorCode::IoError,
        };

        let message = match code {
            AppErrorCode::NotFound => "Resource not found",
            AppErrorCode::PermissionDenied => "Permission denied",
            AppErrorCode::AlreadyExists => "Resource already exists",
            _ => "I/O operation failed",
        };

        Self::new(code, message).with_detail(err.to_string())
    }

    pub fn window(message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(AppErrorCode::WindowOperationFailed, message).with_detail(detail)
    }

    pub fn external_command(message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ExternalCommandFailed, message).with_detail(detail)
    }
}

impl From<DbError> for AppCommandError {
    fn from(value: DbError) -> Self {
        Self::db(value)
    }
}

impl From<crate::terminal::error::TerminalErrorCode> for AppCommandError {
    fn from(value: crate::terminal::error::TerminalErrorCode) -> Self {
        use crate::terminal::error::TerminalErrorCode;

        let code = match value {
            TerminalErrorCode::AuthenticationFailed => AppErrorCode::AuthenticationFailed,
            TerminalErrorCode::TerminalNotFound => AppErrorCode::TerminalNotFound,
            TerminalErrorCode::TerminalInstanceExpired => AppErrorCode::TerminalInstanceExpired,
            TerminalErrorCode::TerminalExited => AppErrorCode::TerminalExited,
            TerminalErrorCode::TerminalLimitReached => AppErrorCode::TerminalLimitReached,
            TerminalErrorCode::InvalidWorkingDirectory => AppErrorCode::InvalidWorkingDirectory,
            TerminalErrorCode::ShellNotFound => AppErrorCode::ShellNotFound,
            TerminalErrorCode::InputOutOfOrder => AppErrorCode::InputOutOfOrder,
            TerminalErrorCode::InputBackpressure => AppErrorCode::InputBackpressure,
            TerminalErrorCode::SequenceGap => AppErrorCode::SequenceGap,
            TerminalErrorCode::SnapshotUnavailable => AppErrorCode::SnapshotUnavailable,
            TerminalErrorCode::TerminalTransportDisconnected => {
                AppErrorCode::TerminalTransportDisconnected
            }
        };
        Self::new(code, value_message(value))
    }
}

impl From<crate::terminal::error::TerminalError> for AppCommandError {
    fn from(value: crate::terminal::error::TerminalError) -> Self {
        use crate::terminal::error::TerminalError;

        match value {
            TerminalError::NotFound(terminal_id) => Self::new(
                AppErrorCode::TerminalNotFound,
                "Terminal session was not found",
            )
            .with_detail(terminal_id),
            TerminalError::Exited(terminal_id) => {
                Self::new(AppErrorCode::TerminalExited, "Terminal session has exited")
                    .with_detail(terminal_id)
            }
            TerminalError::LimitReached => Self::new(
                AppErrorCode::TerminalLimitReached,
                "Terminal session limit reached",
            ),
            TerminalError::InvalidWorkingDirectory(path) => Self::new(
                AppErrorCode::InvalidWorkingDirectory,
                "Terminal working directory is invalid",
            )
            .with_detail(path),
            TerminalError::ShellNotFound(shell) => {
                Self::new(AppErrorCode::ShellNotFound, "Terminal shell was not found")
                    .with_detail(shell)
            }
            TerminalError::StillRunning(terminal_id) => {
                Self::invalid_input("Terminal session must exit before its record can be removed")
                    .with_detail(terminal_id)
            }
            TerminalError::SpawnFailed(detail) => {
                Self::task_execution_failed("Failed to create terminal session").with_detail(detail)
            }
            TerminalError::WriteFailed(detail) => {
                Self::task_execution_failed("Failed to write terminal input").with_detail(detail)
            }
            TerminalError::ResizeFailed(detail) => {
                Self::task_execution_failed("Failed to resize terminal").with_detail(detail)
            }
            TerminalError::TerminationFailed(detail) => {
                Self::task_execution_failed("Failed to terminate terminal session")
                    .with_detail(detail)
            }
            TerminalError::RuntimeUnavailable(detail) => Self::new(
                AppErrorCode::TerminalNotFound,
                "Terminal session was not found",
            )
            .with_detail(detail),
            TerminalError::Incompatible(detail) => {
                Self::task_execution_failed("Terminal daemon is incompatible").with_detail(detail)
            }
            TerminalError::InputBackpressure => Self::new(
                AppErrorCode::InputBackpressure,
                "Terminal input queue is full",
            ),
            TerminalError::InstanceExpired(reason) => Self::new(
                AppErrorCode::TerminalInstanceExpired,
                "Terminal server instance has expired",
            )
            .with_detail(reason),
        }
    }
}

impl From<crate::terminal::manager::TerminalOperationError> for AppCommandError {
    fn from(value: crate::terminal::manager::TerminalOperationError) -> Self {
        match value {
            crate::terminal::manager::TerminalOperationError::Protocol(error) => error.into(),
            crate::terminal::manager::TerminalOperationError::Runtime(error) => error.into(),
        }
    }
}

fn value_message(value: crate::terminal::error::TerminalErrorCode) -> &'static str {
    use crate::terminal::error::TerminalErrorCode;

    match value {
        TerminalErrorCode::AuthenticationFailed => "Terminal authentication failed",
        TerminalErrorCode::TerminalNotFound => "Terminal session was not found",
        TerminalErrorCode::TerminalInstanceExpired => "Terminal server instance has expired",
        TerminalErrorCode::TerminalExited => "Terminal session has exited",
        TerminalErrorCode::TerminalLimitReached => "Terminal session limit reached",
        TerminalErrorCode::InvalidWorkingDirectory => "Terminal working directory is invalid",
        TerminalErrorCode::ShellNotFound => "Terminal shell was not found",
        TerminalErrorCode::InputOutOfOrder => "Terminal input sequence is out of order",
        TerminalErrorCode::InputBackpressure => "Terminal input queue is full",
        TerminalErrorCode::SequenceGap => "Terminal output sequence has a gap",
        TerminalErrorCode::SnapshotUnavailable => "Terminal snapshot is unavailable",
        TerminalErrorCode::TerminalTransportDisconnected => "Terminal transport is disconnected",
    }
}
