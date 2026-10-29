use crate::{PaneRef, TerminalError};

pub(super) fn parse_error(message: impl Into<String>) -> TerminalError {
    TerminalError::protocol(berth_term_proto::TerminalError::Server(message.into()))
}

pub(super) fn is_already_closed_error<T: TargetSelector>(
    error: &TerminalError,
    target: &T,
) -> bool {
    match error {
        TerminalError::Protocol {
            source: berth_term_proto::TerminalError::SessionNotFound(session),
        } => session == target.session_name().as_str(),
        TerminalError::Protocol {
            source: berth_term_proto::TerminalError::InvalidTarget { value, reason },
        } => target.matches_invalid_target(value, reason),
        _ => false,
    }
}

pub(crate) fn is_already_closed_pane_error(error: &TerminalError, target: &PaneRef) -> bool {
    is_already_closed_error(error, target)
}

pub(super) trait TargetSelector {
    fn session_name(&self) -> &berth_term_proto::SessionName;
    fn matches_invalid_target(&self, value: &str, reason: &str) -> bool;
}

impl TargetSelector for PaneRef {
    fn session_name(&self) -> &berth_term_proto::SessionName {
        &self.session_name
    }

    fn matches_invalid_target(&self, value: &str, reason: &str) -> bool {
        let pane_target = self.to_proto().to_string();
        let window_target = format!("{}:{}", self.session_name, self.window_index);
        let mismatched_index_reason = matches!(
            reason,
            "window index does not exist in session" | "pane index does not exist in session"
        );
        mismatched_index_reason && (value == pane_target || value == window_target)
    }
}
