#![cfg(unix)]

use std::error::Error;

mod common;

use berth_term_proto::{
    NewSessionRequest, OptionName, Request, Response, ScopeSelector, SetOptionMode,
    SetOptionRequest, TerminalError,
};
use common::{send_request, session_name, start_server, TestHarness};

#[tokio::test]
async fn set_option_round_trips_and_invalid_variants_fail_cleanly() -> Result<(), Box<dyn Error>> {
    let harness = TestHarness::new("set-option");
    let socket_path = harness.socket_path().to_path_buf();
    let handle = start_server(&harness).await?;

    let created = send_request(
        &socket_path,
        &Request::NewSession(NewSessionRequest {
            session_name: session_name("alpha"),
            detached: true,
            size: None,
            environment: None,
        }),
    )
    .await?;
    assert!(matches!(created, Response::NewSession(_)));

    let global_status = send_request(
        &socket_path,
        &Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Global,
            option: OptionName::Status,
            value: "off".to_owned(),
            mode: SetOptionMode::Replace,
        }),
    )
    .await?;
    assert_eq!(
        global_status,
        Response::SetOption(berth_term_proto::SetOptionResponse {
            scope: ScopeSelector::Global,
            option: OptionName::Status,
            mode: SetOptionMode::Replace,
        })
    );

    let session_status = send_request(
        &socket_path,
        &Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Session(session_name("alpha")),
            option: OptionName::Status,
            value: "on".to_owned(),
            mode: SetOptionMode::Replace,
        }),
    )
    .await?;
    assert_eq!(
        session_status,
        Response::SetOption(berth_term_proto::SetOptionResponse {
            scope: ScopeSelector::Session(session_name("alpha")),
            option: OptionName::Status,
            mode: SetOptionMode::Replace,
        })
    );

    let scalar_append = send_request(
        &socket_path,
        &Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Global,
            option: OptionName::Status,
            value: "off".to_owned(),
            mode: SetOptionMode::Append,
        }),
    )
    .await?;
    assert_eq!(
        scalar_append,
        Response::Error(berth_term_proto::ErrorResponse {
            error: TerminalError::InvalidSetOption("status is not an array option".to_owned()),
        })
    );

    let invalid_scope = send_request(
        &socket_path,
        &Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Session(session_name("alpha")),
            option: OptionName::TerminalFeatures,
            value: "xterm*:RGB".to_owned(),
            mode: SetOptionMode::Replace,
        }),
    )
    .await?;
    assert_eq!(
        invalid_scope,
        Response::Error(berth_term_proto::ErrorResponse {
            error: TerminalError::InvalidSetOption(
                "terminal-features is only supported at global scope".to_owned()
            ),
        })
    );

    handle.shutdown().await?;
    Ok(())
}
