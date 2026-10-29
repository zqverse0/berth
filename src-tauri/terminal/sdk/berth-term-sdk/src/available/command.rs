//! SDK command DTOs.
//!
//! Commands in this module are serializable value objects. They can be mapped
//! to `berth-term-proto` requests, but they do not send IPC, start daemons, probe
//! endpoints, or parse tmux command strings.

use serde::{Deserialize, Serialize};

use crate::{AttachSessionSpec, NewSessionSpec, RefreshClientSpec, SplitSpec, TerminalEndpoint};

/// Captured result from the official SDK command escape hatch.
///
/// [`crate::Terminal::cmd`] runs the `berth` binary with an endpoint selector
/// injected by the SDK. Non-zero process exits are returned here rather than
/// converted into SDK errors so callers can implement tmux-style command
/// wrappers with precise stdout, stderr, and status handling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct CommandRun {
    /// Captured stdout bytes.
    pub stdout: Vec<u8>,
    /// Captured stderr bytes.
    pub stderr: Vec<u8>,
    /// Process exit code, or `None` when the process terminated without a
    /// platform exit code.
    pub exit: Option<i32>,
}

/// A detached command payload accepted by the SDK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalCommandKind {
    /// A protocol request supplied directly by the caller.
    Request(berth_term_proto::Request),
    /// A `new-session` SDK spec.
    NewSession(NewSessionSpec),
    /// An `attach-session` SDK spec.
    AttachSession(AttachSessionSpec),
    /// A `split-window` SDK spec.
    SplitWindow(SplitSpec),
    /// A `refresh-client` SDK spec.
    RefreshClient(RefreshClientSpec),
}

impl TerminalCommandKind {
    /// Returns the stable public command name for this value object.
    #[must_use]
    pub fn command_name(&self) -> &'static str {
        match self {
            Self::Request(request) => request.command_name(),
            Self::NewSession(_) => "new-session",
            Self::AttachSession(_) => "attach-session",
            Self::SplitWindow(_) => "split-window",
            Self::RefreshClient(_) => "refresh-client",
        }
    }

    /// Converts this value object into the corresponding protocol request.
    #[must_use]
    pub fn into_request(self) -> berth_term_proto::Request {
        self.into()
    }
}

impl From<berth_term_proto::Request> for TerminalCommandKind {
    fn from(value: berth_term_proto::Request) -> Self {
        Self::Request(value)
    }
}

impl From<NewSessionSpec> for TerminalCommandKind {
    fn from(value: NewSessionSpec) -> Self {
        Self::NewSession(value)
    }
}

impl From<AttachSessionSpec> for TerminalCommandKind {
    fn from(value: AttachSessionSpec) -> Self {
        Self::AttachSession(value)
    }
}

impl From<SplitSpec> for TerminalCommandKind {
    fn from(value: SplitSpec) -> Self {
        Self::SplitWindow(value)
    }
}

impl From<RefreshClientSpec> for TerminalCommandKind {
    fn from(value: RefreshClientSpec) -> Self {
        Self::RefreshClient(value)
    }
}

impl From<TerminalCommandKind> for berth_term_proto::Request {
    fn from(value: TerminalCommandKind) -> Self {
        match value {
            TerminalCommandKind::Request(request) => request,
            TerminalCommandKind::NewSession(spec) => Self::NewSessionExt(Box::new(spec.into())),
            TerminalCommandKind::AttachSession(spec) => {
                Self::AttachSessionExt2(Box::new(spec.into()))
            }
            TerminalCommandKind::SplitWindow(spec) => Self::SplitWindowExt(Box::new(spec.into())),
            TerminalCommandKind::RefreshClient(spec) => Self::RefreshClient(Box::new(spec.into())),
        }
    }
}

impl From<NewSessionSpec> for berth_term_proto::Request {
    fn from(value: NewSessionSpec) -> Self {
        TerminalCommandKind::from(value).into()
    }
}

impl From<AttachSessionSpec> for berth_term_proto::Request {
    fn from(value: AttachSessionSpec) -> Self {
        TerminalCommandKind::from(value).into()
    }
}

impl From<SplitSpec> for berth_term_proto::Request {
    fn from(value: SplitSpec) -> Self {
        TerminalCommandKind::from(value).into()
    }
}

impl From<RefreshClientSpec> for berth_term_proto::Request {
    fn from(value: RefreshClientSpec) -> Self {
        TerminalCommandKind::from(value).into()
    }
}

/// Endpoint-scoped SDK command DTO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCommand {
    /// Endpoint selector associated with this command.
    #[serde(default)]
    pub endpoint: TerminalEndpoint,
    /// Inert command payload.
    pub command: TerminalCommandKind,
}

impl TerminalCommand {
    /// Creates a command using the platform default endpoint selector.
    #[must_use]
    pub fn new(command: impl Into<TerminalCommandKind>) -> Self {
        Self {
            endpoint: TerminalEndpoint::default(),
            command: command.into(),
        }
    }

    /// Creates a command using an explicit endpoint selector.
    #[must_use]
    pub fn with_endpoint(
        endpoint: TerminalEndpoint,
        command: impl Into<TerminalCommandKind>,
    ) -> Self {
        Self {
            endpoint,
            command: command.into(),
        }
    }

    /// Returns the stable public command name for the command payload.
    #[must_use]
    pub fn command_name(&self) -> &'static str {
        self.command.command_name()
    }

    /// Converts the command payload into its protocol request.
    #[must_use]
    pub fn into_request(self) -> berth_term_proto::Request {
        self.command.into_request()
    }
}

impl From<TerminalCommandKind> for TerminalCommand {
    fn from(value: TerminalCommandKind) -> Self {
        Self::new(value)
    }
}

impl From<berth_term_proto::Request> for TerminalCommand {
    fn from(value: berth_term_proto::Request) -> Self {
        Self::new(value)
    }
}

impl From<NewSessionSpec> for TerminalCommand {
    fn from(value: NewSessionSpec) -> Self {
        Self::new(value)
    }
}

impl From<AttachSessionSpec> for TerminalCommand {
    fn from(value: AttachSessionSpec) -> Self {
        Self::new(value)
    }
}

impl From<SplitSpec> for TerminalCommand {
    fn from(value: SplitSpec) -> Self {
        Self::new(value)
    }
}

impl From<RefreshClientSpec> for TerminalCommand {
    fn from(value: RefreshClientSpec) -> Self {
        Self::new(value)
    }
}

impl From<TerminalCommand> for berth_term_proto::Request {
    fn from(value: TerminalCommand) -> Self {
        value.into_request()
    }
}
