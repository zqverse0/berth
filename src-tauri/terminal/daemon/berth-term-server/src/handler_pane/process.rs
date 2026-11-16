use berth_term_engine::LifecycleEvent;
use berth_term_proto::{ErrorResponse, Response, Target};

use super::super::{
    client_environment_snapshot, client_spawn_environment, prepare_lifecycle_event,
    scripting_support::render_start_directory_template, RequestHandler,
};

impl RequestHandler {
    pub(in crate::handler) async fn handle_respawn_pane(
        &self,
        requester_pid: u32,
        mut request: berth_term_proto::RespawnPaneRequest,
    ) -> Response {
        let session_name = request.target.session_name().clone();
        let target = request.target.clone();
        let socket_path = self.socket_path();
        let client_environment = client_environment_snapshot(requester_pid);
        let spawn_environment = client_spawn_environment(client_environment.as_ref());
        let attached_count = self.attached_count(&session_name).await;
        let response = {
            let mut state = self.state.lock().await;
            request.start_directory = match render_start_directory_template(
                &state,
                &Target::Pane(target),
                attached_count,
                request.start_directory,
            ) {
                Ok(start_directory) => start_directory,
                Err(error) => return Response::Error(ErrorResponse { error }),
            };
            match state.respawn_pane(
                request,
                &socket_path,
                spawn_environment.as_ref(),
                Some(self.pane_alert_callback()),
                Some(self.pane_exit_callback()),
                |state, replaced| {
                    let queued = prepare_lifecycle_event(
                        state,
                        &LifecycleEvent::PaneExited {
                            target: replaced.target.clone(),
                            pane_id: Some(replaced.pane_id),
                            window_id: Some(replaced.window_id),
                            window_name: Some(replaced.window_name.clone()),
                        },
                    );
                    self.emit_prepared(queued);
                },
            ) {
                Ok(response) => Response::RespawnPane(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::RespawnPane(_)) {
            self.refresh_attached_session(&session_name).await;
        }

        response
    }
}
