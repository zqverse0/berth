#![cfg(unix)]

use std::error::Error;

mod common;

use berth_term_proto::{
    NewSessionRequest, PaneTarget, PasteBufferRequest, Request, Response, SetBufferRequest,
    ShowBufferRequest, TerminalSize,
};
use common::{send_request, session_name, start_server, TestHarness};

async fn create_session(harness: &TestHarness, name: &str) -> Result<(), Box<dyn Error>> {
    let response = send_request(
        harness.socket_path(),
        &Request::NewSession(NewSessionRequest {
            session_name: session_name(name),
            detached: true,
            size: Some(TerminalSize { cols: 80, rows: 24 }),
            environment: None,
        }),
    )
    .await?;
    assert!(matches!(response, Response::NewSession(_)));
    Ok(())
}

#[tokio::test]
async fn set_and_show_buffer_round_trips_through_real_socket() -> Result<(), Box<dyn Error>> {
    let harness = TestHarness::new("buf-set-show");
    let handle = start_server(&harness).await?;

    let set_response = send_request(
        harness.socket_path(),
        &Request::SetBuffer(SetBufferRequest {
            name: None,
            content: b"hello world".to_vec(),
            append: false,
            new_name: None,
            set_clipboard: false,
        }),
    )
    .await?;

    match &set_response {
        Response::SetBuffer(r) => assert_eq!(r.buffer_name, "buffer0"),
        other => panic!("expected SetBuffer, got {other:?}"),
    }

    let show_response = send_request(
        harness.socket_path(),
        &Request::ShowBuffer(ShowBufferRequest { name: None }),
    )
    .await?;

    let output = show_response
        .command_output()
        .expect("show-buffer returns output");
    assert_eq!(output.stdout(), b"hello world");

    handle.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn paste_buffer_to_session_pane_through_real_socket() -> Result<(), Box<dyn Error>> {
    let harness = TestHarness::new("buf-paste");
    let handle = start_server(&harness).await?;
    create_session(&harness, "alpha").await?;

    send_request(
        harness.socket_path(),
        &Request::SetBuffer(SetBufferRequest {
            name: None,
            content: b"paste-me".to_vec(),
            append: false,
            new_name: None,
            set_clipboard: false,
        }),
    )
    .await?;

    let paste_response = send_request(
        harness.socket_path(),
        &Request::PasteBuffer(Box::new(PasteBufferRequest {
            name: None,
            target: PaneTarget::new(session_name("alpha"), 0),
            delete_after: false,
            separator: None,
            linefeed: false,
            raw: false,
            bracketed: false,
        })),
    )
    .await?;

    match &paste_response {
        Response::PasteBuffer(r) => assert_eq!(r.buffer_name, "buffer0"),
        other => panic!("expected PasteBuffer, got {other:?}"),
    }

    // Buffer should still exist
    let show = send_request(
        harness.socket_path(),
        &Request::ShowBuffer(ShowBufferRequest { name: None }),
    )
    .await?;
    assert!(matches!(show, Response::ShowBuffer(_)));

    handle.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn paste_buffer_with_delete_removes_buffer_through_real_socket() -> Result<(), Box<dyn Error>>
{
    let harness = TestHarness::new("buf-paste-del");
    let handle = start_server(&harness).await?;
    create_session(&harness, "alpha").await?;

    send_request(
        harness.socket_path(),
        &Request::SetBuffer(SetBufferRequest {
            name: None,
            content: b"temp".to_vec(),
            append: false,
            new_name: None,
            set_clipboard: false,
        }),
    )
    .await?;

    let paste_response = send_request(
        harness.socket_path(),
        &Request::PasteBuffer(Box::new(PasteBufferRequest {
            name: None,
            target: PaneTarget::new(session_name("alpha"), 0),
            delete_after: true,
            separator: None,
            linefeed: false,
            raw: false,
            bracketed: false,
        })),
    )
    .await?;
    assert!(matches!(paste_response, Response::PasteBuffer(_)));

    // Buffer should be gone
    let show = send_request(
        harness.socket_path(),
        &Request::ShowBuffer(ShowBufferRequest { name: None }),
    )
    .await?;
    assert!(matches!(show, Response::Error(_)));

    handle.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn show_buffer_empty_store_returns_error_through_real_socket() -> Result<(), Box<dyn Error>> {
    let harness = TestHarness::new("buf-show-empty");
    let handle = start_server(&harness).await?;

    let response = send_request(
        harness.socket_path(),
        &Request::ShowBuffer(ShowBufferRequest { name: None }),
    )
    .await?;
    assert!(matches!(response, Response::Error(_)));

    handle.shutdown().await?;
    Ok(())
}
