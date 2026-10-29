use super::*;
use berth_term_proto::{
    encode_frame, FrameDecoder, RenameWindowResponse, ResizeWindowResponse, SelectLayoutResponse,
    SelectWindowResponse, WindowTarget,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn alpha() -> berth_term_proto::SessionName {
    berth_term_proto::SessionName::new("alpha").expect("valid session")
}

fn target() -> WindowRef {
    WindowRef::new(alpha(), 2)
}

fn window(client: TransportClient) -> Window {
    Window::new(target(), TerminalEndpoint::Default, None, client)
}

async fn read_request(stream: &mut tokio::io::DuplexStream) -> Request {
    let mut decoder = FrameDecoder::new();
    let mut buffer = [0_u8; 256];
    loop {
        if let Some(request) = decoder
            .next_frame::<Request>()
            .expect("request frame decodes")
        {
            return request;
        }
        let read = stream.read(&mut buffer).await.expect("read request");
        assert_ne!(read, 0, "client closed before request");
        decoder.push_bytes(&buffer[..read]);
    }
}

async fn write_response(stream: &mut tokio::io::DuplexStream, response: Response) {
    let frame = encode_frame(&response).expect("response encodes");
    stream.write_all(&frame).await.expect("write response");
    stream.flush().await.expect("flush response");
}

#[tokio::test]
async fn window_mutation_methods_send_typed_requests() {
    let (client_stream, mut server_stream) = tokio::io::duplex(4096);
    let window = window(TransportClient::spawn(client_stream));
    let proto_target = WindowTarget::with_window(alpha(), 2);

    let rename = tokio::spawn({
        let window = window.clone();
        async move { window.rename("logs").await }
    });
    match read_request(&mut server_stream).await {
        Request::RenameWindow(request) => {
            assert_eq!(request.target, proto_target);
            assert_eq!(request.name, "logs");
        }
        request => panic!("expected rename-window, got {request:?}"),
    }
    write_response(
        &mut server_stream,
        Response::RenameWindow(RenameWindowResponse {
            target: proto_target.clone(),
        }),
    )
    .await;
    rename.await.expect("rename task").expect("rename succeeds");

    let select = tokio::spawn({
        let window = window.clone();
        async move { window.select().await }
    });
    assert_eq!(
        read_request(&mut server_stream).await,
        Request::SelectWindow(SelectWindowRequest {
            target: proto_target.clone()
        })
    );
    write_response(
        &mut server_stream,
        Response::SelectWindow(SelectWindowResponse {
            target: proto_target.clone(),
        }),
    )
    .await;
    select.await.expect("select task").expect("select succeeds");

    let resize = tokio::spawn({
        let window = window.clone();
        async move { window.resize(Some(120), Some(40)).await }
    });
    assert_eq!(
        read_request(&mut server_stream).await,
        Request::ResizeWindow(ResizeWindowRequest {
            target: proto_target.clone(),
            width: Some(120),
            height: Some(40),
            adjustment: None,
        })
    );
    write_response(
        &mut server_stream,
        Response::ResizeWindow(ResizeWindowResponse {
            target: proto_target.clone(),
        }),
    )
    .await;
    resize.await.expect("resize task").expect("resize succeeds");

    let layout = tokio::spawn({
        let window = window.clone();
        async move { window.select_layout(LayoutName::Tiled).await }
    });
    assert_eq!(
        read_request(&mut server_stream).await,
        Request::SelectLayout(SelectLayoutRequest {
            target: SelectLayoutTarget::Window(proto_target.clone()),
            layout: LayoutName::Tiled,
        })
    );
    write_response(
        &mut server_stream,
        Response::SelectLayout(SelectLayoutResponse {
            layout: LayoutName::Tiled,
        }),
    )
    .await;
    layout.await.expect("layout task").expect("layout succeeds");
}

#[tokio::test]
async fn session_windows_lists_real_entries_in_one_round_trip() {
    use berth_term_proto::{
        CommandOutput, ListWindowsRequest, ListWindowsResponse, TerminalSize,
        WindowListEntry,
    };

    let (client_stream, mut server_stream) = tokio::io::duplex(4096);
    let session = super::super::session::Session::new(
        alpha(),
        TerminalEndpoint::Default,
        None,
        TransportClient::spawn(client_stream),
        false,
        None,
    );

    let listed = tokio::spawn(async move { session.windows().await });

    // 单次 ListWindows 请求(替代逐槽位 exists 探测)。
    let request = read_request(&mut server_stream).await;
    assert!(matches!(
        &request,
        Request::ListWindows(ListWindowsRequest { target, .. }) if target.as_str() == alpha().as_str()
    ));

    // 稀疏与高索引窗口:索引 7 与 4096 都在列表里,不靠扫描上限。
    write_response(
        &mut server_stream,
        Response::ListWindows(ListWindowsResponse {
            windows: vec![
                WindowListEntry {
                    target: WindowTarget::with_window(alpha(), 7),
                    window_id: "@4".to_owned(),
                    name: Some("sparse".to_owned()),
                    pane_count: 1,
                    size: TerminalSize { cols: 80, rows: 24 },
                    layout: LayoutName::Tiled,
                    active: true,
                    last: false,
                    rendered: String::new(),
                },
                WindowListEntry {
                    target: WindowTarget::with_window(alpha(), 4096),
                    window_id: "@9".to_owned(),
                    name: None,
                    pane_count: 2,
                    size: TerminalSize { cols: 100, rows: 30 },
                    layout: LayoutName::Tiled,
                    active: false,
                    last: true,
                    rendered: String::new(),
                },
            ],
            output: CommandOutput::from_stdout(Vec::new()),
        }),
    )
    .await;

    let entries = listed
        .await
        .expect("task alive")
        .expect("windows listed");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].index, 7);
    assert_eq!(entries[0].id.as_u32(), 4);
    assert_eq!(entries[0].name.as_deref(), Some("sparse"));
    assert_eq!(entries[1].index, 4096);
    assert_eq!(entries[1].name, None);
    assert_eq!(entries[1].size, TerminalSizeSpec::new(100, 30));
}

#[tokio::test]
async fn session_windows_empty_list_is_valid() {
    use berth_term_proto::{CommandOutput, ListWindowsResponse};

    let (client_stream, mut server_stream) = tokio::io::duplex(4096);
    let session = super::super::session::Session::new(
        alpha(),
        TerminalEndpoint::Default,
        None,
        TransportClient::spawn(client_stream),
        false,
        None,
    );
    let listed = tokio::spawn(async move { session.windows().await });
    let _ = read_request(&mut server_stream).await;
    write_response(
        &mut server_stream,
        Response::ListWindows(ListWindowsResponse {
            windows: Vec::new(),
            output: CommandOutput::from_stdout(Vec::new()),
        }),
    )
    .await;
    let entries = listed
        .await
        .expect("task alive")
        .expect("windows listed");
    assert!(entries.is_empty());
}
