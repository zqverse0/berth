//! Sequence-consistent Berth terminal pane snapshots and sequence conversion.

use chrono::Utc;
use berth_term_sdk::berth::{Pane, PaneProcessState, Terminal, TerminalSizeSpec};

use super::lifecycle::TerminalTarget;
use crate::terminal::protocol::{TerminalSnapshot, TerminalStatus};

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

    // 画面拼装（备用屏、终端模式、光标）在 SDK 的 `Pane::paint`，与远端节点共用。
    let paint = if include_history {
        pane.paint(initial_size, true).await?
    } else {
        pane.paint_rows(initial_size).await?
    };

    let (status, exit_code, exited_at) = match pane_info.map(|pane| &pane.process) {
        Some(PaneProcessState::Exited) => (
            TerminalStatus::Exited,
            pane_info.and_then(|pane| pane.exit_state.as_ref().and_then(|state| state.shell_code())),
            Some(Utc::now()),
        ),
        Some(PaneProcessState::Running { .. }) => (TerminalStatus::Running, None, None),
        _ => (TerminalStatus::Running, None, None),
    };

    Ok(TerminalSnapshot {
        terminal_id,
        backend_instance_id,
        // Berth terminal captures the pane contents and the output-ring watermark in
        // one daemon-side critical section. This is the exact boundary the
        // live stream must use; pane-info's transcript counter can race the
        // capture and also uses a different zero/one-based convention.
        sequence: paint.output_sequence,
        rows: paint.size.rows.max(1),
        cols: paint.size.cols.max(1),
        ansi: paint.ansi,
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

#[cfg(test)]
pub(super) use berth_term_sdk::berth::normalize_snapshot_line_endings_for_xterm;
