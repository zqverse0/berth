use berth_term_engine::LifecycleEvent;
use berth_term_proto::{ErrorResponse, Response, SwitchClientResponse, Target, TerminalError};

use crate::handler_support::attached_client_required;
use crate::pane_io::AttachControl;
use crate::pane_terminals::session_not_found;

use super::super::{
    attach_support::attach_target_for_session, client_environment_snapshot,
    client_support::ManagedClient, update_environment_from_client, RequestHandler,
};

impl RequestHandler {
    pub(super) async fn switch_managed_client_to_session(
        &self,
        requester_pid: u32,
        client: ManagedClient,
        session_name: berth_term_proto::SessionName,
        skip_environment_update: bool,
    ) -> Response {
        if !skip_environment_update {
            if let Some(client_environment) = client_environment_snapshot(requester_pid) {
                let mut state = self.state.lock().await;
                update_environment_from_client(&mut state, &session_name, &client_environment);
            }
        }
        let attached_count = self
            .attached_count_after_switch(&session_name, client)
            .await;

        match client {
            ManagedClient::Attach(attach_pid) => {
                let Some((terminal_context, client_size, client_pixels, _)) = self
                    .terminal_context_and_size_for_attached_client(attach_pid)
                    .await
                else {
                    return Response::Error(ErrorResponse {
                        error: attached_client_required("switch-client"),
                    });
                };
                if let Err(error) = self
                    .resize_session_geometry_for_attach_client(
                        &session_name,
                        Some(berth_term_proto::TerminalGeometry {
                            size: client_size,
                            pixels: client_pixels,
                        }),
                    )
                    .await
                {
                    return Response::Error(ErrorResponse { error });
                }
                let target = {
                    let state = self.state.lock().await;
                    let result = attach_target_for_session(
                        &state,
                        &session_name,
                        attached_count,
                        &terminal_context,
                        &self.socket_path(),
                    );
                    match result {
                        Ok(target) => target,
                        Err(error) => return Response::Error(ErrorResponse { error }),
                    }
                };

                match self
                    .send_attach_control(
                        attach_pid,
                        AttachControl::switch(target),
                        "switch-client",
                        Some(session_name.clone()),
                    )
                    .await
                {
                    Ok(_previous_session_name) => {
                        let mut state = self.state.lock().await;
                        if let Some(session) = state.sessions.session_mut(&session_name) {
                            session.touch_attached();
                        }
                        drop(state);
                        self.emit(LifecycleEvent::ClientSessionChanged {
                            session_name: session_name.clone(),
                            client_name: Some(attach_pid.to_string()),
                        })
                        .await;
                        Response::SwitchClient(SwitchClientResponse { session_name })
                    }
                    Err(error) => Response::Error(ErrorResponse { error }),
                }
            }
        }
    }

    pub(super) async fn apply_switch_target(
        &self,
        target: &str,
        zoom: bool,
    ) -> Result<berth_term_proto::SessionName, TerminalError> {
        match Target::parse(target)? {
            Target::Session(session_name) => {
                let state = self.state.lock().await;
                if state.sessions.session(&session_name).is_none() {
                    return Err(session_not_found(&session_name));
                }
                Ok(session_name)
            }
            Target::Window(target) => {
                let mut state = self.state.lock().await;
                let session = state
                    .sessions
                    .session_mut(target.session_name())
                    .ok_or_else(|| session_not_found(target.session_name()))?;
                session.select_window(target.window_index())?;
                Ok(target.session_name().clone())
            }
            Target::Pane(target) => {
                let mut state = self.state.lock().await;
                let session = state
                    .sessions
                    .session_mut(target.session_name())
                    .ok_or_else(|| session_not_found(target.session_name()))?;
                let (was_zoomed, zoom_pane) = {
                    let window = session.window_at(target.window_index()).ok_or_else(|| {
                        TerminalError::invalid_target(
                            target.to_string(),
                            "window index does not exist in session",
                        )
                    })?;
                    (window.is_zoomed(), window.active_pane_index())
                };
                if was_zoomed && zoom {
                    session.toggle_zoom_in_window(target.window_index(), zoom_pane)?;
                }
                session.select_window(target.window_index())?;
                session.select_pane_in_window(target.window_index(), target.pane_index())?;
                if was_zoomed && zoom {
                    session.toggle_zoom_in_window(target.window_index(), target.pane_index())?;
                }
                Ok(target.session_name().clone())
            }
        }
    }
}
