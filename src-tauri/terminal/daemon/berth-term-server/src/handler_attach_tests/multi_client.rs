use super::*;

#[tokio::test]
async fn different_requester_pids_reject_ambiguous_cross_process_attach_control() {
    let handler = RequestHandler::new();
    let first_owner_pid = 101;
    let second_owner_pid = 303;
    let intruder_pid = 202;
    let alpha = session_name("alpha");
    let beta = session_name("beta");
    let gamma = session_name("gamma");

    for session_name in [alpha.clone(), beta.clone(), gamma.clone()] {
        let created = handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name,
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await;
        assert!(matches!(created, Response::NewSession(_)));
    }

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let _first_attach_id = handler
        .register_attach(first_owner_pid, alpha, first_tx)
        .await;
    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let _second_attach_id = handler
        .register_attach(second_owner_pid, beta, second_tx)
        .await;

    let detached = handler
        .dispatch(
            intruder_pid,
            Request::DetachClient(berth_term_proto::DetachClientRequest),
        )
        .await
        .response;
    assert_eq!(
        detached,
        Response::Error(berth_term_proto::ErrorResponse {
            error: berth_term_proto::TerminalError::Server(
                "detach-client requires an unambiguous attached client".to_owned(),
            ),
        })
    );

    assert!(matches!(first_rx.try_recv(), Err(TryRecvError::Empty)));
    assert!(matches!(second_rx.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test]
async fn attach_session_without_target_prefers_an_unattached_session() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let beta = session_name("beta");

    for session_name in [alpha.clone(), beta.clone()] {
        let created = handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name,
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await;
        assert!(matches!(created, Response::NewSession(_)));
    }

    let (control_tx, _control_rx) = mpsc::unbounded_channel();
    let _attach_id = handler.register_attach(101, alpha, control_tx).await;

    let outcome = handler
        .dispatch(
            202,
            Request::AttachSessionExt(AttachSessionExtRequest {
                target: None,
                detach_other_clients: false,
                kill_other_clients: false,
                read_only: false,
                skip_environment_update: false,
                flags: None,
            }),
        )
        .await;

    assert_eq!(
        outcome.response,
        Response::AttachSession(AttachSessionResponse { session_name: beta })
    );
    assert!(outcome.attach.is_some());
}

#[tokio::test]
async fn attach_session_without_target_prefers_the_most_recent_unattached_session() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let beta = session_name("beta");

    for session_name in [alpha.clone(), beta.clone()] {
        let created = handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name,
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await;
        assert!(matches!(created, Response::NewSession(_)));
    }

    sleep(Duration::from_secs(1)).await;
    let (control_tx, _control_rx) = mpsc::unbounded_channel();
    let attach_id = handler.register_attach(101, beta.clone(), control_tx).await;
    handler.finish_attach(101, attach_id).await;

    let outcome = handler
        .dispatch(
            202,
            Request::AttachSessionExt(AttachSessionExtRequest {
                target: None,
                detach_other_clients: false,
                kill_other_clients: false,
                read_only: false,
                skip_environment_update: false,
                flags: None,
            }),
        )
        .await;

    assert_eq!(
        outcome.response,
        Response::AttachSession(AttachSessionResponse { session_name: beta })
    );
    assert!(outcome.attach.is_some());
}
