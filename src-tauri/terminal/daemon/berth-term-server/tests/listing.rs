#![cfg(unix)]

use std::error::Error;

mod common;

use berth_term_proto::{
    HasSessionRequest, ListPanesRequest, ListSessionsRequest, NewSessionRequest, NewWindowRequest,
    Request, Response, ScopeSelector, SendKeysRequest, SetOptionMode, SetOptionRequest,
    ShowOptionsRequest, SplitWindowRequest, SplitWindowTarget, TerminalSize, WindowTarget,
};
use common::{send_request, session_name, start_server, TestHarness};

#[tokio::test]
async fn list_sessions_uses_shared_formatter_through_real_socket() -> Result<(), Box<dyn Error>> {
    let harness = TestHarness::new("listing-list-sessions");
    let handle = start_server(&harness).await?;
    let alpha = session_name("alpha");
    let beta = session_name("beta");

    for (session_name, size) in [
        (
            beta.clone(),
            TerminalSize {
                cols: 120,
                rows: 40,
            },
        ),
        (alpha.clone(), TerminalSize { cols: 80, rows: 24 }),
    ] {
        let created = send_request(
            harness.socket_path(),
            &Request::NewSession(NewSessionRequest {
                session_name,
                detached: true,
                size: Some(size),

                environment: None,
            }),
        )
        .await?;
        assert!(matches!(created, Response::NewSession(_)));
    }

    let new_window = send_request(
        harness.socket_path(),
        &Request::NewWindow(Box::new(NewWindowRequest {
            target: alpha,
            name: Some("logs".to_owned()),
            detached: true,
            start_directory: None,
            environment: None,
            command: None,
            process_command: None,
            target_window_index: None,
            insert_at_target: false,
        })),
    )
    .await?;
    assert!(matches!(new_window, Response::NewWindow(_)));

    let listed = send_request(
        harness.socket_path(),
        &Request::ListSessions(ListSessionsRequest {
            format: Some(
                "#{session_name}:#{session_windows}:#{session_attached}:#{session_width}x#{session_height}"
                    .to_owned(),
            ),
            filter: None,
            sort_order: None,
            reversed: false,
            }),
    )
    .await?;

    let output = listed
        .command_output()
        .expect("list-sessions returns command output");
    assert_eq!(
        std::str::from_utf8(output.stdout()).expect("list-sessions output is utf-8"),
        "alpha:2:0:x\nbeta:1:0:x\n"
    );

    handle.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn list_panes_uses_shared_formatter_through_real_socket() -> Result<(), Box<dyn Error>> {
    let harness = TestHarness::new("listing-list-panes");
    let handle = start_server(&harness).await?;
    let alpha = session_name("alpha");

    let created = send_request(
        harness.socket_path(),
        &Request::NewSession(NewSessionRequest {
            session_name: alpha.clone(),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
        }),
    )
    .await?;
    assert!(matches!(created, Response::NewSession(_)));

    let split = send_request(
        harness.socket_path(),
        &Request::SplitWindow(SplitWindowRequest {
            target: SplitWindowTarget::Session(alpha.clone()),
            direction: berth_term_proto::SplitDirection::Vertical,
            before: false,
            environment: None,
        }),
    )
    .await?;
    assert!(matches!(split, Response::SplitWindow(_)));

    let new_window = send_request(
        harness.socket_path(),
        &Request::NewWindow(Box::new(NewWindowRequest {
            target: alpha.clone(),
            name: Some("logs".to_owned()),
            detached: true,
            start_directory: None,
            environment: None,
            command: None,
            process_command: None,
            target_window_index: None,
            insert_at_target: false,
        })),
    )
    .await?;
    assert!(matches!(new_window, Response::NewWindow(_)));

    let listed = send_request(
        harness.socket_path(),
        &Request::ListPanes(ListPanesRequest {
            target: alpha,
            format: Some(
                "#{session_name}:#{window_index}:#{pane_index}:#{pane_id}:#{pane_active}"
                    .to_owned(),
            ),
            target_window_index: None,
        }),
    )
    .await?;

    let output = listed
        .command_output()
        .expect("list-panes returns command output");
    assert_eq!(
        std::str::from_utf8(output.stdout()).expect("list-panes output is utf-8"),
        "alpha:0:0:%0:0\nalpha:0:1:%1:1\nalpha:1:0:%2:1\n"
    );

    handle.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn rename_session_round_trips_and_migrates_session_scoped_state() -> Result<(), Box<dyn Error>>
{
    let harness = TestHarness::new("listing-rename-session");
    let handle = start_server(&harness).await?;
    let alpha = session_name("alpha");
    let gamma = session_name("gamma");

    let created = send_request(
        harness.socket_path(),
        &Request::NewSession(NewSessionRequest {
            session_name: alpha.clone(),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
        }),
    )
    .await?;
    assert!(matches!(created, Response::NewSession(_)));

    assert!(matches!(
        send_request(
            harness.socket_path(),
            &Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Window(WindowTarget::new(alpha.clone())),
                option: berth_term_proto::OptionName::PaneBorderStyle,
                value: "red".to_owned(),
                mode: SetOptionMode::Replace,
            }),
        )
        .await?,
        Response::SetOption(_)
    ));

    let renamed = send_request(
        harness.socket_path(),
        &Request::RenameSession(berth_term_proto::RenameSessionRequest {
            target: alpha.clone(),
            new_name: gamma.clone(),
        }),
    )
    .await?;
    assert_eq!(
        renamed,
        Response::RenameSession(berth_term_proto::RenameSessionResponse {
            session_name: gamma.clone(),
        })
    );

    assert_eq!(
        send_request(
            harness.socket_path(),
            &Request::HasSession(HasSessionRequest {
                target: alpha.clone(),
            }),
        )
        .await?,
        Response::HasSession(berth_term_proto::HasSessionResponse { exists: false })
    );
    assert_eq!(
        send_request(
            harness.socket_path(),
            &Request::HasSession(HasSessionRequest {
                target: gamma.clone(),
            }),
        )
        .await?,
        Response::HasSession(berth_term_proto::HasSessionResponse { exists: true })
    );

    let options = send_request(
        harness.socket_path(),
        &Request::ShowOptions(ShowOptionsRequest {
            scope: berth_term_proto::OptionScopeSelector::Window(WindowTarget::new(gamma.clone())),
            name: None,
            value_only: false,
            include_inherited: true,
            quiet: false,
        }),
    )
    .await?;
    let options_output = options
        .command_output()
        .expect("show-options returns command output");
    assert!(std::str::from_utf8(options_output.stdout())
        .expect("options output is utf-8")
        .contains("pane-border-style red"));

    let sent = send_request(
        harness.socket_path(),
        &Request::SendKeys(SendKeysRequest {
            target: berth_term_proto::PaneTarget::with_window(gamma.clone(), 0, 0),
            keys: vec!["printf noop".to_owned(), "Enter".to_owned()],
        }),
    )
    .await?;
    assert!(matches!(sent, Response::SendKeys(_)));

    handle.shutdown().await?;
    Ok(())
}
