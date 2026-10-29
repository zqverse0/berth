use super::info::{
    derive_exit_state, derive_process_state, pane_size_from_details, parse_details_line,
    revision_from_details, verify_guarded_details_pane_id, LiveDetails,
};
use super::snapshot::{cell_from_wire, snapshot_from_response};
use super::target::{is_already_closed_error, TargetSelector};
use crate::{
    InfoSnapshot, Pane, PaneAttributes, PaneColor, PaneId, PaneInfo, PaneProcessState, PaneRef,
    SessionId, TerminalEndpoint, TerminalError, TerminalSizeSpec, WindowId,
};
use berth_term_proto::{
    PaneBindingFailure, PaneSnapshotCell, PaneSnapshotCursor, PaneSnapshotResponse,
};

fn details_with(history_bytes: u64) -> LiveDetails {
    LiveDetails {
        cols: 80,
        rows: 24,
        history_bytes,
        ..LiveDetails::default()
    }
}

#[test]
fn revision_from_details_changes_with_history_bytes() {
    let r1 = revision_from_details(&details_with(10));
    let r2 = revision_from_details(&details_with(11));
    assert_ne!(r1, r2);
}

#[test]
fn revision_from_details_is_never_zero() {
    assert_ne!(revision_from_details(&LiveDetails::default()), 0);
}

#[test]
fn parse_details_line_handles_empty_optional_fields() {
    let line = "%2\t1234\t0\t\t\t80\t24\t10\t5\t1\t0\t128\t4\t\t0\t0\t0\t\t\t\t\t\t\t\t/tmp";
    let details = parse_details_line(line).expect("parses");
    assert_eq!(details.pane_id.unwrap().to_string(), "%2");
    assert_eq!(details.pid, Some(1234));
    assert!(!details.dead);
    assert_eq!(details.dead_status, None);
    assert_eq!(details.dead_signal, None);
    assert_eq!(details.cols, 80);
    assert_eq!(details.rows, 24);
    assert_eq!(details.cursor_x, 10);
    assert_eq!(details.cursor_y, 5);
    assert!(details.cursor_visible);
    assert_eq!(details.history_bytes, 128);
    assert_eq!(details.history_size, 4);
    assert_eq!(details.current_path.as_deref(), Some("/tmp"));
}

#[test]
fn parse_details_line_returns_default_for_blank_or_short_input() {
    assert_eq!(
        parse_details_line("").expect("blank"),
        LiveDetails::default()
    );
    assert_eq!(
        parse_details_line("only\tone\ttwo").expect("short"),
        LiveDetails::default()
    );
}

#[test]
fn parse_details_line_preserves_tabs_inside_current_path() {
    let line = "%2\t1234\t0\t\t\t80\t24\t10\t5\t1\t0\t128\t4\t\t0\t0\t0\t\t\t\t\t\t\t\t/tmp/odd\tdir\twith\ttabs";
    let details = parse_details_line(line).expect("parses");
    assert_eq!(
        details.current_path.as_deref(),
        Some("/tmp/odd\tdir\twith\ttabs")
    );
}

#[test]
fn parse_details_line_decodes_sticky_lifecycle_fields_without_env() {
    let line = "%2\t1234\t0\t\t\t80\t24\t10\t5\t1\t0\t128\t4\tprintf\x1falpha%09beta%25\
             \t3\t5\t7\t\t\t\t\t\t\t\t/tmp/start";
    let details = parse_details_line(line).expect("parses");
    assert_eq!(
        details.start_command.as_deref(),
        Some(["printf".to_owned(), "alpha\tbeta%".to_owned()].as_slice())
    );
    assert_eq!(details.generation, 3);
    assert_eq!(details.lifecycle_revision, 5);
    assert_eq!(details.output_sequence, 7);
    assert_eq!(details.current_path.as_deref(), Some("/tmp/start"));
}

#[test]
fn parse_details_line_decodes_tmux_quoted_shell_command() {
    let line = "%2\t1234\t0\t\t\t80\t24\t10\t5\t1\t0\t128\t4\t\"sleep 60\"\
             \t3\t5\t7\t\t\t\t\t\t\t\t/tmp/start";
    let details = parse_details_line(line).expect("parses");
    assert_eq!(
        details.start_command.as_deref(),
        Some(["sleep 60".to_owned()].as_slice())
    );
}

#[test]
fn parse_details_line_decodes_agent_signal_fields() {
    let line = "%2\t1234\t0\t\t\t80\t24\t10\t5\t1\t0\t128\t4\t\t0\t0\t0\
             \tattention\t1790000000\tnormal\t42\tturn done: 通知\tclaude\t/repo-wt\t/tmp";
    let details = parse_details_line(line).expect("parses");
    assert_eq!(details.foreground_command.as_deref(), Some("claude"));
    assert_eq!(details.foreground_path.as_deref(), Some("/repo-wt"));
    assert_eq!(details.agent.state, "attention");
    assert_eq!(details.agent.changed_at, Some(1_790_000_000));
    assert_eq!(details.agent.progress_state, "normal");
    assert_eq!(details.agent.progress, 42);
    assert_eq!(details.agent.notification, "turn done: 通知");
    assert_eq!(details.current_path.as_deref(), Some("/tmp"));

    // 旧 daemon 不认识这些变量，展开为空串。
    let old = "%2\t1234\t0\t\t\t80\t24\t10\t5\t1\t0\t128\t4\t\t0\t0\t0\t\t\t\t\t\t\t\t/tmp";
    let details = parse_details_line(old).expect("parses");
    assert_eq!(details.agent, crate::PaneAgentSignal::default());
}

#[test]
fn parse_details_line_rejects_malformed_encoded_command() {
    let line = "%2\t1234\t0\t\t\t80\t24\t10\t5\t1\t0\t128\t4\tbad%XX\t1\t1\t1\t\t\t\t\t\t\t\t/tmp";
    assert!(parse_details_line(line).is_err());
}

#[test]
fn revision_from_details_changes_when_pane_id_changes() {
    let mut alpha = LiveDetails {
        cols: 80,
        rows: 24,
        ..LiveDetails::default()
    };
    alpha.pane_id = Some(PaneId::new(1));
    let mut beta = alpha.clone();
    beta.pane_id = Some(PaneId::new(2));
    assert_ne!(revision_from_details(&alpha), revision_from_details(&beta));
}

#[test]
fn pane_ref_target_selector_recognizes_session_invalidation() {
    let target = PaneRef::new(berth_term_proto::SessionName::new("alpha").unwrap(), 3, 1);
    assert!(target.matches_invalid_target("alpha:3.1", "pane index does not exist in session"));
    assert!(target.matches_invalid_target("alpha:3", "window index does not exist in session"));
    assert!(!target.matches_invalid_target("alpha:3.1", "pane index does not exist in window"));
    assert!(!target.matches_invalid_target("alpha:9", "window index does not exist in session"));
}

#[test]
fn is_already_closed_error_matches_session_not_found_for_target_session() {
    let target = PaneRef::new(berth_term_proto::SessionName::new("alpha").unwrap(), 0, 0);
    let error = TerminalError::protocol(berth_term_proto::TerminalError::SessionNotFound(
        "alpha".to_owned(),
    ));
    assert!(is_already_closed_error(&error, &target));
}

#[test]
fn is_already_closed_error_does_not_match_session_not_found_for_other_session() {
    let target = PaneRef::new(berth_term_proto::SessionName::new("alpha").unwrap(), 0, 0);
    let error = TerminalError::protocol(berth_term_proto::TerminalError::SessionNotFound(
        "beta".to_owned(),
    ));
    assert!(!is_already_closed_error(&error, &target));
}

#[test]
fn is_already_closed_error_matches_invalid_window_or_pane_target() {
    let target = PaneRef::new(berth_term_proto::SessionName::new("alpha").unwrap(), 5, 2);
    let pane_invalid = TerminalError::protocol(berth_term_proto::TerminalError::InvalidTarget {
        value: "alpha:5.2".to_owned(),
        reason: "pane index does not exist in session".to_owned(),
    });
    let window_invalid = TerminalError::protocol(berth_term_proto::TerminalError::InvalidTarget {
        value: "alpha:5".to_owned(),
        reason: "window index does not exist in session".to_owned(),
    });
    assert!(is_already_closed_error(&pane_invalid, &target));
    assert!(is_already_closed_error(&window_invalid, &target));
}

#[test]
fn is_already_closed_error_ignores_unrelated_protocol_errors() {
    let target = PaneRef::new(berth_term_proto::SessionName::new("alpha").unwrap(), 0, 0);
    let error = TerminalError::protocol(berth_term_proto::TerminalError::Server(
        "daemon malfunction".to_owned(),
    ));
    assert!(!is_already_closed_error(&error, &target));
}

#[test]
fn is_already_closed_error_ignores_invalid_target_for_other_slot() {
    let target = PaneRef::new(berth_term_proto::SessionName::new("alpha").unwrap(), 5, 2);
    let foreign = TerminalError::protocol(berth_term_proto::TerminalError::InvalidTarget {
        value: "beta:0.0".to_owned(),
        reason: "pane index does not exist in session".to_owned(),
    });
    assert!(!is_already_closed_error(&foreign, &target));
}

#[test]
fn derive_exit_state_treats_signal_zero_as_absent() {
    let details = LiveDetails {
        dead: true,
        dead_status: Some(7),
        dead_signal: Some(0),
        ..LiveDetails::default()
    };
    let exit = derive_exit_state(&details).expect("dead pane has exit state");
    assert_eq!(exit.code, Some(7));
    assert!(exit.signal.is_none());
}

#[test]
fn derive_exit_state_returns_none_for_live_pane() {
    let details = LiveDetails {
        dead: false,
        dead_status: Some(7),
        dead_signal: Some(15),
        ..LiveDetails::default()
    };
    assert!(derive_exit_state(&details).is_none());
}

#[test]
fn derive_process_state_running_carries_pid_when_present() {
    let details = LiveDetails {
        pid: Some(42),
        ..LiveDetails::default()
    };
    match derive_process_state(&details) {
        PaneProcessState::Running { pid: Some(42) } => {}
        other => panic!("expected Running with pid 42, got {other:?}"),
    }
}

#[test]
fn derive_process_state_unknown_when_pid_missing_and_alive() {
    assert!(matches!(
        derive_process_state(&LiveDetails::default()),
        PaneProcessState::Unknown
    ));
}

#[test]
fn pane_size_falls_back_to_window_when_details_are_zero() {
    let details = LiveDetails::default();
    let fallback = TerminalSizeSpec::new(80, 24);
    assert_eq!(pane_size_from_details(&details, &fallback), fallback);
}

#[test]
fn pane_size_uses_details_when_present() {
    let details = LiveDetails {
        cols: 132,
        rows: 50,
        ..LiveDetails::default()
    };
    let fallback = TerminalSizeSpec::new(80, 24);
    assert_eq!(
        pane_size_from_details(&details, &fallback),
        TerminalSizeSpec::new(132, 50)
    );
}

#[test]
fn parse_details_line_rejects_malformed_pane_id_prefix() {
    let line = "no-prefix\t1\t0\t\t\t1\t1\t0\t0\t1\t0\t0\t0\t\t0\t0\t0\t\t\t\t\t\t\t\t/tmp";
    assert!(parse_details_line(line).is_err());
}

#[test]
fn parse_details_line_treats_unset_cursor_visibility_as_visible() {
    let line = "%1\t1\t0\t\t\t1\t1\t0\t0\t\t0\t0\t0\t\t0\t0\t0\t\t\t\t\t\t\t\t/tmp";
    let details = parse_details_line(line).expect("parses");
    assert!(details.cursor_visible);
}

fn wire_glyph_cell(text: &str, width: u8) -> PaneSnapshotCell {
    PaneSnapshotCell {
        text: text.to_owned(),
        width,
        padding: false,
        attributes: 0,
        fg: PaneColor::DEFAULT_ENCODING,
        bg: PaneColor::DEFAULT_ENCODING,
        us: PaneColor::DEFAULT_ENCODING,
        link: 0,
    }
}

fn wire_padding_cell() -> PaneSnapshotCell {
    PaneSnapshotCell {
        text: " ".to_owned(),
        width: 0,
        padding: true,
        attributes: 0,
        fg: PaneColor::DEFAULT_ENCODING,
        bg: PaneColor::DEFAULT_ENCODING,
        us: PaneColor::DEFAULT_ENCODING,
        link: 0,
    }
}

#[test]
fn cell_from_wire_preserves_padding_metadata() {
    let cell = cell_from_wire(wire_padding_cell());
    assert!(cell.is_padding());
    assert_eq!(cell.glyph.width, 0);
    // Padding markers travel with the berth-term-engine sentinel space text
    // verbatim — the SDK never substitutes a different glyph payload.
    assert_eq!(cell.glyph.text, " ");
}

#[test]
fn cell_from_wire_decodes_attributes_and_colors() {
    let wire = PaneSnapshotCell {
        text: "x".to_owned(),
        width: 1,
        padding: false,
        attributes: PaneAttributes::BOLD.bits() | PaneAttributes::UNDERLINE.bits(),
        fg: PaneColor::ansi(3).encoded(),
        bg: PaneColor::indexed(200).encoded(),
        us: PaneColor::rgb(10, 20, 30).encoded(),
        link: 7,
    };
    let cell = cell_from_wire(wire);
    assert!(!cell.is_padding());
    assert_eq!(cell.text(), "x");
    assert!(cell.attributes.contains(PaneAttributes::BOLD));
    assert!(cell.attributes.contains(PaneAttributes::UNDERLINE));
    assert_eq!(cell.foreground, PaneColor::ansi(3));
    assert_eq!(cell.background, PaneColor::indexed(200));
    assert_eq!(cell.underline, PaneColor::rgb(10, 20, 30));
}

#[test]
fn cell_from_wire_keeps_wide_glyph_width() {
    let cell = cell_from_wire(wire_glyph_cell("漢", 2));
    assert!(!cell.is_padding());
    assert_eq!(cell.glyph.width, 2);
    assert_eq!(cell.text(), "漢");
}

#[test]
fn snapshot_from_response_carries_cells_cursor_and_revision() {
    let response = PaneSnapshotResponse {
        cols: 2,
        rows: 1,
        cells: vec![wire_glyph_cell("a", 1), wire_glyph_cell("b", 1)],
        cursor: PaneSnapshotCursor {
            row: 0,
            col: 1,
            visible: true,
            style: 4,
        },
        revision: 0xCAFE_BEEF,
    };
    let snapshot = snapshot_from_response(response).expect("valid wire shape");
    assert_eq!(snapshot.cols, 2);
    assert_eq!(snapshot.rows, 1);
    assert!(snapshot.is_row_major_shape());
    assert_eq!(snapshot.cells[0].text(), "a");
    assert_eq!(snapshot.cells[1].text(), "b");
    assert_eq!(snapshot.cursor.col, 1);
    assert_eq!(snapshot.cursor.style, 4);
    assert!(snapshot.cursor.visible);
    assert_eq!(snapshot.revision, 0xCAFE_BEEF);
}

#[test]
fn snapshot_from_response_handles_zero_dimensions() {
    let response = PaneSnapshotResponse {
        cols: 0,
        rows: 0,
        cells: Vec::new(),
        cursor: PaneSnapshotCursor {
            row: 0,
            col: 0,
            visible: true,
            style: 0,
        },
        revision: 0,
    };
    let snapshot = snapshot_from_response(response).expect("valid zero-size wire shape");
    assert!(snapshot.is_row_major_shape());
    assert_eq!(snapshot.revision, 0);
}

#[test]
fn snapshot_from_response_rejects_malformed_wire_shape() {
    let response = PaneSnapshotResponse {
        cols: 2,
        rows: 2,
        cells: vec![wire_glyph_cell("a", 1)],
        cursor: PaneSnapshotCursor {
            row: 0,
            col: 0,
            visible: true,
            style: 0,
        },
        revision: 1,
    };

    let error = snapshot_from_response(response).expect_err("shape mismatch is protocol error");
    assert!(
        error
            .to_string()
            .contains("pane-snapshot response had malformed row-major cell shape"),
        "unexpected error: {error}"
    );
}

fn guarded_pane() -> Pane {
    let (stream, _peer) = tokio::io::duplex(4096);
    let mut pane = Pane::new_by_id(
        PaneRef::new(berth_term_proto::SessionName::new("alpha").unwrap(), 0, 0),
        PaneId::new(4),
        TerminalEndpoint::Default,
        None,
        crate::transport::TransportClient::spawn(stream),
    );
    pane.generation_guard = Some(7);
    pane
}

fn binding_failure(result: crate::Result<()>) -> PaneBindingFailure {
    match result.expect_err("binding must be stale") {
        TerminalError::Protocol {
            source: berth_term_proto::TerminalError::PaneBindingInvalid { reason },
        } => reason,
        error => panic!("expected pane binding failure, got {error:?}"),
    }
}

#[tokio::test]
async fn guarded_info_rejects_respawned_or_missing_pane() {
    let pane = guarded_pane();
    let mut entry = PaneInfo::new(PaneId::new(4), WindowId::new(1), SessionId::new(2));
    entry.generation = 7;
    let mut info = InfoSnapshot::new(Vec::new(), Vec::new(), vec![entry]);
    pane.verify_info_snapshot(&info).expect("same generation");

    info.panes[0].generation = 8;
    assert_eq!(
        binding_failure(pane.verify_info_snapshot(&info)),
        PaneBindingFailure::StaleGeneration,
    );
    info.panes[0].id = PaneId::new(5);
    assert_eq!(
        binding_failure(pane.verify_info_snapshot(&info)),
        PaneBindingFailure::StalePane,
    );
    info.panes.clear();
    assert_eq!(
        binding_failure(pane.verify_info_snapshot(&info)),
        PaneBindingFailure::StalePane,
    );
}

#[test]
fn guarded_info_requires_listed_and_displayed_pane_ids_to_match() {
    let expected = PaneId::new(4);
    let mut details = LiveDetails {
        pane_id: Some(expected),
        ..LiveDetails::default()
    };
    verify_guarded_details_pane_id(expected, expected, &details).expect("same pane");
    assert_eq!(
        binding_failure(verify_guarded_details_pane_id(
            expected,
            PaneId::new(5),
            &details
        )),
        PaneBindingFailure::StalePane,
    );
    details.pane_id = Some(PaneId::new(5));
    assert_eq!(
        binding_failure(verify_guarded_details_pane_id(expected, expected, &details)),
        PaneBindingFailure::StalePane,
    );
    details.pane_id = None;
    assert_eq!(
        binding_failure(verify_guarded_details_pane_id(expected, expected, &details)),
        PaneBindingFailure::StalePane,
    );
}

async fn stable_info_probe(displayed_id: &str) -> (crate::Result<InfoSnapshot>, usize) {
    use berth_term_proto::{
        encode_frame, CommandOutput, DisplayMessageResponse, FrameDecoder, LayoutName,
        ListPanesResponse, ListSessionsResponse, ListWindowsResponse, Request, Response,
        TerminalSize, WindowListEntry, WindowTarget,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (stream, mut peer) = tokio::io::duplex(4096);
    let name = berth_term_proto::SessionName::new("alpha").unwrap();
    // 句柄的旧槽位不能代替本次按 ID 解析到的槽位。
    let pane = Pane::new_by_id(
        PaneRef::new(name.clone(), 99, 99),
        PaneId::new(4),
        TerminalEndpoint::Default,
        None,
        crate::transport::TransportClient::spawn(stream),
    );
    let details = format!(
        "{displayed_id}\t1234\t0\t\t\t80\t24\t0\t0\t1\t0\t0\t0\tsh\t7\t2\t3\t\t\t\t\t\t\t\t/tmp"
    );
    let server = tokio::spawn(async move {
        let mut decoder = FrameDecoder::new();
        let mut buffer = [0_u8; 4096];
        let mut pane_lists = 0;
        loop {
            let request = loop {
                if let Some(request) = decoder.next_frame::<Request>().unwrap() {
                    break request;
                }
                let read = peer.read(&mut buffer).await.unwrap();
                assert_ne!(read, 0, "client closed before details request");
                decoder.push_bytes(&buffer[..read]);
            };
            let done = matches!(request, Request::DisplayMessage(_));
            let response = match request {
                Request::ListPanes(_) => {
                    pane_lists += 1;
                    Response::ListPanes(ListPanesResponse {
                        output: CommandOutput::from_stdout(b"2:3:%4\n".to_vec()),
                    })
                }
                Request::ListSessions(_) => Response::ListSessions(ListSessionsResponse {
                    output: CommandOutput::from_stdout(b"alpha\t$1\t/tmp\t0\n".to_vec()),
                }),
                Request::ListWindows(_) => Response::ListWindows(ListWindowsResponse {
                    windows: vec![WindowListEntry {
                        target: WindowTarget::with_window(name.clone(), 2),
                        window_id: "@2".to_owned(),
                        name: None,
                        pane_count: 1,
                        size: TerminalSize { cols: 80, rows: 24 },
                        layout: LayoutName::Tiled,
                        active: true,
                        last: false,
                        rendered: String::new(),
                    }],
                    output: CommandOutput::from_stdout(Vec::new()),
                }),
                Request::DisplayMessage(request) => {
                    assert_eq!(request.target.unwrap().to_string(), "alpha:2.3");
                    Response::DisplayMessage(DisplayMessageResponse::from_output(
                        CommandOutput::from_stdout(details.clone().into_bytes()),
                    ))
                }
                request => panic!("unexpected info request: {request:?}"),
            };
            peer.write_all(&encode_frame(&response).unwrap())
                .await
                .unwrap();
            if done {
                return pane_lists;
            }
        }
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), pane.info())
        .await
        .expect("in-memory info query must finish");
    (result, server.await.unwrap())
}

#[tokio::test]
async fn stable_info_resolves_pane_once_and_preserves_generation() {
    let (result, pane_lists) = stable_info_probe("%4").await;
    let info = result.expect("same stable entity");
    assert_eq!(info.panes[0].id, PaneId::new(4));
    assert_eq!(info.panes[0].index, 3);
    assert_eq!(info.panes[0].generation, 7);
    assert_eq!(
        pane_lists, 1,
        "known pane identity must not be listed twice"
    );
}

#[tokio::test]
async fn stable_info_rejects_replaced_or_missing_detail_identity() {
    for displayed in ["%5", ""] {
        let (result, _) = stable_info_probe(displayed).await;
        assert_eq!(
            binding_failure(result.map(|_| ())),
            PaneBindingFailure::StalePane
        );
    }
}

#[tokio::test]
async fn guarded_handle_rejects_unguarded_slot_operations() {
    let pane = guarded_pane();

    let resolved =
        tokio::time::timeout(std::time::Duration::from_millis(200), pane.current_target())
            .await
            .expect("guarded slot resolution must not wait for daemon I/O");
    assert!(matches!(resolved, Err(TerminalError::Unsupported { .. })));
    let title = tokio::time::timeout(std::time::Duration::from_millis(200), pane.title())
        .await
        .expect("guarded title must not query an unguarded slot");
    assert!(matches!(title, Err(TerminalError::Unsupported { .. })));

    #[cfg(feature = "available")]
    {
        assert!(matches!(
            pane.scroll_history(crate::PaneScrollDirection::Up).await,
            Err(TerminalError::Unsupported { .. })
        ));
        assert!(matches!(
            pane.cancel_copy_mode().await,
            Err(TerminalError::Unsupported { .. })
        ));
    }
}
