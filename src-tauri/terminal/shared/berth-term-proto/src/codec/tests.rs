use super::{decode_frame, encode_frame, FrameDecoder};
use crate::{
    AttachSessionExt2Request, AttachSessionExt3Request, AttachSessionRequest, CapturePaneRequest,
    CopyModeRequest, DetachClientExtRequest, DetachClientRequest, DisplayMessageExtRequest,
    DisplayMessageRequest, HasSessionRequest, KillPaneRequest, KillSessionRequest,
    KillWindowRequest, LayoutName, ListPanesRequest, ListSessionsRequest, ListWindowsRequest,
    NewSessionRequest, NewWindowRequest, NextWindowRequest, OptionName, PaneTarget,
    PasteBufferRequest, PreviousWindowRequest, RenameSessionRequest, RenameWindowRequest, Request,
    ResizePaneAdjustment, ResizePaneRequest, ScopeSelector, SelectLayoutRequest,
    SelectLayoutTarget, SelectPaneAdjacentRequest, SelectPaneDirection, SelectPaneRequest,
    SelectWindowRequest, SendKeysExt2Request, SendKeysRequest, SessionName, SetBufferRequest,
    SetOptionMode, SetOptionRequest, ShowBufferRequest, SplitDirection, SplitWindowExtRequest,
    SplitWindowRequest, SplitWindowTarget, Target, TerminalSize, WindowTarget,
};

#[test]
fn guarded_pane_requests_keep_tail_tags_and_round_trip() {
    let session = SessionName::new("alpha").expect("valid session");
    let target = crate::PaneTargetRef::guarded_by_id(session.clone(), crate::PaneId::new(3), 7);
    let capture = CapturePaneRequest {
        target: PaneTarget::with_window(session, 0, 0),
        start: None,
        end: None,
        print: true,
        buffer_name: None,
        alternate: false,
        escape_ansi: false,
        escape_sequences: false,
        join_wrapped: false,
        use_mode_screen: false,
        preserve_trailing_spaces: false,
        do_not_trim_spaces: false,
        pending_input: false,
        quiet: false,
        start_is_absolute: false,
        end_is_absolute: false,
    };
    for (request, tag) in [
        (
            Request::CapturePaneRef(Box::new(crate::CapturePaneRefRequest {
                target: target.clone(),
                capture,
            })),
            121,
        ),
        (
            Request::PaneWindow(crate::PaneWindowRequest {
                target: target.clone(),
                operation: crate::PaneWindowOperation::Resize {
                    width: 90,
                    height: 30,
                },
            }),
            122,
        ),
        (
            Request::PaneWindow(crate::PaneWindowRequest {
                target,
                operation: crate::PaneWindowOperation::Close,
            }),
            122,
        ),
    ] {
        assert_eq!(crate::frame_kind_for_request(&request).bincode_tag(), tag);
        let bytes = encode_frame(&request).expect("encodes");
        let decoded: Request = decode_frame(&bytes).expect("decodes");
        assert_eq!(decoded, request);
    }
}

#[test]
fn every_request_variant_round_trips_through_the_frame_codec() {
    let alpha = SessionName::new("alpha").expect("valid session");
    let beta = SessionName::new("beta").expect("valid session");
    let pane = PaneTarget::new(alpha.clone(), 2);
    let window = WindowTarget::new(alpha.clone());

    let requests = vec![
        Request::NewSession(NewSessionRequest {
            session_name: alpha.clone(),
            detached: true,
            size: Some(TerminalSize {
                cols: 200,
                rows: 50,
            }),
            environment: None,
        }),
        Request::HasSession(HasSessionRequest {
            target: alpha.clone(),
        }),
        Request::KillSession(KillSessionRequest {
            target: alpha.clone(),
            kill_all_except_target: false,
            clear_alerts: false,
        }),
        Request::NewWindow(Box::new(NewWindowRequest {
            target: alpha.clone(),
            name: Some("build".to_owned()),
            detached: true,
            start_directory: None,
            environment: None,
            command: None,
            process_command: None,
            target_window_index: None,
            insert_at_target: false,
        })),
        Request::KillWindow(KillWindowRequest {
            target: WindowTarget::with_window(alpha.clone(), 1),
            kill_all_others: false,
        }),
        Request::SelectWindow(SelectWindowRequest {
            target: WindowTarget::with_window(alpha.clone(), 2),
        }),
        Request::RenameWindow(RenameWindowRequest {
            target: WindowTarget::with_window(alpha.clone(), 2),
            name: "logs".to_owned(),
        }),
        Request::NextWindow(NextWindowRequest {
            target: alpha.clone(),
            alerts_only: false,
        }),
        Request::PreviousWindow(PreviousWindowRequest {
            target: alpha.clone(),
            alerts_only: false,
        }),
        Request::ListWindows(ListWindowsRequest {
            target: alpha.clone(),
            format: Some("#{window_index}".to_owned()),
        }),
        Request::SplitWindow(SplitWindowRequest {
            target: SplitWindowTarget::Pane(pane.clone()),
            direction: SplitDirection::Vertical,
            before: false,
            environment: None,
        }),
        Request::KillPane(KillPaneRequest {
            target: pane.clone(),
            kill_all_except: false,
        }),
        Request::SelectLayout(SelectLayoutRequest {
            target: SelectLayoutTarget::Window(window.clone()),
            layout: LayoutName::MainVertical,
        }),
        Request::ResizePane(ResizePaneRequest {
            target: pane.clone(),
            adjustment: ResizePaneAdjustment::AbsoluteWidth { columns: 34 },
        }),
        Request::SelectPane(Box::new(SelectPaneRequest {
            target: pane.clone(),
            title: None,
            style: None,
            input_disabled: None,
            preserve_zoom: false,
        })),
        Request::SelectPaneAdjacent(SelectPaneAdjacentRequest {
            target: pane.clone(),
            direction: SelectPaneDirection::Right,
            preserve_zoom: false,
        }),
        Request::SendKeys(SendKeysRequest {
            target: pane,
            keys: vec!["echo".to_owned(), "Enter".to_owned()],
        }),
        Request::SplitWindowExt(Box::new(SplitWindowExtRequest {
            target: SplitWindowTarget::Pane(PaneTarget::with_window(beta.clone(), 0, 1)),
            direction: SplitDirection::Horizontal,
            before: false,
            environment: Some(vec!["FOO=bar".to_owned()]),
            command: Some(vec!["printf done".to_owned()]),
            process_command: None,
            start_directory: None,
            keep_alive_on_exit: None,
            detached: false,
            size: None,
            preserve_zoom: false,
            full_size: false,
            stdin_payload: None,
        })),
        Request::AttachSession(AttachSessionRequest {
            target: alpha.clone(),
        }),
        Request::DetachClient(DetachClientRequest),
        Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Global,
            option: OptionName::DefaultTerminal,
            value: "tmux-256color".to_owned(),
            mode: SetOptionMode::Replace,
        }),
        Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Global,
            option: OptionName::TerminalFeatures,
            value: "xterm:RGB".to_owned(),
            mode: SetOptionMode::Append,
        }),
        Request::SetBuffer(SetBufferRequest {
            name: Some("named".to_owned()),
            content: b"buffer".to_vec(),
            append: false,
            new_name: None,
            set_clipboard: false,
        }),
        Request::ShowBuffer(ShowBufferRequest {
            name: Some("named".to_owned()),
        }),
        Request::PasteBuffer(Box::new(PasteBufferRequest {
            name: None,
            target: PaneTarget::with_window(SessionName::new("alpha").unwrap(), 0, 0),
            delete_after: true,
            separator: None,
            linefeed: false,
            raw: false,
            bracketed: false,
        })),
        Request::CapturePane(Box::new(CapturePaneRequest {
            target: PaneTarget::with_window(SessionName::new("alpha").unwrap(), 0, 0),
            start: Some(-5),
            end: Some(-1),
            print: true,
            buffer_name: None,
            alternate: false,
            escape_ansi: false,
            escape_sequences: false,
            join_wrapped: false,
            use_mode_screen: false,
            preserve_trailing_spaces: false,
            do_not_trim_spaces: false,
            pending_input: false,
            quiet: false,
            start_is_absolute: false,
            end_is_absolute: false,
        })),
        Request::DisplayMessage(DisplayMessageRequest {
            target: Some(Target::Window(WindowTarget::with_window(
                SessionName::new("alpha").unwrap(),
                0,
            ))),
            print: true,
            message: Some("#{session_name}".to_owned()),
            empty_target_context: false,
        }),
        Request::DisplayMessageExt(Box::new(DisplayMessageExtRequest {
            target: Some(Target::Session(beta.clone())),
            print: true,
            message: Some("#{client_name}".to_owned()),
            target_client: Some("=".to_owned()),
            empty_target_context: false,
        })),
        Request::SendKeysExt2(Box::new(SendKeysExt2Request {
            target: Some(PaneTarget::with_window(beta.clone(), 0, 1)),
            keys: vec!["A".to_owned()],
            expand_formats: false,
            hex: false,
            literal: true,
            dispatch_key_table: false,
            copy_mode_command: false,
            forward_mouse_event: false,
            reset_terminal: false,
            repeat_count: None,
            target_client: Some("=".to_owned()),
        })),
        Request::RenameSession(RenameSessionRequest {
            target: SessionName::new("alpha").unwrap(),
            new_name: SessionName::new("gamma").unwrap(),
        }),
        Request::ListSessions(ListSessionsRequest {
            format: Some("#{session_name}".to_owned()),
            filter: None,
            sort_order: None,
            reversed: false,
        }),
        Request::ListPanes(ListPanesRequest {
            target: SessionName::new("alpha").unwrap(),
            format: Some("#{pane_id}".to_owned()),
            target_window_index: None,
        }),
        Request::CopyMode(CopyModeRequest {
            target: Some(PaneTarget::with_window(
                SessionName::new("alpha").unwrap(),
                0,
                0,
            )),
            page_down: false,
            exit_on_scroll: true,
            hide_position: true,
            mouse_drag_start: false,
            cancel_mode: false,
            scrollbar_scroll: false,
            source: Some(PaneTarget::with_window(
                SessionName::new("beta").unwrap(),
                1,
                2,
            )),
            page_up: true,
        }),
        Request::KillServer(crate::KillServerRequest),
        Request::DetachClientExt(DetachClientExtRequest {
            target_client: Some("=".to_owned()),
            all_other_clients: true,
            target_session: Some(beta.clone()),
            kill_on_detach: true,
            exec_command: Some("printf detached".to_owned()),
        }),
        Request::AttachSessionExt2(Box::new(AttachSessionExt2Request {
            target: Some(beta.clone()),
            target_spec: Some("beta:0.1".to_owned()),
            detach_other_clients: true,
            kill_other_clients: false,
            read_only: true,
            skip_environment_update: true,
            flags: Some(vec!["active-pane".to_owned()]),
            working_directory: Some("/tmp".to_owned()),
            client_terminal: crate::ClientTerminalContext::default(),
            client_size: Some(TerminalSize {
                cols: 120,
                rows: 40,
            }),
        })),
        Request::AttachSessionExt3(Box::new(AttachSessionExt3Request::from_ext2(
            AttachSessionExt2Request {
                target: Some(beta.clone()),
                target_spec: Some("beta:0.1".to_owned()),
                detach_other_clients: true,
                kill_other_clients: false,
                read_only: true,
                skip_environment_update: true,
                flags: Some(vec!["active-pane".to_owned()]),
                working_directory: Some("/tmp".to_owned()),
                client_terminal: crate::ClientTerminalContext::default(),
                client_size: Some(TerminalSize {
                    cols: 120,
                    rows: 40,
                }),
            },
            vec![crate::CAPABILITY_ATTACH_RENDER.to_owned()],
        ))),
        Request::Handshake(crate::HandshakeRequest::requiring([
            crate::CAPABILITY_DETACHED_RPC,
            crate::CAPABILITY_HANDSHAKE,
        ])),
    ];

    for request in requests {
        let frame = encode_frame(&request).expect("encodes");
        let decoded: Request = decode_frame(&frame).expect("decodes");
        assert_eq!(decoded, request);
    }
}

#[test]
fn display_message_request_appends_after_existing_request_variants() {
    let request = Request::DisplayMessage(DisplayMessageRequest {
        target: Some(Target::Session(
            SessionName::new("alpha").expect("valid session"),
        )),
        print: true,
        message: Some("#{session_name}".to_owned()),
        empty_target_context: false,
    });

    let encoded = bincode::serialize(&request).expect("request encodes");

    assert_eq!(&encoded[..4], 44_u32.to_le_bytes().as_slice());
    assert_eq!(
        bincode::deserialize::<Request>(&encoded).expect("request decodes"),
        request
    );
}

#[test]
fn copy_mode_request_appends_after_existing_request_variants() {
    let request = Request::CopyMode(CopyModeRequest {
        target: Some(PaneTarget::with_window(
            SessionName::new("alpha").expect("valid session"),
            0,
            0,
        )),
        page_down: false,
        exit_on_scroll: false,
        hide_position: false,
        mouse_drag_start: false,
        cancel_mode: false,
        scrollbar_scroll: false,
        source: None,
        page_up: true,
    });

    let encoded = bincode::serialize(&request).expect("request encodes");

    assert_eq!(&encoded[..4], 62_u32.to_le_bytes().as_slice());
    assert_eq!(
        bincode::deserialize::<Request>(&encoded).expect("request decodes"),
        request
    );
}

#[test]
fn server_lifecycle_request_variants_append_after_spread_layout() {
    let cases = [(72_u32, Request::KillServer(crate::KillServerRequest))];

    for (expected_tag, request) in cases {
        let encoded = bincode::serialize(&request).expect("request encodes");
        assert_eq!(&encoded[..4], expected_tag.to_le_bytes().as_slice());
        assert_eq!(
            bincode::deserialize::<Request>(&encoded).expect("request decodes"),
            request
        );
    }
}

#[test]
fn client_surface_request_variants_append_after_server_access() {
    let cases = [
        (
            80_u32,
            Request::DetachClientExt(DetachClientExtRequest {
                target_client: Some("=".to_owned()),
                all_other_clients: false,
                target_session: None,
                kill_on_detach: true,
                exec_command: None,
            }),
        ),
        (
            81_u32,
            Request::AttachSessionExt2(Box::new(AttachSessionExt2Request {
                target: Some(SessionName::new("alpha").expect("valid session")),
                target_spec: Some("alpha:2".to_owned()),
                detach_other_clients: false,
                kill_other_clients: false,
                read_only: false,
                skip_environment_update: false,
                flags: None,
                working_directory: Some("/tmp".to_owned()),
                client_terminal: crate::ClientTerminalContext::default(),
                client_size: Some(TerminalSize { cols: 90, rows: 30 }),
            })),
        ),
        (
            117_u32,
            Request::AttachSessionExt3(Box::new(AttachSessionExt3Request::from_ext2(
                AttachSessionExt2Request {
                    target: Some(SessionName::new("alpha").expect("valid session")),
                    target_spec: Some("alpha:2".to_owned()),
                    detach_other_clients: false,
                    kill_other_clients: false,
                    read_only: false,
                    skip_environment_update: false,
                    flags: None,
                    working_directory: Some("/tmp".to_owned()),
                    client_terminal: crate::ClientTerminalContext::default(),
                    client_size: Some(TerminalSize { cols: 90, rows: 30 }),
                },
                vec![crate::CAPABILITY_ATTACH_RENDER.to_owned()],
            ))),
        ),
    ];

    for (expected_tag, request) in cases {
        let encoded = bincode::serialize(&request).expect("request encodes");
        assert_eq!(&encoded[..4], expected_tag.to_le_bytes().as_slice());
        assert_eq!(
            bincode::deserialize::<Request>(&encoded).expect("request decodes"),
            request
        );
    }
}

#[test]
fn decoder_handles_partial_reads() {
    let request = Request::HasSession(HasSessionRequest {
        target: SessionName::new("alpha").expect("valid session"),
    });
    let frame = encode_frame(&request).expect("encodes");
    let split_at = frame.len() / 2;

    let mut decoder = FrameDecoder::new();
    decoder.push_bytes(&frame[..split_at]);
    assert_eq!(decoder.next_frame::<Request>().expect("not an error"), None);

    decoder.push_bytes(&frame[split_at..]);
    assert_eq!(
        decoder.next_frame::<Request>().expect("complete frame"),
        Some(request)
    );
}

#[test]
fn decoder_rejects_zero_length_payloads() {
    let mut decoder = FrameDecoder::new();
    decoder.push_bytes(&test_frame_header(0));
    assert_eq!(
        decoder.next_frame::<Request>(),
        Err(crate::TerminalError::EmptyFrame)
    );
}

#[test]
fn decoder_rejects_oversized_frames() {
    let mut decoder = FrameDecoder::with_max_frame_length(8);
    decoder.push_bytes(&test_frame_header(16));

    assert_eq!(
        decoder.next_frame::<Request>(),
        Err(crate::TerminalError::FrameTooLarge {
            length: 16,
            maximum: 8,
        })
    );
}

#[test]
fn decoder_clears_buffer_after_unsupported_wire_version() {
    let unsupported_version = if crate::BERTH_TERM_WIRE_VERSION == 1 {
        2
    } else {
        1
    };
    let mut frame = vec![crate::BERTH_TERM_FRAME_MAGIC, unsupported_version as u8];
    frame.extend_from_slice(&4u32.to_le_bytes());
    frame.extend_from_slice(&[0, 0, 0, 0]);

    let mut decoder = FrameDecoder::new();
    decoder.push_bytes(&frame);

    assert!(matches!(
        decoder.next_frame::<Request>(),
        Err(crate::TerminalError::UnsupportedWireVersion { .. })
    ));
    assert!(decoder.remaining_bytes().is_empty());
    assert_eq!(decoder.next_frame::<Request>(), Ok(None));
}

#[test]
fn decoder_clears_buffer_after_invalid_wire_version_varint() {
    let mut decoder = FrameDecoder::new();
    decoder.push_bytes(&[crate::BERTH_TERM_FRAME_MAGIC, 0x80, 0x80, 0x80, 0x80, 0x80]);

    assert!(matches!(
        decoder.next_frame::<Request>(),
        Err(crate::TerminalError::Decode(message)) if message.contains("wire-version varint")
    ));
    assert!(decoder.remaining_bytes().is_empty());
    assert_eq!(decoder.next_frame::<Request>(), Ok(None));
}

#[test]
fn decode_frame_rejects_truncated_payloads() {
    let mut frame = test_frame_header(4);
    frame.extend_from_slice(&[1, 2]);

    assert_eq!(
        decode_frame::<Request>(&frame),
        Err(crate::TerminalError::IncompleteFrame {
            expected: 4,
            received: 2,
        })
    );
}

#[test]
fn decode_frame_rejects_trailing_bytes() {
    let request = Request::HasSession(HasSessionRequest {
        target: SessionName::new("alpha").expect("valid session"),
    });
    let mut frame = encode_frame(&request).expect("encodes");
    frame.push(0xFF);

    assert!(matches!(
        decode_frame::<Request>(&frame),
        Err(crate::TerminalError::Decode(_))
    ));
}

#[test]
fn decode_frame_rejects_header_only() {
    assert_eq!(
        decode_frame::<Request>(&[
            crate::BERTH_TERM_FRAME_MAGIC,
            crate::BERTH_TERM_WIRE_VERSION as u8
        ]),
        Err(crate::TerminalError::IncompleteFrame {
            expected: 6,
            received: 2,
        })
    );
}

fn test_frame_header(length: u32) -> Vec<u8> {
    let mut frame = vec![
        crate::BERTH_TERM_FRAME_MAGIC,
        crate::BERTH_TERM_WIRE_VERSION as u8,
    ];
    frame.extend_from_slice(&length.to_le_bytes());
    frame
}

#[test]
fn decoder_handles_multiple_consecutive_frames() {
    let req_a = Request::HasSession(HasSessionRequest {
        target: SessionName::new("alpha").expect("valid session"),
    });
    let req_b = Request::KillSession(KillSessionRequest {
        target: SessionName::new("beta").expect("valid session"),
        kill_all_except_target: false,
        clear_alerts: false,
    });
    let frame_a = encode_frame(&req_a).expect("encodes");
    let frame_b = encode_frame(&req_b).expect("encodes");

    let mut decoder = FrameDecoder::new();
    let mut combined = frame_a;
    combined.extend_from_slice(&frame_b);
    decoder.push_bytes(&combined);

    assert_eq!(
        decoder.next_frame::<Request>().expect("first frame"),
        Some(req_a)
    );
    assert_eq!(
        decoder.next_frame::<Request>().expect("second frame"),
        Some(req_b)
    );
    assert_eq!(
        decoder.next_frame::<Request>().expect("no more frames"),
        None
    );
}

#[test]
fn every_response_variant_round_trips_through_the_frame_codec() {
    let alpha = SessionName::new("alpha").expect("valid session");
    let pane = PaneTarget::new(alpha.clone(), 1);

    let responses: Vec<crate::Response> = vec![
        crate::Response::NewSession(crate::NewSessionResponse {
            session_name: alpha.clone(),
            detached: true,
            output: None,
            created_pane: None,
        }),
        crate::Response::HasSession(crate::HasSessionResponse { exists: true }),
        crate::Response::KillSession(crate::KillSessionResponse { existed: false }),
        crate::Response::NewWindow(crate::NewWindowResponse {
            target: WindowTarget::with_window(alpha.clone(), 2),
            created_pane: None,
        }),
        crate::Response::KillWindow(crate::KillWindowResponse {
            target: WindowTarget::with_window(alpha.clone(), 1),
        }),
        crate::Response::SelectWindow(crate::SelectWindowResponse {
            target: WindowTarget::with_window(alpha.clone(), 2),
        }),
        crate::Response::RenameWindow(crate::RenameWindowResponse {
            target: WindowTarget::with_window(alpha.clone(), 2),
        }),
        crate::Response::NextWindow(crate::NextWindowResponse {
            target: WindowTarget::with_window(alpha.clone(), 3),
        }),
        crate::Response::PreviousWindow(crate::PreviousWindowResponse {
            target: WindowTarget::with_window(alpha.clone(), 1),
        }),
        crate::Response::ListWindows(crate::ListWindowsResponse {
            windows: vec![crate::WindowListEntry {
                target: WindowTarget::new(alpha.clone()),
                window_id: "@0".to_owned(),
                name: Some("shell".to_owned()),
                pane_count: 2,
                size: TerminalSize { cols: 80, rows: 24 },
                layout: LayoutName::MainVertical,
                active: true,
                last: false,
                rendered: "0:shell*".to_owned(),
            }],
            output: crate::CommandOutput::from_stdout("0:shell*\n"),
        }),
        crate::Response::SplitWindow(crate::SplitWindowResponse { pane: pane.clone() }),
        crate::Response::KillPane(crate::KillPaneResponse {
            target: pane.clone(),
            window_destroyed: false,
        }),
        crate::Response::SelectLayout(crate::SelectLayoutResponse {
            layout: LayoutName::MainVertical,
        }),
        crate::Response::ResizePane(crate::ResizePaneResponse {
            target: pane.clone(),
            adjustment: ResizePaneAdjustment::AbsoluteWidth { columns: 80 },
        }),
        crate::Response::SelectPane(crate::SelectPaneResponse {
            target: pane.clone(),
        }),
        crate::Response::SendKeys(crate::SendKeysResponse { key_count: 3 }),
        crate::Response::AttachSession(crate::AttachSessionResponse {
            session_name: alpha.clone(),
        }),
        crate::Response::DetachClient(crate::DetachClientResponse),
        crate::Response::SetOption(crate::SetOptionResponse {
            scope: ScopeSelector::Global,
            option: OptionName::DefaultTerminal,
            mode: SetOptionMode::Replace,
        }),
        crate::Response::SetOption(crate::SetOptionResponse {
            scope: ScopeSelector::Global,
            option: OptionName::TerminalFeatures,
            mode: SetOptionMode::Append,
        }),
        crate::Response::Error(crate::ErrorResponse {
            error: crate::TerminalError::SessionNotFound("gone".to_owned()),
        }),
        crate::Response::SetBuffer(crate::SetBufferResponse {
            buffer_name: "buffer0".to_owned(),
        }),
        crate::Response::ShowBuffer(crate::ShowBufferResponse {
            output: crate::CommandOutput::from_stdout(b"buffer".to_vec()),
        }),
        crate::Response::PasteBuffer(crate::PasteBufferResponse {
            buffer_name: "buffer0".to_owned(),
        }),
        crate::Response::CapturePane(crate::CapturePaneResponse::from_output(
            crate::CommandOutput::from_stdout(b"captured\n".to_vec()),
        )),
        crate::Response::CapturePane(crate::CapturePaneResponse::from_buffer(
            "capture-buffer".to_owned(),
        )),
        crate::Response::DisplayMessage(crate::DisplayMessageResponse::from_output(
            crate::CommandOutput::from_stdout(b"displayed\n".to_vec()),
        )),
        crate::Response::DisplayMessage(crate::DisplayMessageResponse::no_output()),
        crate::Response::RenameSession(crate::RenameSessionResponse {
            session_name: SessionName::new("gamma").unwrap(),
        }),
        crate::Response::ListSessions(crate::ListSessionsResponse {
            output: crate::CommandOutput::from_stdout(b"alpha\nbeta\n".to_vec()),
        }),
        crate::Response::ListPanes(crate::ListPanesResponse {
            output: crate::CommandOutput::from_stdout(b"%0\n%1\n".to_vec()),
        }),
        crate::Response::CopyMode(crate::CopyModeResponse {
            target: PaneTarget::with_window(SessionName::new("alpha").unwrap(), 0, 0),
            active: true,
            view_mode: false,
        }),
        crate::Response::KillServer(crate::KillServerResponse),
        crate::Response::Handshake(crate::HandshakeResponse::current()),
    ];

    for response in responses {
        let frame = encode_frame(&response).expect("encodes");
        let decoded: crate::Response = decode_frame(&frame).expect("decodes");
        assert_eq!(decoded, response);
    }
}

#[test]
fn display_message_response_appends_after_existing_response_variants() {
    let response = crate::Response::DisplayMessage(crate::DisplayMessageResponse::no_output());

    let encoded = bincode::serialize(&response).expect("response encodes");

    assert_eq!(&encoded[..4], 44_u32.to_le_bytes().as_slice());
    assert_eq!(
        bincode::deserialize::<crate::Response>(&encoded).expect("response decodes"),
        response
    );
}

#[test]
fn copy_mode_response_appends_after_existing_response_variants() {
    let response = crate::Response::CopyMode(crate::CopyModeResponse {
        target: PaneTarget::with_window(SessionName::new("alpha").expect("valid session"), 0, 0),
        active: true,
        view_mode: false,
    });

    let encoded = bincode::serialize(&response).expect("response encodes");

    assert_eq!(&encoded[..4], 59_u32.to_le_bytes().as_slice());
    assert_eq!(
        bincode::deserialize::<crate::Response>(&encoded).expect("response decodes"),
        response
    );
}

#[test]
fn server_lifecycle_response_variants_append_after_show_messages() {
    let cases = [(
        63_u32,
        crate::Response::KillServer(crate::KillServerResponse),
    )];

    for (expected_tag, response) in cases {
        let encoded = bincode::serialize(&response).expect("response encodes");
        assert_eq!(&encoded[..4], expected_tag.to_le_bytes().as_slice());
        assert_eq!(
            bincode::deserialize::<crate::Response>(&encoded).expect("response decodes"),
            response
        );
    }
}
