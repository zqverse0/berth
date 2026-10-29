//! Ordered input, resize, and resynchronization operations for attachments.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use berth_term_sdk::berth::TerminalSizeSpec;

use super::binding::{bound_pane, pane_for_binding};
use super::lifecycle::TerminalSessionManagerInner;
use super::model::TerminalOperationError;
use super::snapshot::resize_snapshot_for_pane;
use super::terminal_manager::{operation_error_for_terminal, TerminalSessionManager};
use super::validation::{clamp_grid, input_text};
use crate::terminal::error::TerminalErrorCode;
use crate::terminal::protocol::{SubscriberControl, TerminalSnapshot};

impl TerminalSessionManager {
    /// Delivers background text and its submit key as one completed daemon action.
    pub fn send_text_then_key(
        &self,
        terminal_id: &str,
        text: &str,
        key: &str,
    ) -> Result<(), TerminalOperationError> {
        let resolved = self
            .resolve_terminal(terminal_id)
            .map_err(operation_error_for_terminal)?;
        let terminal_id = terminal_id.to_string();
        let text = text.to_string();
        let key = key.to_string();
        self.execute(false, Some(terminal_id), move |terminal| async move {
            let pane = pane_for_binding(terminal.as_ref(), &resolved).await?;
            pane.send_text(text).await?;
            pane.send_key(key).await
        })
        .map_err(operation_error_for_terminal)
    }

    /// 不经 attach 向终端 pane 发送一个 tmux 按键名，语义同 `berth terminal send --key`。
    pub fn send_key(&self, terminal_id: &str, key: &str) -> Result<(), TerminalOperationError> {
        let resolved = self
            .resolve_terminal(terminal_id)
            .map_err(operation_error_for_terminal)?;
        let key = key.to_string();
        self.execute(
            false,
            Some(terminal_id.to_string()),
            move |terminal| async move {
                pane_for_binding(terminal.as_ref(), &resolved)
                    .await?
                    .send_key(key)
                    .await
            },
        )
        .map_err(operation_error_for_terminal)
    }

    fn attached_input_context(
        &self,
        terminal_id: &str,
        client_id: &str,
    ) -> Result<(Arc<Mutex<()>>, Arc<AtomicBool>), TerminalOperationError> {
        let sessions = self.inner.sessions.lock().expect("terminal index lock");
        let record = sessions
            .get(terminal_id)
            .ok_or(TerminalErrorCode::TerminalNotFound)?;
        let subscriber = record
            .subscribers
            .get(client_id)
            .ok_or(TerminalErrorCode::TerminalTransportDisconnected)?;
        Ok((record.input_lock.clone(), subscriber.stop.clone()))
    }

    /// Writes input with Berth's ordered-client ACK semantics.
    pub fn write_attached(
        &self,
        terminal_id: &str,
        client_id: &str,
        input_sequence: u64,
        data: &[u8],
    ) -> Result<u64, TerminalOperationError> {
        let text = input_text(data);
        self.send_attached_input(
            terminal_id,
            client_id,
            input_sequence,
            AttachedInput::Text(text),
        )
    }

    /// Sends one named key through the same ordered attachment contract as text.
    pub fn send_attached_key(
        &self,
        terminal_id: &str,
        client_id: &str,
        input_sequence: u64,
        key: &str,
    ) -> Result<u64, TerminalOperationError> {
        self.send_attached_input(
            terminal_id,
            client_id,
            input_sequence,
            AttachedInput::Key(key.to_string()),
        )
    }

    fn send_attached_input(
        &self,
        terminal_id: &str,
        client_id: &str,
        input_sequence: u64,
        input: AttachedInput,
    ) -> Result<u64, TerminalOperationError> {
        let resolved = self
            .resolve_terminal(terminal_id)
            .map_err(operation_error_for_terminal)?;
        let (input_lock, subscriber_stop) = self.attached_input_context(terminal_id, client_id)?;
        let _input_guard = input_lock.lock().expect("terminal input lock");
        let accepted = {
            let sessions = self.inner.sessions.lock().expect("terminal index lock");
            let record = sessions
                .get(terminal_id)
                .ok_or(TerminalErrorCode::TerminalNotFound)?;
            if !record.subscribers.contains_key(client_id) {
                return Err(TerminalErrorCode::TerminalTransportDisconnected.into());
            }
            record.input_sequences.get(client_id).copied().unwrap_or(0)
        };
        if input_sequence <= accepted {
            return Ok(accepted);
        }
        if input_sequence != accepted.saturating_add(1) {
            return Err(TerminalErrorCode::InputOutOfOrder.into());
        }

        // Do not hold the session index mutex while waiting for the Berth terminal
        // executor or the PTY write. The input lock above preserves ordering
        // with resize and concurrent writes for this terminal.
        let inner = self.inner.clone();
        let terminal_id_owned = terminal_id.to_string();
        let client_id_owned = client_id.to_string();
        self.enqueue(
            false,
            Some(terminal_id_owned.clone()),
            move |terminal| async move {
                let pane = pane_for_binding(terminal.as_ref(), &resolved).await?;
                match input {
                    AttachedInput::Text(text) => pane.send_text(text).await,
                    AttachedInput::Key(key) => pane.send_key(key).await,
                }
            },
            Some(Box::new(move |error| {
                mark_attached_input_failed(
                    &inner,
                    &terminal_id_owned,
                    &client_id_owned,
                    &subscriber_stop,
                    error,
                );
            })),
        )
        .map_err(operation_error_for_terminal)?;
        self.inner
            .sessions
            .lock()
            .expect("terminal index lock")
            .get_mut(terminal_id)
            .ok_or(TerminalErrorCode::TerminalNotFound)?
            .input_sequences
            .insert(client_id.to_string(), input_sequence);
        Ok(input_sequence)
    }

    /// Resizes the window that owns this terminal's pane with Berth's
    /// ordered-client ACK semantics.
    ///
    /// The window slot is resolved from the bound pane id on every resize, never
    /// from the slot captured by an earlier scan, so a window/pane renumbering
    /// cannot make the resize land on a neighboring window. Window geometry is
    /// the PTY geometry: an absolute *pane* size on a one-pane window only
    /// records a main-pane preference for a future split
    /// (`berth-term-engine` `explicit_main_width_set_on_a_single_pane_is_used_after_a_future_split`),
    /// which would leave the PTY at its previous size.
    pub fn resize_attached(
        &self,
        terminal_id: &str,
        client_id: &str,
        input_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSnapshot, TerminalOperationError> {
        let resolved = self
            .resolve_terminal(terminal_id)
            .map_err(operation_error_for_terminal)?;
        let (rows, cols) = clamp_grid(rows, cols);
        let size = TerminalSizeSpec::new(cols, rows);
        let terminal_id_owned = terminal_id.to_string();
        let backend = self.inner.backend_instance_id.clone();
        let (input_lock, _) = self.attached_input_context(terminal_id, client_id)?;
        let _input_guard = input_lock.lock().expect("terminal input lock");
        let accepted = {
            let sessions = self.inner.sessions.lock().expect("terminal index lock");
            let record = sessions
                .get(terminal_id)
                .ok_or(TerminalErrorCode::TerminalNotFound)?;
            if !record.subscribers.contains_key(client_id) {
                return Err(TerminalErrorCode::TerminalTransportDisconnected.into());
            }
            record.input_sequences.get(client_id).copied().unwrap_or(0)
        };
        if input_sequence <= accepted {
            return self
                .snapshot(terminal_id)
                .map_err(operation_error_for_terminal);
        }
        if input_sequence != accepted.saturating_add(1) {
            return Err(TerminalErrorCode::InputOutOfOrder.into());
        }

        // Keep the session index available to the output worker while Berth terminal
        // applies the geometry and captures the visible-only resize snapshot.
        let snapshot = self
            .execute(
                false,
                Some(terminal_id.to_string()),
                move |terminal| async move {
                    let pane = pane_for_binding(terminal.as_ref(), &resolved).await?;
                    if pane.is_generation_guarded() {
                        pane.resize_guarded_window(size).await?;
                        resize_snapshot_for_pane(&pane, terminal_id_owned, backend).await
                    } else {
                        // 无 epoch 的旧 daemon：沿用稳定 pane id 定位窗口。
                        let bound = bound_pane(terminal.as_ref(), &resolved).await?;
                        bound
                            .session
                            .window(bound.window_index())
                            .resize(Some(size.cols), Some(size.rows))
                            .await?;
                        resize_snapshot_for_pane(&bound.pane, terminal_id_owned, backend).await
                    }
                },
            )
            .map_err(operation_error_for_terminal)?;
        let mut sessions = self.inner.sessions.lock().expect("terminal index lock");
        let record = sessions
            .get_mut(terminal_id)
            .ok_or(TerminalErrorCode::TerminalNotFound)?;
        record.sequence = record.sequence.max(snapshot.sequence);
        record
            .input_sequences
            .insert(client_id.to_string(), input_sequence);
        Ok(snapshot)
    }

    /// Requests an adapter resync and stops the current output worker.
    pub fn request_client_resync(
        &self,
        terminal_id: &str,
        client_id: &str,
    ) -> Result<(), TerminalOperationError> {
        let sessions = self.inner.sessions.lock().expect("terminal index lock");
        let record = sessions
            .get(terminal_id)
            .ok_or(TerminalErrorCode::TerminalNotFound)?;
        let subscriber = record
            .subscribers
            .get(client_id)
            .ok_or(TerminalErrorCode::TerminalTransportDisconnected)?;
        let sequence = record.descriptor_sequence();
        subscriber
            .control_tx
            .send_replace(SubscriberControl::ResyncRequired { sequence });
        subscriber.stop.store(true, Ordering::Release);
        Ok(())
    }

    /// Returns the last accepted input sequence for a client.
    pub fn accepted_input_sequence(
        &self,
        terminal_id: &str,
        client_id: &str,
    ) -> Result<u64, TerminalOperationError> {
        let sessions = self.inner.sessions.lock().expect("terminal index lock");
        let record = sessions
            .get(terminal_id)
            .ok_or(TerminalErrorCode::TerminalNotFound)?;
        Ok(record.input_sequences.get(client_id).copied().unwrap_or(0))
    }
}

enum AttachedInput {
    Text(String),
    Key(String),
}

fn mark_attached_input_failed(
    inner: &Arc<TerminalSessionManagerInner>,
    terminal_id: &str,
    client_id: &str,
    expected_stop: &Arc<AtomicBool>,
    error: String,
) {
    let mut sessions = inner.sessions.lock().expect("terminal index lock");
    let Some(record) = sessions.get_mut(terminal_id) else {
        return;
    };
    let same_attachment = record
        .subscribers
        .get(client_id)
        .is_some_and(|subscriber| Arc::ptr_eq(&subscriber.stop, expected_stop));
    if !same_attachment {
        return;
    }
    let sequence = record.descriptor_sequence();
    let Some(subscriber) = record.subscribers.remove(client_id) else {
        return;
    };
    let _ = subscriber
        .control_tx
        .send_replace(SubscriberControl::ResyncRequired { sequence });
    subscriber.stop.store(true, Ordering::Release);
    tracing::warn!(
        terminal_id,
        client_id,
        error,
        "attached terminal input failed after enqueue; fenced attachment"
    );
}
