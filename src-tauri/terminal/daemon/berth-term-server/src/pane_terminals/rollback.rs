use std::collections::HashMap;

use berth_term_engine::{PaneId, Session};
use berth_term_proto::{SessionName, TerminalError};

use crate::pane_terminal_process::PaneTerminal;

use super::{HandlerState, RemovedPaneOutputs};

impl HandlerState {
    pub(in crate::pane_terminals) fn replace_session(
        &mut self,
        session_name: &SessionName,
        previous_session: Session,
    ) -> Result<(), TerminalError> {
        let session = self.sessions.session_mut(session_name).ok_or_else(|| {
            TerminalError::Server(format!(
                "failed to roll back session {session_name}: session disappeared"
            ))
        })?;
        *session = previous_session;
        Ok(())
    }

    pub(in crate::pane_terminals) fn restore_session_after_resize_error(
        &mut self,
        session_name: &SessionName,
        previous_session: Session,
        source_error: &TerminalError,
    ) -> Result<(), TerminalError> {
        self.replace_session(session_name, previous_session)?;
        self.resize_terminals(session_name)
            .map_err(|rollback_error| {
                TerminalError::Server(format!(
                "failed to roll back session {session_name} after {source_error}: {rollback_error}"
            ))
            })
    }

    pub(in crate::pane_terminals) fn restore_session_and_panes_after_resize_error(
        &mut self,
        session_name: &SessionName,
        previous_session: Session,
        removed_terminals: HashMap<PaneId, PaneTerminal>,
        removed_outputs: RemovedPaneOutputs,
        source_error: &TerminalError,
    ) -> Result<(), TerminalError> {
        self.replace_session(session_name, previous_session)?;
        self.terminals
            .insert_existing_panes(session_name, removed_terminals)
            .map_err(|rollback_error| {
                TerminalError::Server(format!(
                    "failed to restore pane terminals for session {session_name} after {source_error}: {rollback_error}"
                ))
            })?;
        self.insert_existing_pane_outputs(session_name, removed_outputs);
        self.resize_terminals(session_name)
            .map_err(|rollback_error| {
                TerminalError::Server(format!(
                    "failed to roll back session {session_name} after {source_error}: {rollback_error}"
                ))
            })
    }
}
