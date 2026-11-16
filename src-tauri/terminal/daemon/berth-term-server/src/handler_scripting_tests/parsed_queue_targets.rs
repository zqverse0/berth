use super::*;

#[tokio::test]
async fn parsed_queue_uses_current_target_for_rename_window_and_session() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::NewWindow(Box::new(NewWindowRequest {
                target: alpha.clone(),
                name: Some("w1".to_owned()),
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
    assert!(matches!(
        handler
            .handle(Request::SelectWindow(
                berth_term_proto::SelectWindowRequest {
                    target: berth_term_proto::WindowTarget::with_window(alpha.clone(), 1),
                }
            ))
            .await,
        Response::SelectWindow(_)
    ));

    for command in ["rename-window renamed", "rename-session beta"] {
        let parsed = CommandParser::new().parse(command).expect("command parses");
        handler
            .execute_parsed_commands(
                std::process::id(),
                parsed,
                QueueExecutionContext::without_caller_cwd().with_current_target(Some(
                    Target::Pane(PaneTarget::with_window(alpha.clone(), 1, 0)),
                )),
            )
            .await
            .unwrap_or_else(|error| {
                panic!("{command} should succeed with current target: {error}")
            });
    }

    let state = handler.state.lock().await;
    let beta = session_name("beta");
    let session = state
        .sessions
        .session(&beta)
        .expect("renamed session exists");
    assert_eq!(
        session.window_at(1).expect("window 1 exists").name(),
        Some("renamed")
    );
}

#[tokio::test]
async fn parsed_queue_select_window_navigation_flags_use_window_session() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha-select-flags");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::NewWindow(Box::new(NewWindowRequest {
                target: alpha.clone(),
                name: Some("w1".to_owned()),
                detached: true,
                start_directory: None,
                environment: None,
                command: None,
                process_command: None,
                target_window_index: Some(1),
                insert_at_target: false,
            })))
            .await,
        Response::NewWindow(_)
    ));

    let current_pane = PaneTarget::with_window(alpha.clone(), 0, 0);
    let context = TargetFindContext::from_target(Target::Pane(current_pane));
    let state = handler.state.lock().await;
    let cases = [
        (
            vec![
                "-n".to_owned(),
                "-t".to_owned(),
                "alpha-select-flags:1".to_owned(),
            ],
            Request::NextWindow(NextWindowRequest {
                target: alpha.clone(),
                alerts_only: false,
            }),
        ),
        (
            vec![
                "-p".to_owned(),
                "-t".to_owned(),
                "alpha-select-flags:1".to_owned(),
            ],
            Request::PreviousWindow(PreviousWindowRequest {
                target: alpha.clone(),
                alerts_only: false,
            }),
        ),
        (
            vec![
                "-T".to_owned(),
                "-t".to_owned(),
                "alpha-select-flags:0".to_owned(),
            ],
            Request::SelectWindow(berth_term_proto::SelectWindowRequest {
                target: WindowTarget::with_window(alpha.clone(), 0),
            }),
        ),
        (
            vec![
                "-T".to_owned(),
                "-t".to_owned(),
                "alpha-select-flags:1".to_owned(),
            ],
            Request::SelectWindow(berth_term_proto::SelectWindowRequest {
                target: WindowTarget::with_window(alpha.clone(), 1),
            }),
        ),
    ];

    for (arguments, expected) in cases {
        let parsed = crate::handler::scripting_support::parse_request_from_parts(
            "select-window".to_owned(),
            arguments,
            None,
            &state.sessions,
            &state.options,
            &context,
        )
        .expect("select-window navigation flag should parse");
        assert_eq!(parsed, expected);
    }
}

#[tokio::test]
async fn parsed_queue_list_panes_resolves_bare_window_name_in_current_session() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::NewWindow(Box::new(NewWindowRequest {
                target: alpha.clone(),
                name: Some("editor".to_owned()),
                detached: true,
                start_directory: None,
                environment: None,
                command: None,
                process_command: None,
                target_window_index: Some(1),
                insert_at_target: false,
            })))
            .await,
        Response::NewWindow(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Pane(PaneTarget::with_window(alpha.clone(), 1, 0)),
                direction: SplitDirection::Vertical,
                environment: None,
                before: false,
            }))
            .await,
        Response::SplitWindow(_)
    ));

    let command = CommandParser::new()
        .parse("list-panes -t editor -F '#{pane_index}'")
        .expect("list-panes command parses");
    let output = handler
        .execute_parsed_commands(
            std::process::id(),
            command,
            QueueExecutionContext::without_caller_cwd().with_current_target(Some(Target::Pane(
                PaneTarget::with_window(alpha.clone(), 1, 0),
            ))),
        )
        .await
        .expect("list-panes should resolve editor as a window name");

    assert_eq!(String::from_utf8_lossy(&output.stdout), "0\n1\n");
}

#[tokio::test]
async fn parsed_queue_uses_current_target_for_more_default_targeted_commands() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));

    let current_pane = PaneTarget::with_window(alpha.clone(), 0, 0);
    let current_window = WindowTarget::with_window(alpha.clone(), 0);
    let context = TargetFindContext::from_target(Target::Pane(current_pane.clone()));
    let state = handler.state.lock().await;

    let cases = [
        (
            "kill-window",
            Vec::new(),
            Request::KillWindow(KillWindowRequest {
                target: current_window.clone(),
                kill_all_others: false,
            }),
        ),
        (
            "respawn-window",
            vec![
                "-k".to_owned(),
                "--".to_owned(),
                "printf".to_owned(),
                "hello".to_owned(),
            ],
            Request::RespawnWindow(Box::new(RespawnWindowRequest {
                target: current_window.clone(),
                kill: true,
                environment: None,
                command: Some(vec!["printf".to_owned(), "hello".to_owned()]),
                start_directory: None,
            })),
        ),
        (
            "respawn-pane",
            vec![
                "-k".to_owned(),
                "--".to_owned(),
                "printf".to_owned(),
                "hello".to_owned(),
            ],
            Request::RespawnPane(Box::new(RespawnPaneRequest {
                target: current_pane.clone(),
                kill: true,
                environment: None,
                command: Some(vec!["printf".to_owned(), "hello".to_owned()]),
                process_command: None,
                start_directory: None,
            })),
        ),
    ];

    for (command, arguments, expected) in cases {
        let parsed = crate::handler::scripting_support::parse_request_from_parts(
            command.to_owned(),
            arguments,
            None,
            &state.sessions,
            &state.options,
            &context,
        )
        .unwrap_or_else(|error| panic!("{command} should use the current target: {error}"));
        assert_eq!(parsed, expected, "unexpected parsed request for {command}");
    }
}

#[tokio::test]
async fn parsed_queue_resolves_attached_short_target_values_for_select_pane() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Pane(PaneTarget::with_window(alpha.clone(), 0, 0)),
                direction: SplitDirection::Horizontal,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));

    let parsed = CommandParser::new()
        .parse("select-pane -t:.+")
        .expect("command parses");
    handler
        .execute_parsed_commands(
            std::process::id(),
            parsed,
            QueueExecutionContext::without_caller_cwd().with_current_target(Some(Target::Pane(
                PaneTarget::with_window(alpha.clone(), 0, 1),
            ))),
        )
        .await
        .expect("select-pane binding should resolve");

    let state = handler.state.lock().await;
    let session = state.sessions.session(&alpha).expect("session exists");
    assert_eq!(
        session
            .window_at(0)
            .expect("window exists")
            .active_pane_index(),
        0,
        "attached short-form -t target should resolve relative pane targets"
    );
}

#[tokio::test]
async fn parsed_queue_resolves_select_pane_mark_against_the_current_pane() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Pane(PaneTarget::with_window(alpha.clone(), 0, 0)),
                direction: SplitDirection::Horizontal,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));

    let parsed = CommandParser::new()
        .parse("select-pane -m")
        .expect("command parses");
    handler
        .execute_parsed_commands(
            std::process::id(),
            parsed,
            QueueExecutionContext::without_caller_cwd().with_current_target(Some(Target::Pane(
                PaneTarget::with_window(alpha.clone(), 0, 1),
            ))),
        )
        .await
        .expect("select-pane -m should resolve against the current pane");

    let state = handler.state.lock().await;
    assert_eq!(
        state
            .marked_pane_target()
            .expect("marked pane target exists")
            .to_string(),
        "alpha:0.1"
    );
}

#[tokio::test]
async fn parsed_queue_resolves_explicit_marked_pane_targets() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Pane(PaneTarget::with_window(alpha.clone(), 0, 0)),
                direction: SplitDirection::Horizontal,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));

    let mark = CommandParser::new()
        .parse("select-pane -m")
        .expect("mark command parses");
    handler
        .execute_parsed_commands(
            std::process::id(),
            mark,
            QueueExecutionContext::without_caller_cwd().with_current_target(Some(Target::Pane(
                PaneTarget::with_window(alpha.clone(), 0, 1),
            ))),
        )
        .await
        .expect("mark pane 1");

    let command = CommandParser::new()
        .parse("display-message -p -t ~ '#{pane_index}'")
        .expect("display-message command parses");
    let output = handler
        .execute_parsed_commands(
            std::process::id(),
            command,
            QueueExecutionContext::without_caller_cwd().with_current_target(Some(Target::Pane(
                PaneTarget::with_window(alpha.clone(), 0, 0),
            ))),
        )
        .await
        .expect("display-message should resolve marked pane");

    assert_eq!(String::from_utf8_lossy(&output.stdout), "1\n");
}

#[tokio::test]
async fn parsed_queue_display_message_canfail_target_uses_empty_context_without_current_target() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha,
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));

    let command = CommandParser::new()
        .parse("display-message -p -t nosuch '#{session_name}:#{window_index}.#{pane_index}'")
        .expect("display-message command parses");
    let output = handler
        .execute_parsed_commands_for_test(std::process::id(), command)
        .await
        .expect("display-message should tolerate a missing canfail target");

    assert_eq!(output.stdout(), b":.\n");
}

#[tokio::test]
async fn parsed_queue_display_message_canfail_target_falls_back_to_queue_current_target() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));

    let command = CommandParser::new()
        .parse("display-message -p -t '{up-of}' '#{session_name}:#{window_index}.#{pane_index}'")
        .expect("display-message command parses");
    let output = handler
        .execute_parsed_commands(
            std::process::id(),
            command,
            QueueExecutionContext::without_caller_cwd()
                .with_current_target(Some(Target::Pane(PaneTarget::with_window(alpha, 0, 0)))),
        )
        .await
        .expect("display-message should fall back to queue current target");

    assert_eq!(output.stdout(), b"alpha:0.0\n");
}
