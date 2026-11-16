use berth_term_proto::{Target, TerminalError};

use super::super::RequestHandler;
use super::support::{find_session_name_by_id, find_window_target_by_id};
use crate::mouse::{AttachedMouseEvent, MouseLocation};

impl RequestHandler {
    pub(in crate::handler) async fn attached_mouse_target(
        &self,
        attach_pid: u32,
        event: &AttachedMouseEvent,
    ) -> Result<Option<Target>, TerminalError> {
        let session_name = self.attached_session_name(attach_pid).await?;
        self.overlay_target_from_mouse(session_name, Some(event))
            .await
    }

    async fn overlay_target_from_mouse(
        &self,
        attached_session: berth_term_proto::SessionName,
        event: Option<&AttachedMouseEvent>,
    ) -> Result<Option<Target>, TerminalError> {
        let Some(event) = event else {
            return Ok(None);
        };
        if let Some(target) = event.pane_target.clone() {
            return Ok(Some(Target::Pane(target)));
        }
        let state = self.state.lock().await;
        match event.location {
            MouseLocation::StatusLeft => Ok(Some(Target::Session(attached_session))),
            MouseLocation::Status | MouseLocation::StatusDefault | MouseLocation::StatusRight => {
                if let Some(window_id) = event.window_id {
                    if let Some(target) =
                        find_window_target_by_id(&state, &attached_session, window_id)
                    {
                        return Ok(Some(Target::Window(target)));
                    }
                }
                if let Some(session_name) = find_session_name_by_id(&state, event.session_id) {
                    return Ok(Some(Target::Session(session_name)));
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }
}
