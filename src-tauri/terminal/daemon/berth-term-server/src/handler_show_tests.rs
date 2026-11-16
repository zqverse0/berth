use std::collections::HashMap;

use super::RequestHandler;
use berth_term_engine::events::SubscriptionLimits;
use berth_term_proto::{
    ErrorResponse, NewSessionRequest, OptionName, PaneTarget, Request, Response, ScopeSelector,
    SetOptionMode, SetOptionRequest, ShowOptionsRequest, SplitDirection, SplitWindowRequest,
    SplitWindowTarget, TerminalError, TerminalSize, WindowTarget,
};

fn session_name(value: &str) -> berth_term_proto::SessionName {
    berth_term_proto::SessionName::new(value).expect("valid session name")
}

async fn create_session(handler: &RequestHandler, name: &str) {
    let response = handler
        .handle(Request::NewSession(NewSessionRequest {
            session_name: session_name(name),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
        }))
        .await;

    assert!(matches!(response, Response::NewSession(_)));
}

#[tokio::test]
async fn show_options_returns_command_output_for_session_and_server_scopes() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Session(session_name("alpha")),
                option: OptionName::Status,
                value: "off".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));

    let response = handler
        .handle(Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::Session(session_name("alpha")),
            name: None,
            value_only: false,
            include_inherited: true,
            quiet: false,
        }))
        .await;
    let output = response
        .command_output()
        .expect("show-options should return command output");
    let stdout = std::str::from_utf8(output.stdout()).expect("utf8 output");
    assert!(stdout.contains("status off\n"));
    assert!(stdout.contains("base-index* 0\n"));

    let response = handler
        .handle(Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::ServerGlobal,
            name: None,
            value_only: true,
            include_inherited: true,
            quiet: false,
        }))
        .await;
    let output = response
        .command_output()
        .expect("show-options -sv should return command output");
    let stdout = std::str::from_utf8(output.stdout()).expect("utf8 output");
    assert!(stdout.contains("tmux-256color\n"));
    assert!(!stdout.contains("default-terminal "));
}

#[tokio::test]
async fn show_options_without_a_omits_inherited_values() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    let response = handler
        .handle(Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::Session(session_name("alpha")),
            name: Some("status".to_owned()),
            value_only: false,
            include_inherited: false,
            quiet: false,
        }))
        .await;
    let output = response
        .command_output()
        .expect("show-options should return command output");

    assert_eq!(output.stdout(), b"");
}

#[tokio::test]
async fn show_options_global_scope_resolves_named_defaults_without_a_marker() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    let response = handler
        .handle(Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::SessionGlobal,
            name: Some("status".to_owned()),
            value_only: true,
            include_inherited: false,
            quiet: false,
        }))
        .await;
    let output = response
        .command_output()
        .expect("show-options -gqv should return command output");

    assert_eq!(output.stdout(), b"on\n");
}

#[tokio::test]
async fn show_options_a_marks_inherited_values() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    let response = handler
        .handle(Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::Session(session_name("alpha")),
            name: Some("status".to_owned()),
            value_only: false,
            include_inherited: true,
            quiet: false,
        }))
        .await;
    let output = response
        .command_output()
        .expect("show-options -A should return command output");

    assert_eq!(output.stdout(), b"status* on\n");
}

#[tokio::test]
async fn base_index_controls_future_window_allocation() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Session(session_name("alpha")),
                option: OptionName::BaseIndex,
                value: "3".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));

    let response = handler
        .handle(Request::NewWindow(Box::new(
            berth_term_proto::NewWindowRequest {
                target: session_name("alpha"),
                name: None,
                detached: true,
                start_directory: None,
                environment: None,
                command: None,
                process_command: None,
                target_window_index: None,
                insert_at_target: false,
            },
        )))
        .await;

    assert!(matches!(
        response,
        Response::NewWindow(response) if response.target.window_index() == 3
    ));
}

#[tokio::test]
async fn show_options_window_global_scope_is_a_valid_explicit_request() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    let response = handler
        .handle(Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::WindowGlobal,
            name: Some("pane-border-style".to_owned()),
            value_only: false,
            include_inherited: true,
            quiet: false,
        }))
        .await;
    assert!(matches!(response, Response::ShowOptions(_)));
}

#[tokio::test]
async fn default_handler_seeds_global_show_environment_from_process_environment() {
    let handler = RequestHandler::default();
    let expected_environment = std::env::vars().collect::<HashMap<_, _>>();
    let expected = expected_environment
        .iter()
        .next()
        .expect("test process should expose at least one environment variable");

    let state = handler.state.lock().await;

    assert_eq!(
        state.environment.global_value(expected.0),
        Some(expected.1.as_str()),
        "seeded global environment should contain the current process snapshot"
    );
}

#[tokio::test]
async fn seeded_global_environment_preserves_color_controls() {
    let handler = RequestHandler::with_owner_uid_and_environment(
        501,
        Some(HashMap::from([
            ("NO_COLOR".to_owned(), "1".to_owned()),
            ("NO_COLORS".to_owned(), "1".to_owned()),
            ("NODE_DISABLE_COLORS".to_owned(), "1".to_owned()),
            ("CLICOLOR".to_owned(), "0".to_owned()),
            ("CLICOLOR_FORCE".to_owned(), "1".to_owned()),
            ("RMUX_KEEP_ME".to_owned(), "yes".to_owned()),
        ])),
        SubscriptionLimits::default(),
    );

    let state = handler.state.lock().await;

    assert_eq!(state.environment.global_value("RMUX_KEEP_ME"), Some("yes"));
    assert_eq!(state.environment.global_value("CLICOLOR_FORCE"), Some("1"));
    assert_eq!(state.environment.global_value("NO_COLOR"), Some("1"));
    assert_eq!(state.environment.global_value("NO_COLORS"), Some("1"));
    assert_eq!(
        state.environment.global_value("NODE_DISABLE_COLORS"),
        Some("1")
    );
    assert_eq!(state.environment.global_value("CLICOLOR"), Some("0"));
}

#[tokio::test]
async fn show_options_for_nonexistent_session_returns_session_not_found() {
    let handler = RequestHandler::new();

    assert_eq!(
        handler
            .handle(Request::ShowOptions(ShowOptionsRequest {
                scope: berth_term_proto::OptionScopeSelector::Session(session_name("missing")),
                name: None,
                value_only: false,
                include_inherited: true,
                quiet: false,
            }))
            .await,
        Response::Error(ErrorResponse {
            error: TerminalError::SessionNotFound("missing".to_owned()),
        })
    );
}

#[tokio::test]
async fn show_options_at_window_scope_resolves_window_then_session_then_global() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    // Set a window-scope option at the window level
    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Window(WindowTarget::new(session_name("alpha"))),
                option: OptionName::MainPaneWidth,
                value: "120".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));

    let response = handler
        .handle(Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::Window(WindowTarget::new(session_name(
                "alpha",
            ))),
            name: None,
            value_only: false,
            include_inherited: true,
            quiet: false,
        }))
        .await;
    let output = response
        .command_output()
        .expect("show-options should return command output");
    let stdout = std::str::from_utf8(output.stdout()).expect("utf8 output");
    assert!(stdout.contains("main-pane-width 120\n"));
    // Session-scoped options should not appear in window show-options.
    assert!(!stdout.contains("\nstatus "));
    assert!(!stdout.starts_with("status "));
    assert!(!stdout.contains("\nbase-index "));
    assert!(!stdout.starts_with("base-index "));
}

#[tokio::test]
async fn kill_window_removes_window_and_pane_option_overrides() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    // Create a second window so kill-window doesn't fail (need at least 1)
    assert!(matches!(
        handler
            .handle(Request::NewWindow(Box::new(
                berth_term_proto::NewWindowRequest {
                    target: session_name("alpha"),
                    name: None,
                    detached: true,
                    start_directory: None,
                    environment: None,
                    command: None,
                    process_command: None,
                    target_window_index: None,
                    insert_at_target: false,
                }
            )))
            .await,
        Response::NewWindow(_)
    ));

    // Set a window option on window 0
    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Window(WindowTarget::new(session_name("alpha"))),
                option: OptionName::MainPaneWidth,
                value: "120".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));

    // Set a pane option on pane 0 of window 0
    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Pane(PaneTarget::new(session_name("alpha"), 0)),
                option: OptionName::WindowStyle,
                value: "fg=colour9".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));

    // Kill window 0
    assert!(matches!(
        handler
            .handle(Request::KillWindow(berth_term_proto::KillWindowRequest {
                target: WindowTarget::new(session_name("alpha")),
                kill_all_others: false,
            }))
            .await,
        Response::KillWindow(_)
    ));

    // Verify window and pane options are cleaned up
    let state = handler.state.lock().await;
    assert_eq!(
        state.options.window_value(
            &WindowTarget::new(session_name("alpha")),
            OptionName::MainPaneWidth
        ),
        None
    );
    assert_eq!(
        state.options.pane_value(
            &PaneTarget::new(session_name("alpha"), 0),
            OptionName::WindowStyle
        ),
        None
    );
}

#[tokio::test]
async fn kill_pane_removes_pane_option_overrides() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    // Split to create a second pane
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Session(session_name("alpha")),
                direction: SplitDirection::Vertical,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));

    // Set a pane option on pane 1
    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Pane(PaneTarget::new(session_name("alpha"), 1)),
                option: OptionName::WindowStyle,
                value: "fg=colour9".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));

    // Kill pane 1
    assert!(matches!(
        handler
            .handle(Request::KillPane(berth_term_proto::KillPaneRequest {
                target: PaneTarget::new(session_name("alpha"), 1),
                kill_all_except: false,
            }))
            .await,
        Response::KillPane(_)
    ));

    // Verify pane option is cleaned up
    let state = handler.state.lock().await;
    assert_eq!(
        state.options.pane_value(
            &PaneTarget::new(session_name("alpha"), 1),
            OptionName::WindowStyle
        ),
        None
    );
}

#[tokio::test]
async fn set_option_at_window_scope_rejects_nonexistent_window() {
    let handler = RequestHandler::new();
    create_session(&handler, "alpha").await;

    assert_eq!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Window(WindowTarget::with_window(session_name("alpha"), 99)),
                option: OptionName::MainPaneWidth,
                value: "120".to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::Error(ErrorResponse {
            error: TerminalError::invalid_target(
                "alpha:99",
                "window index does not exist in session",
            ),
        })
    );
}
