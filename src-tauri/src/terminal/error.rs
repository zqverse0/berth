use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalErrorCode {
    AuthenticationFailed,
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

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to spawn terminal: {0}")]
    SpawnFailed(String),
    #[error("terminal not found: {0}")]
    NotFound(String),
    #[error("terminal write error: {0}")]
    WriteFailed(String),
    #[error("terminal resize error: {0}")]
    ResizeFailed(String),
    #[error("terminal has already exited: {0}")]
    Exited(String),
    #[error("terminal is still running: {0}")]
    StillRunning(String),
    #[error("terminal limit reached")]
    LimitReached,
    #[error("invalid terminal working directory: {0}")]
    InvalidWorkingDirectory(String),
    #[error("terminal shell was not found: {0}")]
    ShellNotFound(String),
    #[error("terminal termination failed: {0}")]
    TerminationFailed(String),
    #[error("terminal runtime is unavailable: {0}")]
    RuntimeUnavailable(String),
    #[error("terminal daemon is incompatible: {0}")]
    Incompatible(String),
    #[error("terminal input queue is full")]
    InputBackpressure,
    /// The stored pane binding no longer identifies the same running entity
    /// (daemon restarted, pane closed, or pane respawned). Never silently
    /// re-resolve to the slot: the caller must surface a reset to the user.
    #[error("terminal pane binding expired: {0}")]
    InstanceExpired(String),
}

impl Serialize for TerminalError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
