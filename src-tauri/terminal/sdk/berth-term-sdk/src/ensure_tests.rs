use super::*;
use crate::transport::TransportClient;
use berth_term_proto::{
    encode_frame, FrameDecoder, HandshakeRequest, HandshakeResponse, NewSessionResponse,
    ProcessCommand, CAPABILITY_HANDSHAKE, CAPABILITY_SDK_PROCESS_COMMAND, BERTH_TERM_WIRE_VERSION,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn process_command_session_requires_capability_before_request() {
    let (client_stream, mut server_stream) = tokio::io::duplex(4096);
    let client = TransportClient::spawn(client_stream);
    let builder = EnsureSession::try_named("capability-process")
        .expect("valid session")
        .create_only()
        .argv(["sh", "-c", "printf ready"]);

    let client_future = create_session(&client, &builder, false);
    let server_future = async {
        assert_capability_handshake(read_request(&mut server_stream).await);
        write_response(
            &mut server_stream,
            &Response::Handshake(HandshakeResponse {
                wire_version: BERTH_TERM_WIRE_VERSION,
                capabilities: vec![CAPABILITY_HANDSHAKE.to_owned()],
            }),
        )
        .await;
    };
    let (result, ()) = tokio::join!(client_future, server_future);

    match result.expect_err("missing process-command capability must fail before new-session") {
        TerminalError::Unsupported { feature, .. } => {
            assert_eq!(feature, CAPABILITY_SDK_PROCESS_COMMAND);
        }
        error => panic!("expected unsupported process-command capability, got {error:?}"),
    }
}

#[tokio::test]
async fn process_command_session_sends_request_after_capability() {
    let (client_stream, mut server_stream) = tokio::io::duplex(4096);
    let client = TransportClient::spawn(client_stream);
    let session_name = SessionName::new("capability-process").expect("valid session");
    let builder = EnsureSession::named(session_name.clone())
        .create_only()
        .argv(["sh", "-c", "printf ready"]);

    let client_future = create_session(&client, &builder, false);
    let server_future = async {
        assert_capability_handshake(read_request(&mut server_stream).await);
        write_response(
            &mut server_stream,
            &Response::Handshake(HandshakeResponse {
                wire_version: BERTH_TERM_WIRE_VERSION,
                capabilities: vec![
                    CAPABILITY_HANDSHAKE.to_owned(),
                    CAPABILITY_SDK_PROCESS_COMMAND.to_owned(),
                ],
            }),
        )
        .await;

        match read_request(&mut server_stream).await {
            Request::NewSessionExt(request) => {
                assert_eq!(
                    request.process_command,
                    Some(ProcessCommand::Argv(vec![
                        "sh".to_owned(),
                        "-c".to_owned(),
                        "printf ready".to_owned(),
                    ]))
                );
                write_response(
                    &mut server_stream,
                    &Response::NewSession(NewSessionResponse {
                        session_name,
                        detached: true,
                        output: None,
                        created_pane: None,
                    }),
                )
                .await;
            }
            request => panic!("expected new-session after capability, got {request:?}"),
        }
    };
    let (result, ()) = tokio::join!(client_future, server_future);

    assert_eq!(
        result.expect("new-session succeeds").session_name,
        SessionName::new("capability-process").expect("valid session")
    );
}

/// `environment()` 与 `process()`/`argv()` 组合时 env 必须保留——曾因
/// `process()` 整体替换丢掉 env，导致新建会话的 provider 注入失效。
#[test]
fn environment_survives_process_spec_replacement() {
    let named = || SessionName::new("env-composition").expect("valid session");

    let via_process = EnsureSession::named(named())
        .environment(["ANTHROPIC_BASE_URL=https://relay.example"])
        .process(ProcessSpec::argv(["claude"]));
    assert_eq!(
        via_process.to_new_session_request(false).environment,
        Some(vec!["ANTHROPIC_BASE_URL=https://relay.example".to_owned()]),
        "process() must not drop a previously set environment"
    );

    let via_argv = EnsureSession::named(named())
        .environment(["ANTHROPIC_BASE_URL=https://relay.example"])
        .argv(["claude"]);
    assert_eq!(
        via_argv.to_new_session_request(false).environment,
        Some(vec!["ANTHROPIC_BASE_URL=https://relay.example".to_owned()])
    );

    // 显式带 env 的 spec 仍按 spec 为准（替换语义不被悄悄改写）。
    let explicit = EnsureSession::named(named()).process(ProcessSpec {
        command: None,
        process_command: Some(ProcessCommandSpec::Argv(vec!["claude".to_owned()])),
        environment: Some(vec!["A=1".to_owned()]),
    });
    assert_eq!(
        explicit.to_new_session_request(false).environment,
        Some(vec!["A=1".to_owned()])
    );
}

fn assert_capability_handshake(request: Request) {
    match request {
        Request::Handshake(HandshakeRequest {
            required_capabilities,
            ..
        }) => assert_eq!(required_capabilities, vec![CAPABILITY_HANDSHAKE.to_owned()]),
        request => panic!("expected capability handshake, got {request:?}"),
    }
}

async fn read_request(stream: &mut tokio::io::DuplexStream) -> Request {
    let mut decoder = FrameDecoder::new();
    let mut buffer = [0_u8; 4096];
    loop {
        if let Some(request) = decoder
            .next_frame::<Request>()
            .expect("request frame decodes")
        {
            return request;
        }
        let read = stream.read(&mut buffer).await.expect("read request bytes");
        assert_ne!(read, 0, "client closed before request arrived");
        decoder.push_bytes(&buffer[..read]);
    }
}

async fn write_response(stream: &mut tokio::io::DuplexStream, response: &Response) {
    let frame = encode_frame(response).expect("response encodes");
    stream.write_all(&frame).await.expect("write response");
    stream.flush().await.expect("flush response");
}
