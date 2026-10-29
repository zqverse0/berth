//! Live Berth terminal output stream boundary for Berth attachments.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::Utc;
use berth_term_sdk::berth::{Pane, PaneOutputChunk, PaneOutputStream, PaneProcessState};

use super::lifecycle::{
    clear_runtime_index_inner, mark_exited, remove_subscriber, update_record_sequence,
    TerminalSessionManagerInner,
};
use super::snapshot::{runtime_sequence_is_snapshot_covered, terminal_sequence_from_runtime};
use super::terminal_manager::short_id;
use crate::terminal::protocol::{SubscriberControl, TerminalStatus, TerminalStreamEvent};

pub(super) async fn run_stream_worker(
    inner: Arc<TerminalSessionManagerInner>,
    terminal_id: String,
    client_id: String,
    pane: Pane,
    mut stream: PaneOutputStream,
    cutoff: u64,
    stop: Arc<AtomicBool>,
    data_tx: tokio::sync::mpsc::Sender<TerminalStreamEvent>,
    control_tx: tokio::sync::watch::Sender<SubscriberControl>,
) {
    let cleanup_inner = inner.clone();
    let transport_cleanup_inner = cleanup_inner.clone();
    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        match stream.next().await {
            Ok(Some(PaneOutputChunk::Bytes { sequence, bytes })) => {
                // Berth terminal uses an empty output chunk as the pane EOF marker,
                // not as visible terminal data.
                if bytes.is_empty() {
                    continue;
                }
                // `cutoff` is the next Berth terminal ring sequence covered by the
                // atomic snapshot. Events strictly before it are already
                // painted in that snapshot; the event at the cutoff is
                // the first live event after it.
                if runtime_sequence_is_snapshot_covered(sequence, cutoff) {
                    continue;
                }
                // Berth terminal ring events are zero-based while Berth's stream
                // contract is one-based (snapshot 0 -> first event 1).
                let sequence = terminal_sequence_from_runtime(sequence);
                let event = TerminalStreamEvent::Output {
                    terminal_id: terminal_id.clone(),
                    sequence,
                    data: bytes,
                };
                update_record_sequence(&inner, sequence, &terminal_id);
                if data_tx.send(event).await.is_err() {
                    break;
                }
            }
            Ok(Some(PaneOutputChunk::Lag(lag))) => {
                let sequence = terminal_sequence_from_runtime(lag.newest_sequence);
                update_record_sequence(&inner, sequence, &terminal_id);
                let _ = control_tx.send_replace(SubscriberControl::ResyncRequired { sequence });
                let _ = data_tx
                    .send(TerminalStreamEvent::HistoryTruncated {
                        terminal_id: terminal_id.clone(),
                        sequence,
                    })
                    .await;
                break;
            }
            Ok(Some(_)) => {
                let _ =
                    control_tx.send_replace(SubscriberControl::ResyncRequired { sequence: cutoff });
                break;
            }
            Ok(None) => {
                let snapshot = pane.info().await.ok();
                let (status, exit_code) = snapshot
                    .as_ref()
                    .and_then(|info| info.panes.first())
                    .map(|pane| match &pane.process {
                        PaneProcessState::Exited => (
                            TerminalStatus::Exited,
                            pane.exit_state.as_ref().and_then(|state| state.shell_code()),
                        ),
                        _ => (TerminalStatus::Running, None),
                    })
                    .unwrap_or((TerminalStatus::Exited, None));
                if status == TerminalStatus::Exited {
                    let latest_sequence = snapshot
                        .as_ref()
                        .and_then(|info| info.panes.first())
                        .map(|pane| pane.output_sequence)
                        .unwrap_or(cutoff);
                    let sequence = latest_sequence.saturating_add(1);
                    let exited_at = Utc::now();
                    let _ = data_tx
                        .send(TerminalStreamEvent::StatusChanged {
                            terminal_id: terminal_id.clone(),
                            sequence,
                            status,
                            exit_code,
                            exited_at: Some(exited_at),
                        })
                        .await;
                    mark_exited(&inner, &terminal_id, exit_code, sequence, exited_at);
                }
                break;
            }
            Err(error) => {
                let _ =
                    control_tx.send_replace(SubscriberControl::ResyncRequired { sequence: cutoff });
                if matches!(
                    &error,
                    berth_term_sdk::berth::TerminalError::Transport { .. }
                ) {
                    clear_runtime_index_inner(&transport_cleanup_inner);
                }
                tracing::debug!(
                    error = %error,
                    terminal = %short_id(&terminal_id),
                    "terminal pane output stream stopped"
                );
                break;
            }
        }
    }

    remove_subscriber(&cleanup_inner, &terminal_id, &client_id, &stop);
}
