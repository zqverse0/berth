//! Update capability descriptor reported through [`crate::update::state`].
//!
//! Historically this module carried the standalone-server updater's runtime
//! self-knowledge (supervisor detection, restart exit codes, `self_exe`); that
//! surface was retired with the server binary — only the capability enum
//! remains, kept as part of the serialized `AppUpdateState` contract.

/// How a restart after an update is carried out. Server-only in practice —
/// the desktop app relaunches itself with no supervisor, so its state
/// reports `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateCapability {
    /// Worker runs under our supervisor (PID 1 in Docker). Upgrade = swap
    /// files on disk, then exit; the supervisor relaunches.
    Supervised,
    /// Standalone, no supervisor. Upgrade = swap files, then re-exec self.
    Reexec,
}
