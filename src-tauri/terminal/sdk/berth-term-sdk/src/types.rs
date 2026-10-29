//! SDK type vocabulary.
//!
//! Identity newtypes are defined exactly once in `berth-term-proto`. This module
//! re-exports the four authoritative identity types (`SessionName`,
//! `SessionId`, `WindowId`, `PaneId`) so SDK users never have to depend on
//! `berth-term-engine`, `berth-term-server`, `berth-cli`, or `berth-term-pty` to obtain
//! them. The SDK does not redeclare these newtypes; `berth-term-proto` is the
//! single public home for the identity vocabulary.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use berth_term_proto::{PaneId, SessionId, SessionName, WindowId};

/// Selects the daemon endpoint resolution strategy used by the SDK.
///
/// `Default` defers to SDK runtime discovery, falling through to platform
/// defaults resolved through the existing Berth terminal IPC/OS layer when no SDK
/// environment override is accepted. The explicit variants carry
/// caller-supplied paths/names and bypass the auto-discovery allowlist while
/// still preserving the daemon's own permission and symlink checks.
///
/// Marked `#[non_exhaustive]` because additional transports (such as TCP
/// or test-harness in-memory pipes) are anticipated in later steps and
/// must be addable without breaking downstream pattern matches.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[non_exhaustive]
pub enum TerminalEndpoint {
    /// Resolve through SDK discovery, falling through to the platform default.
    #[default]
    Default,
    /// Use an explicit Unix domain socket path.
    UnixSocket(PathBuf),
    /// Use an explicit Windows named pipe identifier.
    WindowsPipe(String),
}

impl TerminalEndpoint {
    /// Returns `true` when this endpoint defers to platform default
    /// resolution.
    #[must_use]
    pub fn is_default(&self) -> bool {
        matches!(self, Self::Default)
    }
}

/// Terminal geometry carried by SDK value objects.
///
/// This is an inert DTO. Converting it to the protocol type does not inspect
/// the caller's terminal or normalize zero dimensions.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TerminalSizeSpec {
    /// Requested terminal columns.
    pub cols: u16,
    /// Requested terminal rows.
    pub rows: u16,
}

impl TerminalSizeSpec {
    /// Creates a terminal-size DTO from explicit column and row counts.
    #[must_use]
    pub const fn new(cols: u16, rows: u16) -> Self {
        Self { cols, rows }
    }
}

impl From<TerminalSizeSpec> for berth_term_proto::TerminalSize {
    fn from(value: TerminalSizeSpec) -> Self {
        Self {
            cols: value.cols,
            rows: value.rows,
        }
    }
}

impl From<berth_term_proto::TerminalSize> for TerminalSizeSpec {
    fn from(value: berth_term_proto::TerminalSize) -> Self {
        Self {
            cols: value.cols,
            rows: value.rows,
        }
    }
}

/// Exact window selector used by SDK DTOs.
///
/// This type stores already-structured target components. It deliberately
/// performs no tmux target parsing or server-side lookup.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WindowRef {
    /// Exact session name component.
    pub session_name: SessionName,
    /// Exact window index component.
    pub window_index: u32,
}

impl WindowRef {
    /// Creates a window selector from explicit target components.
    #[must_use]
    pub fn new(session_name: SessionName, window_index: u32) -> Self {
        Self {
            session_name,
            window_index,
        }
    }

    /// Creates a selector for window index `0` in the given session.
    #[must_use]
    pub fn first(session_name: SessionName) -> Self {
        Self::new(session_name, 0)
    }

    /// Converts this selector to the matching protocol target DTO.
    #[must_use]
    pub fn to_proto(&self) -> berth_term_proto::WindowTarget {
        berth_term_proto::WindowTarget::with_window(self.session_name.clone(), self.window_index)
    }
}

impl From<WindowRef> for berth_term_proto::WindowTarget {
    fn from(value: WindowRef) -> Self {
        Self::with_window(value.session_name, value.window_index)
    }
}

impl From<berth_term_proto::WindowTarget> for WindowRef {
    fn from(value: berth_term_proto::WindowTarget) -> Self {
        Self {
            session_name: value.session_name().clone(),
            window_index: value.window_index(),
        }
    }
}

impl From<&WindowRef> for berth_term_proto::WindowTarget {
    fn from(value: &WindowRef) -> Self {
        value.to_proto()
    }
}

/// Exact pane selector used by SDK DTOs.
///
/// This type stores already-structured target components. It deliberately
/// performs no tmux target parsing or server-side lookup.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneRef {
    /// Exact session name component.
    pub session_name: SessionName,
    /// Exact window index component.
    pub window_index: u32,
    /// Exact pane index component.
    pub pane_index: u32,
}

impl PaneRef {
    /// Creates a pane selector from explicit target components.
    #[must_use]
    pub fn new(session_name: SessionName, window_index: u32, pane_index: u32) -> Self {
        Self {
            session_name,
            window_index,
            pane_index,
        }
    }

    /// Creates a selector in window index `0`.
    #[must_use]
    pub fn in_first_window(session_name: SessionName, pane_index: u32) -> Self {
        Self::new(session_name, 0, pane_index)
    }

    /// Parses an exact CLI pane target.
    ///
    /// Accepted forms are `session`, `session:window`, and
    /// `session:window.pane`. Omitted numeric components default to zero.
    pub fn parse_exact(value: impl AsRef<str>) -> Result<Self, berth_term_proto::TerminalError> {
        let value = value.as_ref();
        let (session, location) = match value.split_once(':') {
            Some(parts) => parts,
            None => (value, "0.0"),
        };
        let (window, pane) = match location.split_once('.') {
            Some(parts) => parts,
            None => (location, "0"),
        };
        let invalid_index = |component: &str| {
            berth_term_proto::TerminalError::invalid_target(value, format!("bad {component} index"))
        };
        let window_index = window.parse::<u32>().map_err(|_| invalid_index("window"))?;
        let pane_index = pane.parse::<u32>().map_err(|_| invalid_index("pane"))?;
        Ok(Self::new(
            SessionName::new(session)?,
            window_index,
            pane_index,
        ))
    }

    /// Converts this selector to the matching protocol target DTO.
    #[must_use]
    pub fn to_proto(&self) -> berth_term_proto::PaneTarget {
        berth_term_proto::PaneTarget::with_window(
            self.session_name.clone(),
            self.window_index,
            self.pane_index,
        )
    }
}

impl From<PaneRef> for berth_term_proto::PaneTarget {
    fn from(value: PaneRef) -> Self {
        Self::with_window(value.session_name, value.window_index, value.pane_index)
    }
}

impl From<berth_term_proto::PaneTarget> for PaneRef {
    fn from(value: berth_term_proto::PaneTarget) -> Self {
        Self {
            session_name: value.session_name().clone(),
            window_index: value.window_index(),
            pane_index: value.pane_index(),
        }
    }
}

impl From<&PaneRef> for berth_term_proto::PaneTarget {
    fn from(value: &PaneRef) -> Self {
        value.to_proto()
    }
}

/// Exact target selector used by SDK DTOs that accept multiple target forms.
///
/// The enum stores structured components only; it does not parse tmux target
/// strings or resolve ambiguous targets.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TargetRef {
    /// Exact session target.
    Session(SessionName),
    /// Exact window target.
    Window(WindowRef),
    /// Exact pane target.
    Pane(PaneRef),
}

impl From<TargetRef> for berth_term_proto::Target {
    fn from(value: TargetRef) -> Self {
        match value {
            TargetRef::Session(session_name) => Self::Session(session_name),
            TargetRef::Window(target) => Self::Window(target.into()),
            TargetRef::Pane(target) => Self::Pane(target.into()),
        }
    }
}

impl From<berth_term_proto::Target> for TargetRef {
    fn from(value: berth_term_proto::Target) -> Self {
        match value {
            berth_term_proto::Target::Session(session_name) => Self::Session(session_name),
            berth_term_proto::Target::Window(target) => Self::Window(target.into()),
            berth_term_proto::Target::Pane(target) => Self::Pane(target.into()),
        }
    }
}

impl From<&TargetRef> for berth_term_proto::Target {
    fn from(value: &TargetRef) -> Self {
        match value {
            TargetRef::Session(session_name) => Self::Session(session_name.clone()),
            TargetRef::Window(target) => Self::Window(target.into()),
            TargetRef::Pane(target) => Self::Pane(target.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PaneRef;

    #[test]
    fn exact_pane_targets_default_missing_components_to_zero() {
        let session = PaneRef::parse_exact("work").expect("session target");
        assert_eq!(session.session_name.as_str(), "work");
        assert_eq!((session.window_index, session.pane_index), (0, 0));

        let window = PaneRef::parse_exact("work:2").expect("window target");
        assert_eq!((window.window_index, window.pane_index), (2, 0));

        let pane = PaneRef::parse_exact("work:2.3").expect("pane target");
        assert_eq!((pane.window_index, pane.pane_index), (2, 3));
    }

    #[test]
    fn exact_pane_targets_reject_bad_indices() {
        let error = PaneRef::parse_exact("work:x.0").expect_err("bad window");
        assert!(error.to_string().contains("bad window index"));
    }
}
