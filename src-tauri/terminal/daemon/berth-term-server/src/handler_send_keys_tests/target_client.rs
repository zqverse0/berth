use super::*;

#[tokio::test]
async fn send_keys_target_client_uses_that_clients_current_pane() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    create_send_keys_test_session(&handler, &alpha).await;
    let (control_tx, _control_rx) = mpsc::unbounded_channel();
    handler.register_attach(77, alpha.clone(), control_tx).await;
    let capture = RawPaneInputProbe::start(&handler, &alpha, "target-client", 1).await;

    let response = handler
        .handle(Request::SendKeysExt2(Box::new(
            berth_term_proto::SendKeysExt2Request {
                target: None,
                keys: vec!["A".to_owned()],
                expand_formats: false,
                hex: false,
                literal: true,
                dispatch_key_table: false,
                copy_mode_command: false,
                forward_mouse_event: false,
                reset_terminal: false,
                repeat_count: None,
                target_client: Some("77".to_owned()),
            },
        )))
        .await;

    assert_eq!(
        response,
        Response::SendKeys(SendKeysResponse { key_count: 1 })
    );
    capture.assert_contents(&handler, b"A").await;
}

#[tokio::test]
async fn send_keys_missing_target_client_is_successful_noop() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    create_send_keys_test_session(&handler, &alpha).await;
    let capture = RawPaneInputProbe::start(&handler, &alpha, "target-client-missing", 0).await;

    let response = handler
        .handle(Request::SendKeysExt2(Box::new(
            berth_term_proto::SendKeysExt2Request {
                target: Some(PaneTarget::new(alpha, 0)),
                keys: vec!["A".to_owned()],
                expand_formats: false,
                hex: false,
                literal: true,
                dispatch_key_table: false,
                copy_mode_command: false,
                forward_mouse_event: false,
                reset_terminal: false,
                repeat_count: None,
                target_client: Some("999999".to_owned()),
            },
        )))
        .await;

    assert_eq!(
        response,
        Response::SendKeys(SendKeysResponse { key_count: 0 })
    );
    capture.assert_contents(&handler, b"").await;
}
