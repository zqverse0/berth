use super::*;

#[tokio::test]
async fn detach_client_all_other_detaches_only_non_requester_clients() {
    use berth_term_proto::request::DetachClientExtRequest;

    let handler = RequestHandler::new();
    let alpha = session_name("alpha");

    let created = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: alpha.clone(),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
        }))
        .await;
    assert!(matches!(created, Response::NewSession(_)));

    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    let _first_attach = handler.register_attach(101, alpha.clone(), first_tx).await;
    let _second_attach = handler.register_attach(202, alpha, second_tx).await;

    let response = handler
        .dispatch(
            101,
            Request::DetachClientExt(DetachClientExtRequest {
                target_client: None,
                all_other_clients: true,
                target_session: None,
                kill_on_detach: false,
                exec_command: None,
            }),
        )
        .await
        .response;
    assert!(matches!(response, Response::DetachClient(_)));

    assert!(
        matches!(first_rx.try_recv(), Err(TryRecvError::Empty)),
        "the requester itself must not be detached"
    );
    let _ = recv_matching_attach_control(&mut second_rx, "other client detach", |control| {
        matches!(control, AttachControl::Detach)
    })
    .await;
}

#[tokio::test]
async fn client_flags_apply_named_supports_negate_prefix() {
    use super::super::attach_support::ClientFlags;

    let mut flags = ClientFlags::default();
    flags.apply_named("read-only").expect("apply read-only");
    assert!(flags.contains(ClientFlags::READONLY));

    flags.apply_named("!read-only").expect("negate read-only");
    assert!(!flags.contains(ClientFlags::READONLY));

    flags.apply_named("active-pane").expect("apply active-pane");
    flags
        .apply_named("no-detach-on-destroy")
        .expect("apply no-detach-on-destroy");
    assert!(flags.contains(ClientFlags::ACTIVEPANE));
    assert!(flags.contains(ClientFlags::NO_DETACH_ON_DESTROY));

    flags
        .apply_named("!active-pane")
        .expect("negate active-pane");
    assert!(!flags.contains(ClientFlags::ACTIVEPANE));
    assert!(flags.contains(ClientFlags::NO_DETACH_ON_DESTROY));
}
