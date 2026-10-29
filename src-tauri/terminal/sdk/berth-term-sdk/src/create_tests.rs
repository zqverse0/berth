use super::*;
use std::time::Duration;

use crate::transport::TransportClient;
use berth_term_proto::{
    daemon_instance_capability, encode_frame, CreatedPane, ErrorResponse, FrameDecoder,
    HandshakeResponse, HasSessionResponse, NewSessionResponse, NewWindowResponse,
    PaneBindingFailure, PaneId, PaneTargetRef, PaneWindowOperation, Request, ResizeWindowResponse,
    Response, TerminalError as ProtocolError, WindowTarget, CAPABILITY_HANDSHAKE,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

const EPOCH: &str = "0123456789abcdef0123456789abcdef";

fn request() -> CreateTerminal {
    CreateTerminal {
        session: SessionName::new("create-test").unwrap(),
        window_name: "my-terminal".to_owned(),
        cwd: "/synthetic-project".to_owned(),
        process: ProcessSpec::argv(["sh"]),
        size: TerminalSizeSpec::new(120, 32),
        detached: true,
        keep_on_failed_exit: false,
    }
}

fn receipt() -> CreatedPane {
    CreatedPane {
        pane_id: PaneId::new(43),
        generation: 7,
        window_index: 3,
        pane_index: 0,
    }
}

fn handshake() -> HandshakeResponse {
    let mut handshake = HandshakeResponse::current();
    handshake
        .capabilities
        .push(daemon_instance_capability(EPOCH));
    handshake
}

fn prefix(exists: bool) -> Vec<Response> {
    vec![
        Response::Handshake(handshake()),
        Response::HasSession(HasSessionResponse { exists }),
    ]
}

fn session_response(created_pane: Option<CreatedPane>) -> Response {
    Response::NewSession(NewSessionResponse {
        session_name: request().session,
        detached: created_pane.is_some(),
        output: None,
        created_pane: created_pane.map(Box::new),
    })
}

fn window_response(created_pane: Option<CreatedPane>) -> Response {
    Response::NewWindow(NewWindowResponse {
        target: WindowTarget::with_window(request().session, receipt().window_index),
        created_pane: created_pane.map(Box::new),
    })
}

fn resized() -> Response {
    Response::ResizeWindow(ResizeWindowResponse {
        target: WindowTarget::with_window(request().session, receipt().window_index),
    })
}

async fn read_request(stream: &mut DuplexStream, decoder: &mut FrameDecoder) -> Request {
    let mut buffer = [0_u8; 4096];
    loop {
        if let Some(request) = decoder.next_frame::<Request>().expect("request frame") {
            return request;
        }
        let read = stream.read(&mut buffer).await.expect("read request");
        assert_ne!(read, 0, "client closed before the expected request");
        decoder.push_bytes(&buffer[..read]);
    }
}

/// 每个响应对应一个请求；丢回执时只读最后一次请求后断连，禁止测试偷偷重发。
async fn scripted_create(
    responses: Vec<Response>,
    lose_last_receipt: bool,
) -> (Result<CreatedTerminal>, Vec<Request>) {
    let (client_stream, mut peer) = tokio::io::duplex(8192);
    let terminal = Terminal::from_transport_for_test(TransportClient::spawn(client_stream), None);
    let server = async move {
        let mut requests = Vec::new();
        let mut decoder = FrameDecoder::new();
        for response in responses {
            requests.push(read_request(&mut peer, &mut decoder).await);
            peer.write_all(&encode_frame(&response).unwrap())
                .await
                .unwrap();
        }
        if lose_last_receipt {
            requests.push(read_request(&mut peer, &mut decoder).await);
            (requests, None)
        } else {
            (requests, Some(peer))
        }
    };
    let (result, (requests, peer)) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(terminal.create_terminal(request()), server)
    })
    .await
    .expect("creation must finish without extra requests or retries");
    if let Some(mut peer) = peer {
        let mut byte = [0_u8; 1];
        assert!(
            tokio::time::timeout(Duration::from_millis(20), peer.read(&mut byte))
                .await
                .is_err(),
            "no unsolicited cleanup, discovery or repeated creation"
        );
    }
    assert!(matches!(&requests[0], Request::Handshake(request)
        if request.required_capabilities == [CAPABILITY_HANDSHAKE]));
    (result, requests)
}

fn assert_session_request(actual: &Request, reuse: bool) {
    let Request::NewSessionExt(actual) = actual else {
        panic!("expected new-session, got {actual:?}");
    };
    let expected = request();
    assert_eq!(actual.session_name.as_ref(), Some(&expected.session));
    assert_eq!(actual.attach_if_exists, reuse);
    assert_eq!(
        actual.window_name.as_deref(),
        Some(expected.window_name.as_str())
    );
    assert_eq!(
        actual.working_directory.as_deref(),
        Some(expected.cwd.as_str())
    );
    assert!(actual.detached);
}

fn assert_window_request(actual: &Request) {
    let Request::NewWindow(actual) = actual else {
        panic!("expected new-window, got {actual:?}");
    };
    let expected = request();
    assert_eq!(actual.target, expected.session);
    assert_eq!(actual.name.as_deref(), Some(expected.window_name.as_str()));
    assert_eq!(
        actual.start_directory.as_deref(),
        Some(std::path::Path::new(&expected.cwd))
    );
    assert!(actual.detached);
}

fn assert_birth_binding(created: CreatedTerminal, resize: &Request) {
    let birth = receipt();
    assert_eq!(created.binding.daemon_instance.as_deref(), Some(EPOCH));
    assert_eq!(created.binding.session, request().session);
    assert_eq!(created.binding.pane_id, birth.pane_id);
    assert_eq!(created.binding.generation, birth.generation);
    assert!(created.pane.is_generation_guarded());
    let Request::PaneWindow(resize) = resize else {
        panic!("expected guarded resize, got {resize:?}");
    };
    assert_eq!(
        resize.target,
        PaneTargetRef::guarded_by_id(request().session, birth.pane_id, birth.generation)
    );
    assert_eq!(
        resize.operation,
        PaneWindowOperation::Resize {
            width: 120,
            height: 32
        }
    );
}

#[tokio::test]
async fn new_or_recreated_session_uses_only_atomic_birth_receipt() {
    // has-session 与 create 之间被删除的 session：回执证明是本次重建，不再多建 window。
    for existed in [false, true] {
        let mut responses = prefix(existed);
        responses.extend([session_response(Some(receipt())), resized()]);
        let (result, requests) = scripted_create(responses, false).await;
        assert_eq!(requests.len(), 4);
        assert_session_request(&requests[2], existed);
        assert_birth_binding(result.expect("confirmed creation"), &requests[3]);
    }
}

#[tokio::test]
async fn existing_session_creates_its_own_detached_window() {
    let mut responses = prefix(true);
    responses.extend([
        session_response(None),
        window_response(Some(receipt())),
        resized(),
    ]);
    let (result, requests) = scripted_create(responses, false).await;
    assert_eq!(requests.len(), 5);
    assert_session_request(&requests[2], true);
    assert_window_request(&requests[3]);
    assert_birth_binding(result.expect("new window identity"), &requests[4]);
}

#[tokio::test]
async fn duplicate_race_reuses_container_but_creates_its_own_pane() {
    let mut responses = prefix(false);
    responses.extend([
        Response::Error(ErrorResponse {
            error: ProtocolError::DuplicateSession(request().session.to_string()),
        }),
        session_response(None),
        window_response(Some(receipt())),
        resized(),
    ]);
    let (result, requests) = scripted_create(responses, false).await;
    assert_eq!(requests.len(), 6);
    assert_session_request(&requests[2], false);
    assert_session_request(&requests[3], true);
    assert_window_request(&requests[4]);
    assert_birth_binding(result.expect("own pane after duplicate"), &requests[5]);
}

#[tokio::test]
async fn missing_create_identity_capabilities_reject_before_any_creation() {
    for capability in [
        CAPABILITY_TERMINAL_CREATE_BINDING,
        CAPABILITY_SDK_PANE_BY_ID,
        CAPABILITY_SDK_PANE_GENERATION_GUARD,
        CAPABILITY_DAEMON_INSTANCE_PREFIX,
    ] {
        let mut handshake = handshake();
        handshake
            .capabilities
            .retain(|value| !value.starts_with(capability));
        let (result, requests) = scripted_create(vec![Response::Handshake(handshake)], false).await;
        assert_eq!(requests.len(), 1);
        assert!(
            matches!(result, Err(TerminalError::Unsupported { feature, .. }) if feature == capability)
        );
    }
}

#[tokio::test]
async fn missing_or_zero_generation_receipts_do_not_trigger_another_creation() {
    for existing in [false, true] {
        for created in [
            None,
            Some(CreatedPane {
                generation: 0,
                ..receipt()
            }),
        ] {
            let mut responses = prefix(existing);
            if existing {
                responses.extend([session_response(None), window_response(created)]);
            } else {
                responses.push(session_response(created));
            }
            let (result, requests) = scripted_create(responses, false).await;
            assert_eq!(requests.len(), if existing { 4 } else { 3 });
            assert!(
                matches!(result, Err(TerminalError::Transport { source, .. })
                if source.kind() == io::ErrorKind::InvalidData)
            );
        }
    }
}

#[tokio::test]
async fn inconsistent_receipt_scope_is_rejected_without_discovery() {
    let mut wrong_session = session_response(Some(receipt()));
    if let Response::NewSession(response) = &mut wrong_session {
        response.session_name = SessionName::new("another-project").unwrap();
    }
    let mut responses = prefix(false);
    responses.push(wrong_session);
    let (result, requests) = scripted_create(responses, false).await;
    assert_eq!(requests.len(), 3);
    assert!(result.is_err());

    let mut responses = prefix(true);
    responses.extend([
        session_response(None),
        window_response(Some(CreatedPane {
            window_index: 99,
            ..receipt()
        })),
    ]);
    let (result, requests) = scripted_create(responses, false).await;
    assert_eq!(requests.len(), 4);
    assert!(result.is_err());
}

#[tokio::test]
async fn respawn_before_resize_rejects_without_rebinding_or_recreating() {
    let mut responses = prefix(false);
    responses.extend([
        session_response(Some(receipt())),
        Response::Error(ErrorResponse {
            error: ProtocolError::pane_binding_invalid(PaneBindingFailure::StaleGeneration),
        }),
    ]);
    let (result, requests) = scripted_create(responses, false).await;
    assert_eq!(requests.len(), 4);
    let Request::PaneWindow(resize) = &requests[3] else {
        panic!("guarded resize")
    };
    assert_eq!(
        resize.target,
        PaneTargetRef::guarded_by_id(request().session, receipt().pane_id, 7)
    );
    assert!(matches!(
        result,
        Err(TerminalError::Protocol {
            source: ProtocolError::PaneBindingInvalid { .. }
        })
    ));
}

#[tokio::test]
async fn lost_creation_receipt_never_retries_session_or_window() {
    for existing in [false, true] {
        let mut responses = prefix(existing);
        if existing {
            responses.push(session_response(None));
        }
        let (result, requests) = scripted_create(responses, true).await;
        assert_eq!(requests.len(), if existing { 4 } else { 3 });
        if existing {
            assert_window_request(requests.last().unwrap());
        } else {
            assert_session_request(requests.last().unwrap(), false);
        }
        assert!(matches!(result, Err(TerminalError::Transport { .. })));
    }
}
