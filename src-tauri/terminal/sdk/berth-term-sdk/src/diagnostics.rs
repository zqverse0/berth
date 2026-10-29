//! SDK diagnostics and stable unsupported-feature identifiers.
//!
//! This module depends only on `berth-term-proto` and SDK-local types. It is safe to
//! use from integration code without pulling in client or server crates.

/// Stable SDK feature id for unsupported detached wire versions.
pub const FEATURE_PROTOCOL_WIRE_VERSION: &str = "protocol.wire_version";
/// Stable SDK feature id for daemon capability negotiation support.
pub const FEATURE_PROTOCOL_CAPABILITIES: &str = berth_term_proto::CAPABILITY_HANDSHAKE;
/// Stable SDK feature id for Unix-domain socket transport support.
pub const FEATURE_TRANSPORT_UNIX_SOCKET: &str = "transport.unix_socket";
/// Stable SDK feature id for Windows named-pipe transport support.
pub const FEATURE_TRANSPORT_WINDOWS_PIPE: &str = "transport.windows_pipe";
/// Stable SDK feature id for explicit daemon shutdown.
pub const FEATURE_DAEMON_SHUTDOWN: &str = berth_term_proto::CAPABILITY_DAEMON_SHUTDOWN;

/// Severity of an SDK diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DiagnosticSeverity {
    /// A requested feature is unavailable with the connected daemon.
    Unsupported,
    /// A protocol or transport error prevented the operation from completing.
    Error,
}

/// Structured SDK diagnostic suitable for logs and UI surfaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    severity: DiagnosticSeverity,
    feature: Option<String>,
    message: String,
    hint: Option<String>,
}

impl Diagnostic {
    /// Creates a diagnostic for an unsupported feature id.
    #[must_use]
    pub fn unsupported(feature: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            severity: DiagnosticSeverity::Unsupported,
            feature: Some(feature.into()),
            message: "unsupported Berth feature".to_owned(),
            hint: Some(hint.into()),
        }
    }

    /// Creates an error diagnostic without an unsupported-feature id.
    #[must_use]
    pub fn error(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            severity: DiagnosticSeverity::Error,
            feature: None,
            message: message.into(),
            hint: Some(hint.into()),
        }
    }

    /// Returns the diagnostic severity.
    #[must_use]
    pub const fn severity(&self) -> DiagnosticSeverity {
        self.severity
    }

    /// Returns the stable unsupported-feature id, when available.
    #[must_use]
    pub fn feature(&self) -> Option<&str> {
        self.feature.as_deref()
    }

    /// Returns the diagnostic message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Returns the recovery hint, when available.
    #[must_use]
    pub fn hint(&self) -> Option<&str> {
        self.hint.as_deref()
    }
}

/// Returns the stable SDK unsupported-feature id for a protocol error.
#[must_use]
pub fn unsupported_feature_id(error: &berth_term_proto::TerminalError) -> Option<String> {
    match error {
        berth_term_proto::TerminalError::UnsupportedWireVersion { .. } => {
            Some(FEATURE_PROTOCOL_WIRE_VERSION.to_owned())
        }
        berth_term_proto::TerminalError::UnsupportedCapability { feature, .. } => {
            Some(feature.clone())
        }
        berth_term_proto::TerminalError::UnknownCommand(command) => {
            Some(command_feature_id(command))
        }
        _ => None,
    }
}

/// Converts a protocol error into an SDK diagnostic.
#[must_use]
pub fn protocol_diagnostic(error: &berth_term_proto::TerminalError) -> Diagnostic {
    match error {
        berth_term_proto::TerminalError::UnsupportedWireVersion {
            got,
            minimum,
            maximum,
        } => Diagnostic::unsupported(
            FEATURE_PROTOCOL_WIRE_VERSION,
            format!(
                "upgrade the Berth terminal daemon or use an SDK that supports wire version {got} \
                 (supported range {minimum}..={maximum})"
            ),
        ),
        berth_term_proto::TerminalError::UnsupportedCapability { feature, supported } => {
            Diagnostic::unsupported(
                feature.clone(),
                unsupported_capability_hint(feature, supported),
            )
        }
        berth_term_proto::TerminalError::UnknownCommand(command) => Diagnostic::unsupported(
            command_feature_id(command),
            format!(
                "upgrade the Berth terminal daemon or use a command advertised by the negotiated command \
                 inventory before sending `{command}`"
            ),
        ),
        error => Diagnostic::error(
            format!("Berth protocol error: {error}"),
            "check the request and daemon state, then retry after correcting the request",
        ),
    }
}

/// Builds the stable SDK feature id for an unsupported command name.
#[must_use]
pub fn command_feature_id(command: &str) -> String {
    let token = command
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => character,
            _ => '_',
        })
        .collect::<String>();

    if token.is_empty() {
        "command.<empty>".to_owned()
    } else {
        format!("command.{token}")
    }
}

/// Builds a visible recovery hint for an unsupported capability.
#[must_use]
pub fn unsupported_capability_hint(feature: &str, supported: &[String]) -> String {
    if supported.is_empty() {
        return format!(
            "connect to a Berth terminal daemon that advertises capability `{feature}`"
        );
    }

    format!(
        "connect to a Berth terminal daemon that advertises capability `{feature}`; supported capabilities: {}",
        supported.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_unsupported_errors_map_to_stable_feature_ids() {
        assert_eq!(
            unsupported_feature_id(&berth_term_proto::TerminalError::UnsupportedWireVersion {
                got: 2,
                minimum: 1,
                maximum: 1,
            })
            .as_deref(),
            Some(FEATURE_PROTOCOL_WIRE_VERSION)
        );
        assert_eq!(
            unsupported_feature_id(&berth_term_proto::TerminalError::UnsupportedCapability {
                feature: "capability.future".to_owned(),
                supported: vec![berth_term_proto::CAPABILITY_DETACHED_RPC.to_owned()],
            })
            .as_deref(),
            Some("capability.future")
        );
        assert_eq!(
            unsupported_feature_id(&berth_term_proto::TerminalError::UnknownCommand(
                "display-menu!".to_owned()
            ))
            .as_deref(),
            Some("command.display-menu_")
        );
    }

    #[test]
    fn protocol_diagnostic_preserves_unsupported_capability_hint() {
        let diagnostic =
            protocol_diagnostic(&berth_term_proto::TerminalError::UnsupportedCapability {
                feature: "capability.future".to_owned(),
                supported: vec![berth_term_proto::CAPABILITY_HANDSHAKE.to_owned()],
            });

        assert_eq!(diagnostic.severity(), DiagnosticSeverity::Unsupported);
        assert_eq!(diagnostic.feature(), Some("capability.future"));
        assert!(diagnostic
            .hint()
            .expect("hint")
            .contains(berth_term_proto::CAPABILITY_HANDSHAKE));
    }
}
