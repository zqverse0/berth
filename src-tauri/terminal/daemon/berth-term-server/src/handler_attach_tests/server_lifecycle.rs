use super::*;

#[tokio::test]
async fn kill_server_sets_shutdown_flag() {
    let handler = RequestHandler::new();

    let response = handler
        .handle(Request::KillServer(berth_term_proto::KillServerRequest))
        .await;
    assert!(matches!(response, Response::KillServer(_)));

    assert!(
        handler.request_shutdown_if_pending(),
        "shutdown flag must be set after kill-server"
    );
    assert!(
        !handler.request_shutdown_if_pending(),
        "shutdown flag must be consumed after first check"
    );
}
