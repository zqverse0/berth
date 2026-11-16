use super::*;

#[tokio::test]
async fn attach_session_returns_an_upgrade_response_for_existing_sessions() {
    let handler = RequestHandler::new();
    let created = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: session_name("alpha"),
            detached: true,
            size: None,

            environment: None,
        }))
        .await;
    assert!(matches!(created, Response::NewSession(_)));

    assert_eq!(
        handler
            .handle(Request::AttachSession(
                berth_term_proto::AttachSessionRequest {
                    target: session_name("alpha"),
                }
            ))
            .await,
        Response::AttachSession(berth_term_proto::AttachSessionResponse {
            session_name: session_name("alpha"),
        })
    );
}

#[tokio::test]
async fn attach_session_dispatch_populates_the_upgrade_field() {
    let handler = RequestHandler::new();
    let created = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: session_name("alpha"),
            detached: true,
            size: None,

            environment: None,
        }))
        .await;
    assert!(matches!(created, Response::NewSession(_)));

    let outcome = handler
        .dispatch(
            std::process::id(),
            Request::AttachSession(berth_term_proto::AttachSessionRequest {
                target: session_name("alpha"),
            }),
        )
        .await;

    assert!(
        matches!(outcome.response, Response::AttachSession(_)),
        "response should be AttachSession"
    );
    assert!(
        outcome.attach.is_some(),
        "dispatch must populate the attach upgrade field"
    );
}

#[tokio::test]
async fn attach_session_to_missing_session_returns_session_not_found() {
    let handler = RequestHandler::new();

    let outcome = handler
        .dispatch(
            std::process::id(),
            Request::AttachSession(berth_term_proto::AttachSessionRequest {
                target: session_name("missing"),
            }),
        )
        .await;

    assert_eq!(
        outcome.response,
        Response::Error(ErrorResponse {
            error: TerminalError::SessionNotFound("missing".to_owned()),
        })
    );
    assert!(
        outcome.attach.is_none(),
        "attach field must be None for missing sessions"
    );
}

#[tokio::test]
async fn detach_client_requires_an_attached_client() {
    let handler = RequestHandler::new();

    assert_eq!(
        handler
            .handle(Request::DetachClient(berth_term_proto::DetachClientRequest))
            .await,
        Response::Error(berth_term_proto::ErrorResponse {
            error: TerminalError::Server("detach-client requires an attached client".to_owned()),
        })
    );
}
