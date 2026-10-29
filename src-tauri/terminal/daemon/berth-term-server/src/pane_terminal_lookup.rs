use berth_term_engine::{PaneGeometry, PaneId, SessionStore};
use berth_term_proto::{SessionName, TerminalError};

#[derive(Debug, Clone, Copy)]
pub(crate) struct SessionPane {
    pub(crate) id: PaneId,
    pub(crate) window_index: u32,
    pub(crate) index: u32,
    pub(crate) geometry: PaneGeometry,
}

pub(crate) fn initial_pane(
    sessions: &SessionStore,
    session_name: &SessionName,
) -> Result<SessionPane, TerminalError> {
    let session = sessions
        .session(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_string()))?;

    session
        .window()
        .pane(0)
        .map(|pane| SessionPane {
            id: pane.id(),
            window_index: session.active_window_index(),
            index: pane.index(),
            geometry: pane.geometry(),
        })
        .ok_or_else(|| {
            TerminalError::Server(format!("initial pane missing for session {session_name}"))
        })
}

pub(crate) fn pane_id_for_target(
    sessions: &SessionStore,
    session_name: &SessionName,
    window_index: u32,
    pane_index: u32,
) -> Result<PaneId, TerminalError> {
    let target = sessions
        .session(session_name)
        .ok_or_else(|| TerminalError::SessionNotFound(session_name.to_string()))?
        .window_at(window_index)
        .ok_or_else(|| {
            TerminalError::invalid_target(
                format!("{session_name}:{window_index}"),
                "window index does not exist in session",
            )
        })?;

    target
        .pane(pane_index)
        .map(|pane| pane.id())
        .ok_or_else(|| {
            TerminalError::invalid_target(
                format!("{session_name}:{window_index}.{pane_index}"),
                "pane index does not exist in session",
            )
        })
}

pub(crate) fn missing_pane_terminal(
    session_name: &SessionName,
    window_index: u32,
    pane_index: u32,
) -> TerminalError {
    TerminalError::Server(format!(
        "missing pane terminal for {}:{window_index}.{pane_index}",
        session_name
    ))
}
