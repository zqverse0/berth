//! Personal terminal attachment setup and subscriber registration.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use berth_term_sdk::berth::{PaneOutputStart, Terminal};

use super::binding::pane_for_binding;
use super::lifecycle::{remove_subscriber, SubscriberHandle};
use super::snapshot::snapshot_for_pane;
use super::stream::run_stream_worker;
use super::terminal_manager::{short_id, terminal_error_from_sdk, TerminalSessionManager};
use crate::terminal::error::TerminalError;
use crate::terminal::protocol::{
    SubscriberControl, TerminalAttachment, TerminalResume, TerminalSnapshot,
};

impl TerminalSessionManager {
    /// Attaches to the live pane output while preserving the existing Berth
    /// snapshot/replay/stream boundary.
    pub fn attach(
        &self,
        terminal_id: &str,
        client_id: &str,
    ) -> Result<TerminalAttachment, TerminalError> {
        self.attach_from(terminal_id, client_id, None)
    }

    /// Attaches to a pane. Berth terminal provides the live stream; Berth remains the
    /// owner of the outer attachment channels and lifecycle events.
    pub fn attach_from(
        &self,
        terminal_id: &str,
        client_id: &str,
        _applied_sequence: Option<u64>,
    ) -> Result<TerminalAttachment, TerminalError> {
        let resolved = self.resolve_terminal(terminal_id)?;
        let (data_tx, data_rx) =
            tokio::sync::mpsc::channel(self.inner.limits.subscriber_capacity.max(1));
        let (control_tx, control_rx) =
            tokio::sync::watch::channel(SubscriberControl::Attached { sequence: 0 });
        let stop = Arc::new(AtomicBool::new(false));
        let attachment_stop = Arc::clone(&stop);
        let handle = SubscriberHandle {
            stop: stop.clone(),
            control_tx: control_tx.clone(),
        };

        // The Berth terminal SDK transport actor is spawned on the Tokio runtime that
        // creates it. Do not create a PaneOutputStream in `execute()` and move
        // it out: `execute()` drops its runtime as soon as the snapshot call
        // returns, which silently kills the actor before the live worker can
        // read its first output chunk. The setup and stream loop therefore
        // share one worker-owned runtime for their entire lifetime.
        let endpoint = self.inner.endpoint.clone();
        let backend = self.inner.backend_instance_id.clone();
        let terminal_id_for_worker = terminal_id.to_string();
        let client_id_for_worker = client_id.to_string();
        let resolved_for_worker = resolved.clone();
        let inner = self.inner.clone();
        let worker_control_tx = control_tx.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<TerminalSnapshot, TerminalError>>(1);
        let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();

        thread::Builder::new()
            .name(format!("berth-term-stream-{}", short_id(terminal_id)))
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(TerminalError::SpawnFailed(error.to_string())));
                        return;
                    }
                };

                runtime.block_on(async move {
                    let setup = async {
                        let terminal = Terminal::builder()
                            .unix_socket(endpoint)
                            .connect()
                            .await
                            .map_err(|error| {
                                terminal_error_from_sdk(
                                    error,
                                    Some(terminal_id_for_worker.as_str()),
                                )
                            })?;
                        let pane = pane_for_binding(&terminal, &resolved_for_worker)
                            .await
                            .map_err(|error| {
                                terminal_error_from_sdk(
                                    error,
                                    Some(terminal_id_for_worker.as_str()),
                                )
                            })?;
                        let stream = pane
                            .output_stream_starting_at(PaneOutputStart::Now)
                            .await
                            .map_err(|error| {
                                terminal_error_from_sdk(
                                    error,
                                    Some(terminal_id_for_worker.as_str()),
                                )
                            })?;
                        let snapshot =
                            snapshot_for_pane(&pane, terminal_id_for_worker.clone(), backend)
                                .await
                                .map_err(|error| {
                                    terminal_error_from_sdk(
                                        error,
                                        Some(terminal_id_for_worker.as_str()),
                                    )
                                })?;
                        let cutoff = snapshot.sequence;
                        Ok::<_, TerminalError>((pane, stream, snapshot, cutoff))
                    };

                    match setup.await {
                        Ok((pane, stream, snapshot, cutoff)) => {
                            if ready_tx.send(Ok(snapshot)).is_err() {
                                return;
                            }
                            if start_rx.await.is_err() {
                                return;
                            }
                            run_stream_worker(
                                inner,
                                terminal_id_for_worker,
                                client_id_for_worker,
                                pane,
                                stream,
                                cutoff,
                                stop,
                                data_tx,
                                worker_control_tx,
                            )
                            .await;
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                        }
                    }
                });
            })
            .map_err(|error| TerminalError::SpawnFailed(error.to_string()))?;

        let snapshot = ready_rx.recv().map_err(|_| {
            TerminalError::SpawnFailed(
                "terminal stream worker exited during attach setup".to_string(),
            )
        })??;
        let cutoff = snapshot.sequence;
        control_tx.send_replace(SubscriberControl::Attached { sequence: cutoff });

        {
            let mut sessions = self.inner.sessions.lock().expect("terminal index lock");
            let record = sessions
                .get_mut(terminal_id)
                .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
            record.sequence = record.sequence.max(cutoff);
            if let Some(previous) = record.subscribers.remove(client_id) {
                previous.stop.store(true, Ordering::Release);
            }
            record.subscribers.insert(client_id.to_string(), handle);
        }

        // The worker holds the live SDK stream until this point so the
        // snapshot boundary and subscriber registration are both complete
        // before any post-snapshot bytes are forwarded.
        let _ = start_tx.send(());

        Ok(TerminalAttachment {
            snapshot,
            resume: TerminalResume::Snapshot,
            data_rx,
            control_rx,
            stop: attachment_stop,
        })
    }

    /// 只拆除这一次 attach：同一 client 已经重新 attach 时，新订阅保持不动。
    pub fn detach_attachment(
        &self,
        terminal_id: &str,
        client_id: &str,
        attachment: &TerminalAttachment,
    ) {
        attachment.stop.store(true, Ordering::Release);
        remove_subscriber(&self.inner, terminal_id, client_id, &attachment.stop);
    }

    /// Detaches a client without closing the Berth terminal window or pane process.
    pub fn detach(&self, terminal_id: &str, client_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self.inner.sessions.lock().expect("terminal index lock");
        let record = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        if let Some(subscriber) = record.subscribers.remove(client_id) {
            subscriber.stop.store(true, Ordering::Release);
        }
        Ok(())
    }
}
