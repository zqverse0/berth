//! Sequence-consistent Berth terminal pane snapshots and sequence conversion.

use chrono::Utc;
use berth_term_sdk::berth::{
    Pane, PaneCapture, PaneCaptureBuilder, PaneProcessState, PaneSnapshot, Terminal,
    TerminalSizeSpec,
};

use super::lifecycle::TerminalTarget;
use crate::terminal::protocol::{TerminalSnapshot, TerminalStatus};

const SNAPSHOT_STABILITY_ATTEMPTS: usize = 3;

pub(super) async fn snapshot_for_pane(
    pane: &Pane,
    terminal_id: String,
    backend_instance_id: String,
) -> Result<TerminalSnapshot, berth_term_sdk::berth::TerminalError> {
    snapshot_for_pane_with_history(pane, terminal_id, backend_instance_id, true).await
}

/// Returns the resize acknowledgement snapshot without copying retained
/// scrollback across the IPC boundary. Ordinary resize never repaints xterm;
/// the full-history variant above is reserved for attach/resync snapshots.
pub(super) async fn resize_snapshot_for_pane(
    pane: &Pane,
    terminal_id: String,
    backend_instance_id: String,
) -> Result<TerminalSnapshot, berth_term_sdk::berth::TerminalError> {
    snapshot_for_pane_with_history(pane, terminal_id, backend_instance_id, false).await
}

async fn snapshot_for_pane_with_history(
    pane: &Pane,
    terminal_id: String,
    backend_instance_id: String,
    include_history: bool,
) -> Result<TerminalSnapshot, berth_term_sdk::berth::TerminalError> {
    let info = pane.info().await?;
    let pane_info = info.panes.first();
    let initial_size = pane_info
        .map(|pane| pane.size)
        .unwrap_or_else(|| TerminalSizeSpec::new(80, 24));

    // A capture contains the grid, but not the cursor coordinates. For an
    // attach/resync paint, use the existing structured pane snapshot as a
    // consistency witness around the capture. This keeps the public
    // capture-pane wire surface unchanged while ensuring that a trailing
    // blank row cannot become the cursor's new position in xterm.
    let (screen, cursor_snapshot) = if include_history {
        capture_with_cursor_witness(pane, initial_size).await?
    } else {
        let capture = capture_pane_for_snapshot(pane, initial_size, false).await?;
        (
            ScreenCapture {
                ansi: normalize_snapshot_line_endings_for_xterm(capture.stdout),
                output_sequence: capture.output_sequence,
            },
            None,
        )
    };
    let size = cursor_snapshot
        .as_ref()
        .filter(|snapshot| snapshot.cols > 0 && snapshot.rows > 0)
        .map(|snapshot| TerminalSizeSpec::new(snapshot.cols, snapshot.rows))
        .unwrap_or(initial_size);

    let (status, exit_code, exited_at) = match pane_info.map(|pane| &pane.process) {
        Some(PaneProcessState::Exited) => (
            TerminalStatus::Exited,
            pane_info.and_then(|pane| pane.exit_state.as_ref().and_then(|state| state.shell_code())),
            Some(Utc::now()),
        ),
        Some(PaneProcessState::Running { .. }) => (TerminalStatus::Running, None, None),
        _ => (TerminalStatus::Running, None, None),
    };

    let mut ansi = screen.ansi;
    if let Some(snapshot) = cursor_snapshot.as_ref() {
        append_cursor_restore(&mut ansi, snapshot);
    }

    Ok(TerminalSnapshot {
        terminal_id,
        backend_instance_id,
        // Berth terminal captures the pane contents and the output-ring watermark in
        // one daemon-side critical section. This is the exact boundary the
        // live stream must use; pane-info's transcript counter can race the
        // capture and also uses a different zero/one-based convention.
        sequence: screen.output_sequence,
        rows: size.rows.max(1),
        cols: size.cols.max(1),
        ansi,
        // `history_truncated` means "this payload is not a full retained-history
        // snapshot", not "Berth applied a transport byte-budget trim".
        // Resize acknowledgements are visible-window only and never painted;
        // attach/resync include every row Berth terminal still retains.
        history_truncated: !include_history,
        status,
        exit_code,
        exited_at,
        last_known_cwd: pane_info.and_then(|pane| pane.working_directory.clone()),
    })
}

async fn capture_pane_for_snapshot(
    pane: &Pane,
    size: TerminalSizeSpec,
    include_history: bool,
) -> Result<PaneCapture, berth_term_sdk::berth::TerminalError> {
    let mut capture = pane.capture_pane();
    if include_history {
        // Berth terminal is the authoritative terminal state. Attach/resync snapshots
        // must include all history that Berth terminal still retains, not just the
        // visible rows; otherwise a later xterm reset silently turns a
        // recoverable stream gap into apparent scrollback loss. The `-S -
        // -E -` form is Berth terminal's absolute capture range and is resolved
        // atomically with `output_sequence`.
        capture = capture.start_absolute(0).end_absolute(0);
    } else {
        capture = capture.start(-(i64::from(size.rows.max(1)))).end(0);
    }
    // 软换行按逻辑行回传：xterm 已切到快照列宽，会以同一宽度重新折行并标 isWrapped，
    // 之后改宽度才能正确重排；硬换行会把长行永久切碎。
    // 边界（恰好满列、满列后接宽字符）见 berth-term-engine `joined_snapshot_replays_*`。
    styled_capture(capture).join_wrapped(true).await
}

async fn capture_with_cursor_witness(
    pane: &Pane,
    size: TerminalSizeSpec,
) -> Result<(ScreenCapture, Option<PaneSnapshot>), berth_term_sdk::berth::TerminalError> {
    // Older/remote daemons may not expose the structured snapshot endpoint.
    // In that case keep the existing capture behavior rather than making
    // attach unavailable just because cursor restoration is an enhancement.
    let mut before = match pane.snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) if is_expired_pane_binding(&error) => return Err(error),
        Err(_) => return Ok((capture_screen(pane, size).await?, None)),
    };
    let mut last_capture = None;

    for _ in 0..SNAPSHOT_STABILITY_ATTEMPTS {
        let capture = capture_screen(pane, size).await?;
        let after = match pane.snapshot().await {
            Ok(snapshot) => snapshot,
            Err(error) if is_expired_pane_binding(&error) => return Err(error),
            Err(_) => return Ok((capture, None)),
        };
        if before.revision != 0
            && before.revision == after.revision
            && after.cols > 0
            && after.rows > 0
        {
            return Ok((capture, Some(after)));
        }
        last_capture = Some(capture);
        before = after;
    }

    // A continuously updating TUI may never provide a quiet pair of
    // structured snapshots. Preserve attach availability and fall back to
    // the old bytes-only paint instead of applying a cursor from a different
    // revision to the captured grid.
    Ok((
        last_capture.expect("stability loop always captures at least once"),
        None,
    ))
}

/// Snapshot body ready for xterm: rows, then the modes the app has enabled.
struct ScreenCapture {
    ansi: Vec<u8>,
    output_sequence: u64,
}

/// Terminal state that `capture-pane` text does not carry: without it a
/// resync paints a full-screen app into the normal buffer and the wheel,
/// cursor keys and paste stop reaching the app (research D3).
const TERMINAL_MODES_FORMAT: &str = "#{alternate_on}|#{mouse_standard_flag}|#{mouse_button_flag}|#{mouse_all_flag}|#{mouse_sgr_flag}|#{mouse_utf8_flag}|#{bracket_paste_flag}|#{keypad_cursor_flag}|#{keypad_flag}|#{history_size}";

#[derive(Debug)]
struct TerminalModes {
    alternate: bool,
    history_size: u64,
    /// Re-enables every active mode on the freshly reset xterm.
    restore: Vec<u8>,
}

async fn query_terminal_modes(
    pane: &Pane,
) -> Result<TerminalModes, berth_term_sdk::berth::TerminalError> {
    match pane.display(TERMINAL_MODES_FORMAT).await {
        Ok(line) => Ok(parse_terminal_modes(line.as_deref().unwrap_or(""))),
        Err(error) if is_expired_pane_binding(&error) => Err(error),
        Err(_) => Ok(parse_terminal_modes("")),
    }
}

fn parse_terminal_modes(line: &str) -> TerminalModes {
    let fields: Vec<&str> = line.split('|').collect();
    let on = |index: usize| fields.get(index).is_some_and(|value| *value == "1");
    let mut restore = Vec::new();
    // xterm tracks one mouse level; the widest active one wins.
    if on(3) {
        restore.extend_from_slice(b"\x1b[?1003h");
    } else if on(2) {
        restore.extend_from_slice(b"\x1b[?1002h");
    } else if on(1) {
        restore.extend_from_slice(b"\x1b[?1000h");
    }
    if on(4) {
        restore.extend_from_slice(b"\x1b[?1006h");
    }
    if on(5) {
        restore.extend_from_slice(b"\x1b[?1005h");
    }
    // Daemons that cannot answer keep the previous default: paste stays wrapped.
    if fields.get(6).is_none_or(|value| *value != "0") {
        restore.extend_from_slice(b"\x1b[?2004h");
    }
    if on(7) {
        restore.extend_from_slice(b"\x1b[?1h");
    }
    if on(8) {
        restore.extend_from_slice(b"\x1b=");
    }
    TerminalModes {
        alternate: on(0),
        history_size: fields
            .get(9)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        restore,
    }
}

/// What a freshly reset xterm must replay to show the pane as it is now.
async fn capture_screen(
    pane: &Pane,
    size: TerminalSizeSpec,
) -> Result<ScreenCapture, berth_term_sdk::berth::TerminalError> {
    let modes = query_terminal_modes(pane).await?;
    if modes.alternate {
        for _ in 0..SNAPSHOT_STABILITY_ATTEMPTS {
            if let Some(screen) = capture_alternate_screen(pane, size, &modes).await? {
                return Ok(screen);
            }
        }
        // Output keeps racing the captures: paint the main grid as before.
    }

    let capture = capture_pane_for_snapshot(pane, size, true).await?;
    let mut ansi = normalize_snapshot_line_endings_for_xterm(capture.stdout);
    // capture-pane terminates every rendered row, including the final
    // row. That last separator is a real LF/CRLF movement when replayed
    // by xterm: it scrolls the captured grid once and leaves the visible
    // rows one line below their Berth terminal positions. It is a row delimiter in
    // the capture format, not terminal output that belongs in the paint.
    strip_final_snapshot_line_separator(&mut ansi);
    ansi.extend_from_slice(&modes.restore);
    Ok(ScreenCapture {
        ansi,
        output_sequence: capture.output_sequence,
    })
}

/// `None` when output landed between the captures.
async fn capture_alternate_screen(
    pane: &Pane,
    size: TerminalSizeSpec,
    modes: &TerminalModes,
) -> Result<Option<ScreenCapture>, berth_term_sdk::berth::TerminalError> {
    // tmux layout: the main grid holds the normal history plus the alternate
    // rows; `-a` holds the normal rows saved on entry. Replay the normal
    // screen first so leaving the app restores it, then switch and put each
    // alternate row in place (the app owns that layout; never re-wrap it).
    let rows = i64::from(size.rows.max(1));
    let visible = styled_capture(pane.capture_pane().start(0).end(rows - 1))
        .join_wrapped(false)
        .await?;
    let saved = styled_capture(pane.capture_pane().alternate(true).quiet(true))
        .join_wrapped(true)
        .await?;
    let mut normal = Vec::new();
    if modes.history_size > 0 {
        let history = styled_capture(pane.capture_pane().start_absolute(0).end(-1))
            .join_wrapped(true)
            .await?;
        if history.output_sequence != visible.output_sequence {
            return Ok(None);
        }
        normal = history.stdout;
    }
    if saved.output_sequence != visible.output_sequence {
        return Ok(None);
    }
    normal.extend_from_slice(&saved.stdout);
    let mut ansi = normalize_snapshot_line_endings_for_xterm(normal);
    strip_final_snapshot_line_separator(&mut ansi);
    ansi.extend_from_slice(b"\x1b[0m\x1b[?1049h");
    for (row, line) in visible
        .stdout
        .split(|byte| *byte == b'\n')
        .take(size.rows.max(1).into())
        .enumerate()
    {
        ansi.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        ansi.extend_from_slice(line);
    }
    ansi.extend_from_slice(&modes.restore);
    Ok(Some(ScreenCapture {
        ansi,
        output_sequence: visible.output_sequence,
    }))
}

fn styled_capture(capture: PaneCaptureBuilder<'_>) -> PaneCaptureBuilder<'_> {
    capture
        .escape_ansi(true)
        .preserve_trailing_spaces(true)
        .do_not_trim_spaces(true)
}

/// Appends only state that is not represented by `capture-pane` text.
///
/// The explicit position is intentionally emitted after all captured rows.
/// It is what makes the subsequent live byte stream start at Berth terminal's real
/// cursor instead of at the final blank row. The reset also prevents the
/// final cell's SGR state from leaking into the first live event.
fn is_expired_pane_binding(error: &berth_term_sdk::berth::TerminalError) -> bool {
    matches!(
        error,
        berth_term_sdk::berth::TerminalError::Protocol {
            source: berth_term_sdk::berth::ProtocolError::PaneBindingInvalid { .. },
            ..
        }
    )
}

fn append_cursor_restore(bytes: &mut Vec<u8>, snapshot: &PaneSnapshot) {
    let rows = snapshot.rows.max(1);
    let cols = snapshot.cols.max(1);
    let row = snapshot.cursor.row.min(rows.saturating_sub(1)) + 1;
    let col = snapshot.cursor.col.min(cols.saturating_sub(1)) + 1;

    bytes.extend_from_slice(b"\x1b[0m");
    if (1..=6).contains(&snapshot.cursor.style) {
        bytes.extend_from_slice(format!("\x1b[{} q", snapshot.cursor.style).as_bytes());
    }
    bytes.extend_from_slice(format!("\x1b[{row};{col}H").as_bytes());
    bytes.extend_from_slice(if snapshot.cursor.visible {
        b"\x1b[?25h"
    } else {
        b"\x1b[?25l"
    });
}

pub(super) async fn pane_for_target(
    terminal: &Terminal,
    target: &TerminalTarget,
) -> Result<Pane, berth_term_sdk::berth::TerminalError> {
    Ok(terminal
        .session(target.session.clone())
        .await?
        .pane(target.window_index, target.pane_index))
}

pub(super) const fn terminal_sequence_from_runtime(sequence: u64) -> u64 {
    sequence.saturating_add(1)
}

pub(super) const fn runtime_sequence_is_snapshot_covered(
    sequence: u64,
    snapshot_watermark: u64,
) -> bool {
    sequence < snapshot_watermark
}

/// Berth terminal `capture-pane -p` separates screen rows with LF only. LF is a vertical
/// movement in a VT terminal and does not return the cursor to column zero, so
/// snapshots need CRLF row separators before xterm paints them.
pub(super) fn normalize_snapshot_line_endings_for_xterm(bytes: Vec<u8>) -> Vec<u8> {
    let bare_lf_count = bytes
        .iter()
        .enumerate()
        .filter(|(index, byte)| **byte == b'\n' && (*index == 0 || bytes[*index - 1] != b'\r'))
        .count();
    if bare_lf_count == 0 {
        return bytes;
    }

    let mut normalized = Vec::with_capacity(bytes.len().saturating_add(bare_lf_count));
    let mut previous = None;
    for byte in bytes {
        if byte == b'\n' && previous != Some(b'\r') {
            normalized.push(b'\r');
        }
        normalized.push(byte);
        previous = Some(byte);
    }
    normalized
}

/// Removes the row separator emitted after the final line of a painted
/// `capture-pane` snapshot.
fn strip_final_snapshot_line_separator(bytes: &mut Vec<u8>) {
    if bytes.ends_with(b"\r\n") {
        bytes.truncate(bytes.len().saturating_sub(2));
    } else if bytes.ends_with(b"\n") {
        bytes.truncate(bytes.len().saturating_sub(1));
    }
}

#[cfg(test)]
mod tests {
    use super::{append_cursor_restore, parse_terminal_modes, strip_final_snapshot_line_separator};
    use berth_term_sdk::berth::{PaneCursor, PaneSnapshot};

    fn snapshot(rows: u16, cols: u16, cursor: PaneCursor) -> PaneSnapshot {
        PaneSnapshot {
            rows,
            cols,
            cursor,
            ..PaneSnapshot::default()
        }
    }

    #[test]
    fn full_screen_app_modes_are_restored_after_reset() {
        // Cline-like TUI: alternate screen, any-event SGR mouse, paste, DECCKM.
        let modes = parse_terminal_modes("1|1|1|1|1|0|1|1|0|42");
        assert!(modes.alternate);
        assert_eq!(modes.history_size, 42);
        assert_eq!(modes.restore, b"\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1h");
    }

    #[test]
    fn modes_the_app_turned_off_stay_off() {
        let modes = parse_terminal_modes("0|0|0|0|0|0|0|0|0|0");
        assert!(!modes.alternate);
        assert!(modes.restore.is_empty());
    }

    #[test]
    fn unknown_modes_keep_the_previous_paste_default() {
        // Older daemons expand unknown variables to "" or cannot answer at all.
        for line in ["", "||||||||"] {
            let modes = parse_terminal_modes(line);
            assert!(!modes.alternate);
            assert_eq!(modes.restore, b"\x1b[?2004h");
        }
    }

    #[test]
    fn final_capture_separator_is_not_replayed_as_a_terminal_row() {
        let mut bytes = b"first\r\nsecond\r\n".to_vec();
        strip_final_snapshot_line_separator(&mut bytes);
        assert_eq!(bytes, b"first\r\nsecond");
    }

    #[test]
    fn final_capture_separator_preserves_trailing_spaces_in_the_last_row() {
        let mut bytes = b"last row  \r\n".to_vec();
        strip_final_snapshot_line_separator(&mut bytes);
        assert_eq!(bytes, b"last row  ");
    }

    #[test]
    fn cursor_restore_uses_authoritative_position_and_visibility() {
        let mut bytes = b"captured\r\n".to_vec();
        append_cursor_restore(
            &mut bytes,
            &snapshot(24, 80, PaneCursor::new(5, 7, false, 4)),
        );

        assert_eq!(bytes, b"captured\r\n\x1b[0m\x1b[4 q\x1b[6;8H\x1b[?25l");
    }

    #[test]
    fn cursor_restore_clamps_pathological_coordinates_to_the_grid() {
        let mut bytes = Vec::new();
        append_cursor_restore(
            &mut bytes,
            &snapshot(2, 3, PaneCursor::new(u16::MAX, u16::MAX, true, 0)),
        );

        assert_eq!(bytes, b"\x1b[0m\x1b[2;3H\x1b[?25h");
    }
}
