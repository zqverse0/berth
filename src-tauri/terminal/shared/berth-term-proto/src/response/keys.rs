use serde::{Deserialize, Serialize};

use crate::PaneTarget;

/// Response payload for `copy-mode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopyModeResponse {
    /// The pane whose mode state changed.
    pub target: PaneTarget,
    /// Whether copy-mode remains active after the command.
    pub active: bool,
    /// Whether the pane is currently in read-only view mode.
    pub view_mode: bool,
}
