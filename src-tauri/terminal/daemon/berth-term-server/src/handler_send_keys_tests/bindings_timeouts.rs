use super::*;

#[tokio::test]
async fn prefix_timeout_clears_the_prefix_table_without_waiting_for_the_next_key() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let requester_pid = std::process::id();

    let created = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: alpha.clone(),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
        }))
        .await;
    assert!(matches!(created, Response::NewSession(_)));

    let configured = handler
        .handle(Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Global,
            option: OptionName::PrefixTimeout,
            value: "25".to_owned(),
            mode: SetOptionMode::Replace,
        }))
        .await;
    assert!(matches!(configured, Response::SetOption(_)));

    let (control_tx, _control_rx) = mpsc::unbounded_channel();
    let _attach_id = handler
        .register_attach(requester_pid, alpha.clone(), control_tx)
        .await;

    let dispatched = handler
        .handle(Request::SendKeysExt(SendKeysExtRequest {
            target: Some(PaneTarget::new(alpha, 0)),
            keys: vec!["C-b".to_owned()],
            expand_formats: false,
            hex: false,
            literal: false,
            dispatch_key_table: true,
            copy_mode_command: false,
            forward_mouse_event: false,
            reset_terminal: false,
            repeat_count: None,
        }))
        .await;
    assert_eq!(
        dispatched,
        Response::SendKeys(SendKeysResponse { key_count: 1 })
    );

    {
        let active_attach = handler.active_attach.lock().await;
        let active = active_attach
            .by_pid
            .get(&requester_pid)
            .expect("attached client should remain registered");
        assert_eq!(active.key_table_name.as_deref(), Some("prefix"));
    }

    sleep(Duration::from_millis(100)).await;

    let active_attach = handler.active_attach.lock().await;
    let active = active_attach
        .by_pid
        .get(&requester_pid)
        .expect("attached client should remain registered");
    assert_eq!(active.key_table_name, None);
    assert_eq!(active.key_table_set_at, None);
    assert!(!active.repeat_active);
    assert_eq!(active.repeat_deadline, None);
}
