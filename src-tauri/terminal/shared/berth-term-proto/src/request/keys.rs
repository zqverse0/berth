use serde::{Deserialize, Serialize};

use crate::PaneTarget;

/// Request payload for `copy-mode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopyModeRequest {
    /// The optional target pane. When omitted, the active pane is used.
    pub target: Option<PaneTarget>,
    /// Whether copy-mode should start one page down.
    #[serde(default)]
    pub page_down: bool,
    /// Whether scroll exit should be enabled when entering the mode.
    #[serde(default)]
    pub exit_on_scroll: bool,
    /// Whether the position indicator should be hidden.
    #[serde(default)]
    pub hide_position: bool,
    /// Whether the command originated from a mouse drag start.
    #[serde(default)]
    pub mouse_drag_start: bool,
    /// Whether all active pane modes should be cancelled instead of entering.
    #[serde(default)]
    pub cancel_mode: bool,
    /// Whether the command originated from scrollbar scrolling.
    #[serde(default)]
    pub scrollbar_scroll: bool,
    /// Optional source pane whose screen should back the copy-mode view.
    #[serde(default)]
    pub source: Option<PaneTarget>,
    /// Whether copy-mode should start one page up.
    #[serde(default)]
    pub page_up: bool,
}
