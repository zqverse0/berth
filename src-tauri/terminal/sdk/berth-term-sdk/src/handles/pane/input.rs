use crate::handles::session::unexpected_response;
#[cfg(feature = "available")]
use crate::PaneScrollDirection;
use crate::{Pane, Result, TerminalSizeSpec};
#[cfg(feature = "available")]
use berth_term_proto::CopyModeRequest;
use berth_term_proto::{
    PaneInputRequest, PaneResizeRequest, Request, ResizePaneAdjustment, ResizePaneRequest,
    Response, SendKeysExtRequest, SendKeysRequest, CAPABILITY_SDK_PANE_BY_ID,
};

use super::info::fetch_live_details_or_default;

pub(super) async fn send_text(pane: &Pane, text: &str) -> Result<()> {
    let response = if pane.stable_id.is_some() {
        crate::capabilities::require(pane.transport(), &[CAPABILITY_SDK_PANE_BY_ID]).await?;
        pane.transport()
            .request(Request::PaneInput(PaneInputRequest {
                target: pane.proto_target_ref(),
                keys: vec![text.to_owned()],
                literal: true,
            }))
            .await?
    } else {
        pane.transport()
            .request(Request::SendKeysExt(SendKeysExtRequest {
                target: Some(pane.target().into()),
                keys: vec![text.to_owned()],
                expand_formats: false,
                hex: false,
                literal: true,
                dispatch_key_table: false,
                copy_mode_command: false,
                forward_mouse_event: false,
                reset_terminal: false,
                repeat_count: None,
            }))
            .await?
    };

    match response {
        Response::SendKeys(_) => Ok(()),
        response => Err(unexpected_response("send-keys", response)),
    }
}

pub(super) async fn send_key(pane: &Pane, key: String) -> Result<()> {
    let response = if pane.stable_id.is_some() {
        crate::capabilities::require(pane.transport(), &[CAPABILITY_SDK_PANE_BY_ID]).await?;
        pane.transport()
            .request(Request::PaneInput(PaneInputRequest {
                target: pane.proto_target_ref(),
                keys: vec![key],
                literal: false,
            }))
            .await?
    } else {
        pane.transport()
            .request(Request::SendKeys(SendKeysRequest {
                target: pane.target().into(),
                keys: vec![key],
            }))
            .await?
    };

    match response {
        Response::SendKeys(_) => Ok(()),
        response => Err(unexpected_response("send-keys", response)),
    }
}

#[cfg(feature = "available")]
pub(super) async fn cancel_copy_mode(pane: &Pane) -> Result<()> {
    let target = pane.current_target().await?.to_proto();
    let response = pane
        .transport()
        .request(Request::CopyMode(CopyModeRequest {
            target: Some(target),
            page_down: false,
            exit_on_scroll: false,
            hide_position: true,
            mouse_drag_start: false,
            cancel_mode: true,
            scrollbar_scroll: false,
            source: None,
            page_up: false,
        }))
        .await?;

    match response {
        Response::CopyMode(_) => Ok(()),
        response => Err(unexpected_response("copy-mode", response)),
    }
}

#[cfg(feature = "available")]
pub(super) async fn scroll_history(pane: &Pane, direction: PaneScrollDirection) -> Result<()> {
    let target = pane.current_target().await?.to_proto();
    let response = pane
        .transport()
        .request(Request::CopyMode(CopyModeRequest {
            target: Some(target.clone()),
            page_down: false,
            exit_on_scroll: false,
            hide_position: true,
            mouse_drag_start: false,
            cancel_mode: false,
            scrollbar_scroll: false,
            source: None,
            page_up: false,
        }))
        .await?;

    if !matches!(response, Response::CopyMode(_)) {
        return Err(unexpected_response("copy-mode", response));
    }

    let command = match direction {
        PaneScrollDirection::Up => "scroll-up",
        PaneScrollDirection::Down => "scroll-down",
    };
    let response = pane
        .transport()
        .request(Request::SendKeysExt(SendKeysExtRequest {
            target: Some(target),
            keys: vec![command.to_owned()],
            expand_formats: false,
            hex: false,
            literal: false,
            dispatch_key_table: false,
            copy_mode_command: true,
            forward_mouse_event: false,
            reset_terminal: false,
            repeat_count: Some(5),
        }))
        .await?;

    match response {
        Response::SendKeys(_) => Ok(()),
        response => Err(unexpected_response("send-keys", response)),
    }
}

pub(super) async fn resize_to_size(pane: &Pane, requested: TerminalSizeSpec) -> Result<()> {
    let current = live_pane_size(pane).await?;
    let mut sent_non_noop_adjustment = false;

    if current.cols != requested.cols {
        request_resize_pane(
            pane,
            ResizePaneAdjustment::AbsoluteWidth {
                columns: requested.cols,
            },
        )
        .await?;
        sent_non_noop_adjustment = true;
    }

    if current.rows != requested.rows {
        request_resize_pane(
            pane,
            ResizePaneAdjustment::AbsoluteHeight {
                rows: requested.rows,
            },
        )
        .await?;
        sent_non_noop_adjustment = true;
    }

    if !sent_non_noop_adjustment {
        request_resize_pane(pane, ResizePaneAdjustment::NoOp).await?;
    }

    Ok(())
}

async fn live_pane_size(pane: &Pane) -> Result<TerminalSizeSpec> {
    if pane.stable_id.is_some() {
        let snapshot = pane.snapshot().await?;
        return Ok(TerminalSizeSpec::new(snapshot.cols, snapshot.rows));
    }

    let details = fetch_live_details_or_default(pane.transport(), pane.target()).await?;
    Ok(TerminalSizeSpec::new(details.cols, details.rows))
}

async fn request_resize_pane(pane: &Pane, adjustment: ResizePaneAdjustment) -> Result<()> {
    let response = if pane.stable_id.is_some() {
        crate::capabilities::require(pane.transport(), &[CAPABILITY_SDK_PANE_BY_ID]).await?;
        pane.transport()
            .request(Request::PaneResize(PaneResizeRequest {
                target: pane.proto_target_ref(),
                adjustment,
            }))
            .await?
    } else {
        pane.transport()
            .request(Request::ResizePane(ResizePaneRequest {
                target: pane.target().into(),
                adjustment,
            }))
            .await?
    };

    match response {
        Response::ResizePane(_) => Ok(()),
        response => Err(unexpected_response("resize-pane", response)),
    }
}

#[cfg(all(test, feature = "available"))]
mod tests {
    use super::{scroll_history, PaneScrollDirection};
    use crate::{Pane, PaneRef, TerminalEndpoint};
    use berth_term_proto::{
        encode_frame, CopyModeResponse, FrameDecoder, PaneTarget, Request, Response,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn alpha() -> berth_term_proto::SessionName {
        berth_term_proto::SessionName::new("alpha").expect("valid session")
    }

    fn pane(client: crate::transport::TransportClient) -> Pane {
        Pane::new(
            PaneRef::new(alpha(), 1, 3),
            TerminalEndpoint::Default,
            None,
            client,
        )
    }

    async fn read_request(stream: &mut tokio::io::DuplexStream) -> Request {
        let mut decoder = FrameDecoder::new();
        let mut buffer = [0_u8; 512];
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
    async fn scroll_history_enters_or_advances_copy_mode() {
        let (client_stream, mut server_stream) = tokio::io::duplex(4096);
        let pane = pane(crate::transport::TransportClient::spawn(client_stream));
        let scroll = tokio::spawn({
            let pane = pane.clone();
            async move { scroll_history(&pane, PaneScrollDirection::Up).await }
        });

        match read_request(&mut server_stream).await {
            Request::CopyMode(request) => {
                assert_eq!(request.target, Some(PaneTarget::with_window(alpha(), 1, 3)));
                assert!(!request.page_up);
                assert!(!request.page_down);
                assert!(request.hide_position);
            }
            request => panic!("expected copy-mode, got {request:?}"),
        }
        write_response(
            &mut server_stream,
            Response::CopyMode(CopyModeResponse {
                target: PaneTarget::with_window(alpha(), 1, 3),
                active: true,
                view_mode: false,
            }),
        )
        .await;

        match read_request(&mut server_stream).await {
            Request::SendKeysExt(request) => {
                assert_eq!(request.target, Some(PaneTarget::with_window(alpha(), 1, 3)));
                assert_eq!(request.keys, ["scroll-up"]);
                assert!(request.copy_mode_command);
                assert_eq!(request.repeat_count, Some(5));
            }
            request => panic!("expected copy-mode send-keys, got {request:?}"),
        }
        write_response(
            &mut server_stream,
            Response::SendKeys(berth_term_proto::SendKeysResponse { key_count: 1 }),
        )
        .await;

        scroll.await.expect("scroll task").expect("scroll succeeds");
    }
}
