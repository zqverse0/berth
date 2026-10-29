//! Shared protocol error types.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{PaneId, SessionName};

/// Stable daemon message when a respawn refuses to replace a live pane.
pub const PANE_STILL_ACTIVE_MESSAGE: &str = "pane still active; use -k to force respawn";
/// Stable daemon message prefix for pane process spawn failures.
pub const SPAWN_FAILED_MESSAGE_PREFIX: &str = "failed to spawn pane";
/// Stable daemon message when a structured process command is empty.
pub const PROCESS_COMMAND_EMPTY_MESSAGE: &str = "process command must not be empty";
/// Stable daemon message prefix for owned-session lease loss.
pub const OWNED_SESSION_LEASE_LOST_MESSAGE_PREFIX: &str = "owned session lease lost";

/// Shared protocol and validation errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Error)]
pub enum TerminalError {
    /// A session name was empty.
    #[error("invalid session name: session names must be non-empty")]
    EmptySessionName,
    /// A session name contained `:` or `.`.
    #[error("invalid session name: session names must not contain ':' or '.'")]
    InvalidSessionNameCharacter,
    /// A target string failed exact detached parsing.
    #[error("invalid target '{value}': {reason}")]
    InvalidTarget {
        /// The original target string.
        value: String,
        /// The validation failure reason.
        reason: String,
    },
    /// An unsupported public command name was requested.
    #[error("unknown command: {0}")]
    UnknownCommand(String),
    /// A session name collided with an existing session.
    #[error("duplicate session: {0}")]
    DuplicateSession(String),
    /// A session target did not resolve.
    #[error("session not found: {0}")]
    SessionNotFound(String),
    /// The server encountered an unexpected runtime failure.
    #[error("server error: {0}")]
    Server(String),
    /// A command surfaced an exact tmux-compatible user-facing error.
    #[error("{0}")]
    Message(String),
    /// A `set-option` request violated the supported contract.
    #[error("invalid set-option request: {0}")]
    InvalidSetOption(String),
    /// A codec frame claimed a payload larger than the configured maximum.
    #[error("codec frame length {length} exceeds maximum {maximum}")]
    FrameTooLarge {
        /// The announced frame payload length.
        length: usize,
        /// The configured maximum payload length.
        maximum: usize,
    },
    /// A codec frame announced an empty payload.
    #[error("codec frame payloads must not be empty")]
    EmptyFrame,
    /// A frame did not start with the Berth terminal frame magic byte.
    #[error("bad RMUX frame magic: expected 0x52, got 0x{0:02x}")]
    BadFrameMagic(u8),
    /// A frame used a wire version this build does not support.
    #[error("unsupported RMUX wire version {got}; supported range is {minimum}..={maximum}")]
    UnsupportedWireVersion {
        /// The wire version advertised by the frame.
        got: u32,
        /// The minimum supported wire version.
        minimum: u32,
        /// The maximum supported wire version.
        maximum: u32,
    },
    /// A capability required by the caller is not supported by the daemon.
    #[error(
        "unsupported RMUX capability `{feature}`; supported capabilities: {}",
        supported.join(", ")
    )]
    UnsupportedCapability {
        /// Stable capability id requested by the caller.
        feature: String,
        /// Capability ids supported by the daemon.
        supported: Vec<String>,
    },
    /// A full frame was requested but the buffer stopped early.
    #[error("incomplete frame: expected {expected} payload bytes, received {received}")]
    IncompleteFrame {
        /// The payload bytes expected by the frame header.
        expected: usize,
        /// The payload bytes actually available.
        received: usize,
    },
    /// Bincode encoding failed.
    #[error("failed to encode frame payload: {0}")]
    Encode(String),
    /// Bincode decoding failed.
    #[error("failed to decode frame payload: {0}")]
    Decode(String),
    /// A stable pane id did not resolve in the addressed session.
    #[error("invalid target '{session_name}:{pane_id}': pane id does not exist in session")]
    PaneNotFound {
        /// Session searched for the pane id.
        session_name: SessionName,
        /// Stable pane id requested by the caller.
        pane_id: PaneId,
    },
    /// A pane still has a running process and replacement was not requested.
    #[error("{PANE_STILL_ACTIVE_MESSAGE}")]
    ProcessStillRunning,
    /// A daemon-side process spawn failed.
    #[error("{message}")]
    SpawnFailed {
        /// Spawn failure diagnostic.
        message: String,
    },
    /// A daemon-side owned-session lease was not found or no longer matches.
    #[error("{OWNED_SESSION_LEASE_LOST_MESSAGE_PREFIX} for {session_name}")]
    OwnedSessionLeaseLost {
        /// Session whose lease no longer exists or no longer matches.
        session_name: SessionName,
    },
    /// A captured runtime pane binding no longer matches the live daemon.
    #[error("pane binding is no longer valid: {reason}")]
    PaneBindingInvalid {
        /// Deterministic reason the binding stopped matching.
        reason: PaneBindingFailure,
    },
}

/// Deterministic reasons a captured runtime pane binding stopped being valid.
///
/// The variants are stable error codes shared by GUI and CLI so both surfaces
/// report the same failure for the same observation. They never mean "maybe":
/// an unobservable identity is [`PaneBindingFailure::Unverifiable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Error)]
pub enum PaneBindingFailure {
    /// The daemon instance the binding was captured from is gone.
    #[error("daemon instance changed")]
    StaleDaemon,
    /// The bound pane no longer exists in its session.
    #[error("pane no longer exists")]
    StalePane,
    /// The pane still exists but its process generation changed (respawn).
    #[error("pane process generation changed")]
    StaleGeneration,
    /// The connected daemon advertises no instance identity, so the captured
    /// binding cannot be re-verified.
    #[error("daemon instance unverifiable")]
    Unverifiable,
}

impl TerminalError {
    /// Creates an invalid-target error with a stable message shape.
    #[must_use]
    pub fn invalid_target(value: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::InvalidTarget {
            value: value.into(),
            reason: reason.into(),
        }
    }

    /// Creates a stable-pane missing error.
    #[must_use]
    pub fn pane_not_found(session_name: SessionName, pane_id: PaneId) -> Self {
        Self::PaneNotFound {
            session_name,
            pane_id,
        }
    }

    /// Creates a typed spawn failure.
    #[must_use]
    pub fn spawn_failed(message: impl Into<String>) -> Self {
        Self::SpawnFailed {
            message: message.into(),
        }
    }

    /// Creates a typed empty-process-command failure.
    #[must_use]
    pub fn empty_process_command() -> Self {
        Self::spawn_failed(PROCESS_COMMAND_EMPTY_MESSAGE)
    }

    /// Creates a typed owned-session lease-lost error.
    #[must_use]
    pub fn owned_session_lease_lost(session_name: SessionName) -> Self {
        Self::OwnedSessionLeaseLost { session_name }
    }

    /// Creates a deterministic invalid-pane-binding error.
    #[must_use]
    pub fn pane_binding_invalid(reason: PaneBindingFailure) -> Self {
        Self::PaneBindingInvalid { reason }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::size_of;

    fn bincode_tag(error: &TerminalError) -> u32 {
        let encoded = bincode::serialize(error).expect("error encodes");
        let tag = encoded
            .get(..4)
            .and_then(|bytes| bytes.try_into().ok())
            .expect("enum tag is encoded as leading u32");
        u32::from_le_bytes(tag)
    }

    #[test]
    fn display_messages_are_stable() {
        assert_eq!(
            TerminalError::EmptySessionName.to_string(),
            "invalid session name: session names must be non-empty"
        );
        assert_eq!(
            TerminalError::InvalidSessionNameCharacter.to_string(),
            "invalid session name: session names must not contain ':' or '.'"
        );
        assert_eq!(
            TerminalError::invalid_target("alpha:1", "only window index 0 is supported")
                .to_string(),
            "invalid target 'alpha:1': only window index 0 is supported"
        );
        assert_eq!(
            TerminalError::UnknownCommand("list-sessions".to_owned()).to_string(),
            "unknown command: list-sessions"
        );
        assert_eq!(
            TerminalError::DuplicateSession("Alpha".to_owned()).to_string(),
            "duplicate session: Alpha"
        );
        assert_eq!(
            TerminalError::SessionNotFound("Alpha".to_owned()).to_string(),
            "session not found: Alpha"
        );
        assert_eq!(
            TerminalError::pane_not_found(
                crate::SessionName::new("Alpha").expect("valid session"),
                crate::PaneId::new(7),
            )
            .to_string(),
            "invalid target 'Alpha:%7': pane id does not exist in session"
        );
        assert_eq!(
            TerminalError::ProcessStillRunning.to_string(),
            PANE_STILL_ACTIVE_MESSAGE
        );
        assert_eq!(
            TerminalError::empty_process_command().to_string(),
            PROCESS_COMMAND_EMPTY_MESSAGE
        );
        assert_eq!(
            TerminalError::owned_session_lease_lost(
                crate::SessionName::new("leased").expect("valid session"),
            )
            .to_string(),
            "owned session lease lost for leased"
        );
        assert_eq!(
            TerminalError::pane_binding_invalid(PaneBindingFailure::StaleDaemon).to_string(),
            "pane binding is no longer valid: daemon instance changed"
        );
        assert_eq!(
            TerminalError::pane_binding_invalid(PaneBindingFailure::StalePane).to_string(),
            "pane binding is no longer valid: pane no longer exists"
        );
        assert_eq!(
            TerminalError::pane_binding_invalid(PaneBindingFailure::StaleGeneration).to_string(),
            "pane binding is no longer valid: pane process generation changed"
        );
        assert_eq!(
            TerminalError::pane_binding_invalid(PaneBindingFailure::Unverifiable).to_string(),
            "pane binding is no longer valid: daemon instance unverifiable"
        );
        assert_eq!(
            TerminalError::Server("pty resize failed".to_owned()).to_string(),
            "server error: pty resize failed"
        );
        assert_eq!(
            TerminalError::Message("window only linked to one session".to_owned()).to_string(),
            "window only linked to one session"
        );
        assert_eq!(
            TerminalError::InvalidSetOption("status is not an array option".to_owned()).to_string(),
            "invalid set-option request: status is not an array option"
        );
        assert_eq!(
            TerminalError::FrameTooLarge {
                length: 2_000_000,
                maximum: 1_048_576
            }
            .to_string(),
            "codec frame length 2000000 exceeds maximum 1048576"
        );
        assert_eq!(
            TerminalError::EmptyFrame.to_string(),
            "codec frame payloads must not be empty"
        );
        assert_eq!(
            TerminalError::BadFrameMagic(0).to_string(),
            "bad RMUX frame magic: expected 0x52, got 0x00"
        );
        assert_eq!(
            TerminalError::UnsupportedWireVersion {
                got: 2,
                minimum: 1,
                maximum: 1,
            }
            .to_string(),
            "unsupported RMUX wire version 2; supported range is 1..=1"
        );
        assert_eq!(
            TerminalError::UnsupportedCapability {
                feature: "feature.experimental".to_owned(),
                supported: vec!["rpc.detached".to_owned(), "protocol.capabilities".to_owned()],
            }
            .to_string(),
            "unsupported RMUX capability `feature.experimental`; supported capabilities: rpc.detached, protocol.capabilities"
        );
        assert_eq!(
            TerminalError::IncompleteFrame {
                expected: 100,
                received: 50
            }
            .to_string(),
            "incomplete frame: expected 100 payload bytes, received 50"
        );
        assert_eq!(
            TerminalError::Encode("bincode error".to_owned()).to_string(),
            "failed to encode frame payload: bincode error"
        );
        assert_eq!(
            TerminalError::Decode("bincode error".to_owned()).to_string(),
            "failed to decode frame payload: bincode error"
        );
    }

    #[test]
    fn bincode_tags_append_new_variants_after_v1_errors() {
        assert_eq!(bincode_tag(&TerminalError::EmptySessionName), 0);
        assert_eq!(bincode_tag(&TerminalError::InvalidSessionNameCharacter), 1);
        assert_eq!(
            bincode_tag(&TerminalError::invalid_target("alpha:1", "missing pane")),
            2
        );
        assert_eq!(
            bincode_tag(&TerminalError::UnknownCommand("run".to_owned())),
            3
        );
        assert_eq!(
            bincode_tag(&TerminalError::DuplicateSession("alpha".to_owned())),
            4
        );
        assert_eq!(
            bincode_tag(&TerminalError::SessionNotFound("alpha".to_owned())),
            5
        );
        assert_eq!(bincode_tag(&TerminalError::Server("failed".to_owned())), 6);
        assert_eq!(bincode_tag(&TerminalError::Message("failed".to_owned())), 7);
        assert_eq!(
            bincode_tag(&TerminalError::InvalidSetOption("status".to_owned())),
            8
        );
        assert_eq!(
            bincode_tag(&TerminalError::FrameTooLarge {
                length: 2,
                maximum: 1,
            }),
            9
        );
        assert_eq!(bincode_tag(&TerminalError::EmptyFrame), 10);
        assert_eq!(bincode_tag(&TerminalError::BadFrameMagic(0)), 11);
        assert_eq!(
            bincode_tag(&TerminalError::UnsupportedWireVersion {
                got: 2,
                minimum: 1,
                maximum: 1,
            }),
            12
        );
        assert_eq!(
            bincode_tag(&TerminalError::UnsupportedCapability {
                feature: "future".to_owned(),
                supported: vec![],
            }),
            13
        );
        assert_eq!(
            bincode_tag(&TerminalError::IncompleteFrame {
                expected: 2,
                received: 1,
            }),
            14
        );
        assert_eq!(bincode_tag(&TerminalError::Encode("failed".to_owned())), 15);
        assert_eq!(bincode_tag(&TerminalError::Decode("failed".to_owned())), 16);

        assert_eq!(
            bincode_tag(&TerminalError::pane_not_found(
                SessionName::new("alpha").expect("valid session"),
                PaneId::new(7),
            )),
            17
        );
        assert_eq!(bincode_tag(&TerminalError::ProcessStillRunning), 18);
        assert_eq!(bincode_tag(&TerminalError::spawn_failed("failed")), 19);
        assert_eq!(
            bincode_tag(&TerminalError::owned_session_lease_lost(
                SessionName::new("alpha").expect("valid session"),
            )),
            20
        );
        assert_eq!(
            bincode_tag(&TerminalError::pane_binding_invalid(
                PaneBindingFailure::Unverifiable
            )),
            21
        );
    }

    #[test]
    fn pr6g_error_size_stays_bounded_without_boxing_named_variants() {
        assert_eq!(
            size_of::<TerminalError>(),
            56,
            "TerminalError is below the PR6G response-size bound; keep named variants unboxed here"
        );
        assert_eq!(size_of::<Box<String>>(), 8);
        assert!(size_of::<SessionName>() <= size_of::<TerminalError>());
        assert!(size_of::<PaneId>() < size_of::<TerminalError>());
    }
}
