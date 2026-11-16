use super::*;

#[tokio::test]
async fn attached_prefix_n_dispatches_next_window() {
    let handler = RequestHandler::new();
    let requester_pid = std::process::id();
    let alpha = session_name("alpha");
    let _control_rx = create_attached_session(&handler, requester_pid, &alpha).await;
    assert!(matches!(
        handler
            .handle(Request::NewWindow(Box::new(NewWindowRequest {
                target: alpha.clone(),
                name: None,
                detached: true,
                start_directory: None,
                environment: None,
                command: None,
                process_command: None,
                target_window_index: None,
                insert_at_target: false,
            })))
            .await,
        Response::NewWindow(_)
    ));

    handler
        .handle_attached_live_input_for_test(requester_pid, b"\x02n")
        .await
        .expect("prefix n input");

    assert_eq!(active_windows(&handler, &alpha).await, "0:0\n1:1\n");
}

#[tokio::test]
async fn attached_prefix_n_without_next_window_reports_status_message() {
    let handler = RequestHandler::new();
    let requester_pid = std::process::id();
    let alpha = session_name("alpha");
    let mut control_rx = create_attached_session(&handler, requester_pid, &alpha).await;
    drain_attach_controls(&mut control_rx);

    handler
        .handle_attached_live_input_for_test(requester_pid, b"\x02n")
        .await
        .expect("prefix n should not terminate the attached client");

    let frame = recv_overlay_frame(&mut control_rx, "prefix n status message").await;
    assert!(
        frame.contains("No next window"),
        "prefix n should render tmux's attached status message, got {frame:?}"
    );
    assert!(
        frame.contains("\x1b[0;30;43m") || frame.contains("\x1b[30;43m"),
        "prefix n should render tmux's default message-style, got {frame:?}"
    );
    assert_eq!(active_windows(&handler, &alpha).await, "0:1\n");
}

#[tokio::test]
async fn attached_prefix_p_without_previous_window_reports_status_message() {
    let handler = RequestHandler::new();
    let requester_pid = std::process::id();
    let alpha = session_name("alpha");
    let mut control_rx = create_attached_session(&handler, requester_pid, &alpha).await;
    drain_attach_controls(&mut control_rx);

    handler
        .handle_attached_live_input_for_test(requester_pid, b"\x02p")
        .await
        .expect("prefix p should not terminate the attached client");

    let frame = recv_overlay_frame(&mut control_rx, "prefix p status message").await;
    assert!(
        frame.contains("No previous window"),
        "prefix p should render tmux's attached status message, got {frame:?}"
    );
    assert!(
        frame.contains("\x1b[0;30;43m") || frame.contains("\x1b[30;43m"),
        "prefix p should render tmux's default message-style, got {frame:?}"
    );
    assert_eq!(active_windows(&handler, &alpha).await, "0:1\n");
}

#[tokio::test]
async fn attached_select_layout_main_horizontal_binding_command_executes() {
    let handler = RequestHandler::new();
    let requester_pid = std::process::id();
    let alpha = session_name("alpha");
    let _control_rx = create_attached_session(&handler, requester_pid, &alpha).await;
    for _ in 0..2 {
        assert!(matches!(
            handler
                .handle(Request::SplitWindow(SplitWindowRequest {
                    target: SplitWindowTarget::Session(alpha.clone()),
                    direction: berth_term_proto::SplitDirection::Vertical,
                    before: false,
                    environment: None,
                }))
                .await,
            Response::SplitWindow(_)
        ));
    }
    select_layout(&handler, &alpha, LayoutName::Tiled).await;

    let commands = handler
        .parse_command_string_one_group("select-layout main-horizontal")
        .await
        .expect("binding command parses");
    handler
        .execute_parsed_commands_for_test(requester_pid, commands)
        .await
        .expect("binding command executes");

    assert_eq!(
        current_layout(&handler, &alpha).await,
        LayoutName::MainHorizontal
    );
}
