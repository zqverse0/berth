//! 创建回执只在尾部扩展；旧 wire 值与双向 bincode 解码保持兼容。

use serde::{Deserialize, Serialize};
use berth_term_proto::{
    decode_frame, encode_frame, CommandOutput, CreatedPane, FrameDecoder, HandshakeResponse,
    NewSessionResponse, NewWindowResponse, PaneId, Response, SessionName, WindowTarget,
    CAPABILITY_TERMINAL_CREATE_BINDING,
};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct LegacySession {
    session_name: SessionName,
    detached: bool,
    output: Option<CommandOutput>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct LegacyWindow {
    target: WindowTarget,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
enum LegacyResponse {
    NewSession(LegacySession),
    HasSession,
    KillSession,
    NewWindow(LegacyWindow),
}

fn session() -> SessionName {
    SessionName::new("create-compat").unwrap()
}

fn created() -> CreatedPane {
    CreatedPane {
        pane_id: PaneId::new(29),
        generation: 7,
        window_index: 3,
        pane_index: 0,
    }
}

#[test]
fn create_binding_old_session_and_window_frames_decode_without_receipt() {
    for (legacy, current) in [
        (
            LegacyResponse::NewSession(LegacySession {
                session_name: session(),
                detached: true,
                output: Some(CommandOutput::from_stdout(b"old output\n".to_vec())),
            }),
            Response::NewSession(NewSessionResponse {
                session_name: session(),
                detached: true,
                output: Some(CommandOutput::from_stdout(b"old output\n".to_vec())),
                created_pane: None,
            }),
        ),
        (
            LegacyResponse::NewWindow(LegacyWindow {
                target: WindowTarget::with_window(session(), 3),
            }),
            Response::NewWindow(NewWindowResponse {
                target: WindowTarget::with_window(session(), 3),
                created_pane: None,
            }),
        ),
    ] {
        let old = encode_frame(&legacy).unwrap();
        // None 不追加尾部，原 fixture 的字节和值都不能为测试过关而重写。
        assert_eq!(encode_frame(&current).unwrap(), old);
        assert_eq!(decode_frame::<Response>(&old).unwrap(), current);
        let mut decoder = FrameDecoder::new();
        for byte in old {
            decoder.push_bytes(&[byte]);
        }
        assert_eq!(decoder.next_frame::<Response>().unwrap(), Some(current));
    }
}

#[test]
fn create_binding_new_receipts_round_trip_and_old_reader_keeps_original_fields() {
    for (response, legacy) in [
        (
            Response::NewSession(NewSessionResponse {
                session_name: session(),
                detached: true,
                output: None,
                created_pane: Some(Box::new(created())),
            }),
            LegacyResponse::NewSession(LegacySession {
                session_name: session(),
                detached: true,
                output: None,
            }),
        ),
        (
            Response::NewWindow(NewWindowResponse {
                target: WindowTarget::with_window(session(), 3),
                created_pane: Some(Box::new(created())),
            }),
            LegacyResponse::NewWindow(LegacyWindow {
                target: WindowTarget::with_window(session(), 3),
            }),
        ),
    ] {
        let frame = encode_frame(&response).unwrap();
        assert_eq!(decode_frame::<Response>(&frame).unwrap(), response);
        assert_eq!(decode_frame::<LegacyResponse>(&frame).unwrap(), legacy);
        let json = serde_json::to_string(&response).unwrap();
        assert_eq!(serde_json::from_str::<Response>(&json).unwrap(), response);
    }
}

#[test]
fn create_binding_invalid_tail_is_not_treated_as_legacy_eof() {
    let mut bytes = bincode::serialize(&LegacyWindow {
        target: WindowTarget::with_window(session(), 3),
    })
    .unwrap();
    bytes.push(2);
    assert!(bincode::deserialize::<NewWindowResponse>(&bytes).is_err());
}

#[test]
fn create_binding_is_advertised_by_current_handshake() {
    assert!(HandshakeResponse::current()
        .capabilities
        .iter()
        .any(|capability| capability == CAPABILITY_TERMINAL_CREATE_BINDING));
}
