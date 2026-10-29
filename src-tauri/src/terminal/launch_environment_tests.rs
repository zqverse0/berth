//! 只截取合成 socket 上的创建请求，不连接真实 daemon，也不修改进程环境。

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use berth_project_core::instance::DataInstance;
use berth_term_proto::{
    encode_frame, FrameDecoder, HandshakeResponse, HasSessionResponse, Request, Response,
};
use berth_term_sdk::berth::{SessionName, Terminal};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

use super::super::validation::TerminalLaunchEnvironment;
use super::create_remote_terminal;

#[tokio::test]
async fn launch_environment_new_session_uses_host_instance_and_preserves_caller_values() {
    assert_creation_environment(false).await;
}

#[tokio::test]
async fn launch_environment_existing_session_new_window_refreshes_host_instance() {
    assert_creation_environment(true).await;
}

async fn assert_creation_environment(existing_session: bool) {
    let root = tempfile::tempdir().expect("synthetic environment root");
    let socket = root.path().join("requests.sock");
    let data = root.path().join("data");
    let home = root.path().join("assets");
    let tmpdir = root.path().join("sockets");
    let gui = root.path().join("gui.sock");
    let cli = root.path().join("cli/berth");
    let instance = DataInstance::create_if_missing(&data, "berth.db");
    let host = TerminalLaunchEnvironment::from_resolved_paths(
        instance.data_dir(),
        instance.db_file_name(),
        &gui,
        &tmpdir,
        &home,
        Some(&cli),
        Some("/host/bin".to_owned()),
    )
    .expect("synthetic resolved host environment");
    let caller = HashMap::from([
        ("BERTH_DATA_DIR".to_owned(), "/old-instance/data".to_owned()),
        ("BERTH_DATA_FILE".to_owned(), "stale-custom.db".to_owned()),
        (
            "BERTH_GUI_ENDPOINT".to_owned(),
            "/old-instance/gui".to_owned(),
        ),
        (
            "BERTH_TMPDIR".to_owned(),
            "/old-instance/sockets".to_owned(),
        ),
        ("BERTH_HOME".to_owned(), "/old-instance/assets".to_owned()),
        ("PATH".to_owned(), "/agent/bin:/host/bin".to_owned()),
        (
            "CALLER_VALUE".to_owned(),
            "preserve=value=exactly".to_owned(),
        ),
    ]);

    let listener = UnixListener::bind(&socket).expect("isolated request socket");
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("SDK connection");
        let mut decoder = FrameDecoder::new();
        let mut buffer = [0_u8; 8192];
        loop {
            let request = loop {
                if let Some(request) = decoder.next_frame::<Request>().expect("request frame") {
                    break request;
                }
                let read = stream.read(&mut buffer).await.expect("read request");
                assert_ne!(read, 0, "SDK closed before sending a creation request");
                decoder.push_bytes(&buffer[..read]);
            };
            let response = match request {
                Request::Handshake(_) => {
                    let mut response = HandshakeResponse::current();
                    response
                        .capabilities
                        .push(berth_term_proto::daemon_instance_capability(
                            "0123456789abcdef0123456789abcdef",
                        ));
                    Response::Handshake(response)
                }
                Request::HasSession(_) => Response::HasSession(HasSessionResponse {
                    exists: existing_session,
                }),
                Request::NewSessionExt(request) => {
                    if !existing_session {
                        return request.environment;
                    }
                    assert!(
                        request.attach_if_exists,
                        "reuse must not claim another pane"
                    );
                    Response::NewSession(berth_term_proto::NewSessionResponse {
                        session_name: request.session_name.expect("explicit session"),
                        detached: false,
                        output: None,
                        created_pane: None,
                    })
                }
                Request::NewWindow(request) => {
                    assert!(existing_session, "missing session must create a session");
                    return request.environment;
                }
                other => panic!("unexpected synthetic request: {other:?}"),
            };
            stream
                .write_all(&encode_frame(&response).expect("encode response"))
                .await
                .expect("send response");
        }
    });

    let terminal = Terminal::builder()
        .unix_socket(socket)
        .connect()
        .await
        .expect("connect to synthetic protocol peer");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        create_remote_terminal(
            &terminal,
            "environment-test".to_owned(),
            Some(SessionName::new("berth-environment-test").unwrap()),
            root.path().to_string_lossy().into_owned(),
            "/bin/sh".to_owned(),
            None,
            Some("/bin/sh".to_owned()),
            Vec::new(),
            Some(caller),
            Some(&host),
            24,
            80,
            false,
        ),
    )
    .await
    .expect("bounded creation request");
    assert!(
        result.is_err(),
        "synthetic peer closes after capturing the request"
    );
    let environment = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("bounded protocol peer")
        .expect("protocol peer")
        .expect("explicit environment overrides");
    let environment: HashMap<_, _> = environment
        .iter()
        .map(|entry| entry.split_once('=').expect("key=value"))
        .collect();
    for (key, expected) in [
        ("BERTH_DATA_DIR", data.as_path()),
        ("BERTH_GUI_ENDPOINT", gui.as_path()),
        ("BERTH_TMPDIR", tmpdir.as_path()),
        ("BERTH_HOME", home.as_path()),
    ] {
        assert_eq!(environment.get(key).copied(), expected.to_str(), "{key}");
    }
    // 取 DataInstance 的实际文件名，而不是把 unset 解释为保留旧 session 值。
    assert_eq!(environment["BERTH_DATA_FILE"], "berth.db");
    assert_eq!(environment["CALLER_VALUE"], "preserve=value=exactly");
    assert_eq!(
        std::env::split_paths(environment["PATH"]).collect::<Vec<_>>(),
        [
            cli.parent().unwrap(),
            Path::new("/agent/bin"),
            Path::new("/host/bin")
        ]
    );
}
