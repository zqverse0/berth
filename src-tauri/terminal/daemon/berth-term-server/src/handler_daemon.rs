use berth_term_proto::{KillServerResponse, Response};

use super::{PendingShutdownReason, RequestHandler};

impl RequestHandler {
    pub(in crate::handler) async fn handle_kill_server(&self) -> Response {
        self.retained_exited_outputs
            .lock()
            .expect("retained exited output mutex must not be poisoned")
            .clear();
        self.queue_shutdown_request(PendingShutdownReason::KillServer);
        Response::KillServer(KillServerResponse)
    }
}
