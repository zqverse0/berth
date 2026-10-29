//! Inert pane event DTOs for SDK consumers.
//!
//! This module is the public SDK home for the tmux-compatible control-mode
//! pane event vocabulary. The [`types`] submodule defines the
//! [`PaneEvent`] enum and its leaf payloads; the parent
//! crate re-exports the public surface unchanged so SDK users import every
//! variant through `berth_term_sdk` without ever depending on `berth-term-engine`,
//! `berth-term-server`, `berth-cli`, or `berth-term-pty`.
//!
//! The events here are *inert* DTOs. The SDK does not subscribe to,
//! resequence, or emit these events; the `berth-term-server` control-mode
//! plumbing in `terminal/daemon/berth-term-server/src/control.rs` is the authoritative
//! producer, and the daemon-side ordering rules documented on
//! [`PaneEvent`] match that producer's behaviour.

#[cfg(feature = "available")]
pub mod render;
pub mod streams;
pub mod types;

#[cfg(feature = "available")]
pub use render::{PaneRenderStream, RenderUpdate};
pub use streams::{
    PaneLagNotice, PaneOutputChunk, PaneOutputStart, PaneOutputStream, PaneRecentOutput,
};
#[cfg(feature = "available")]
pub use streams::{PaneLineItem, PaneLineStream};
pub use types::{
    PaneCommandStatus, PaneCommandSummary, PaneDisconnectReason, PaneEvent, PaneExitReason,
    PaneNotification, PanePermissionScope,
};
