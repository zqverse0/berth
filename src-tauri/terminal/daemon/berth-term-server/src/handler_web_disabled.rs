use berth_term_proto::{
    ErrorResponse, Response, SessionId, SessionName, TerminalError, WebShareRequest,
};

use super::RequestHandler;

impl RequestHandler {
    pub(in crate::handler) async fn handle_web_share(&self, _request: WebShareRequest) -> Response {
        Response::Error(ErrorResponse {
            error: TerminalError::Server(
                "web-share support is not enabled in this daemon".to_owned(),
            ),
        })
    }

    pub(in crate::handler) fn prune_web_session(&self, _removed: Option<(SessionName, SessionId)>) {
    }
}
