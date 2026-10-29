//! Runtime pane binding resolution for live terminal operations.
//!
//! A terminal's pane is addressed by its captured [`RuntimeBinding`], never by
//! the slot it was first seen in. [`pane_for_binding`] is the single entry
//! point every operation path uses (attach, input, resize, snapshot): it
//! re-checks the captured binding against the daemon the operation runs on
//! through the SDK's pure [`verify`] judgement and only then hands out a pane
//! handle addressed by stable pane id.
//!
//! The judgement itself lives in the SDK so GUI and CLI share one
//! implementation. This module owns the adapter side of it: reading the live
//! epoch, mapping a rejected binding onto the deterministic
//! [`PaneBindingInvalid`](berth_term_sdk::berth::ProtocolError::PaneBindingInvalid)
//! protocol error, and refusing to re-resolve the slot. The protocol error is
//! mapped to
//! [`TerminalError::InstanceExpired`](crate::terminal::error::TerminalError::InstanceExpired)
//! in [`terminal_error_from_sdk`](super::terminal_manager::terminal_error_from_sdk).

use berth_term_sdk::berth::{
    verify, BindingFacts, BindingVerdict, Pane, PaneBindingFailure, ProtocolError, RuntimeBinding,
    Session, Terminal, TerminalError,
};

use super::lifecycle::ResolvedTerminal;

/// Returns the failure to surface for `verdict`, or `None` when the operation
/// may proceed.
///
/// Only a *disproved* binding is refused. `Unverifiable` — a daemon that
/// advertises no instance identity (an older daemon) — is degraded rather than
/// refused: the captured pane id is still the pane this terminal was bound to,
/// and the daemon decides existence when the operation addresses it. Refusing
/// it would make every terminal unusable whenever a newer client is talking to
/// an older daemon, which is a mix that must stay workable.
fn refused_failure(verdict: BindingVerdict) -> Option<PaneBindingFailure> {
    verdict.failure().filter(|_| !verdict.allows_pane_address())
}

/// Re-checks the captured binding against the daemon the operation runs on.
///
/// `Ok(())` means the operation may address the captured pane id. The daemon
/// instance (epoch) is read from the SDK's already-negotiated handshake
/// capabilities, so the check adds no round trip.
async fn verify_binding(
    terminal: &Terminal,
    binding: &RuntimeBinding,
) -> Result<(), TerminalError> {
    let verdict = match terminal.daemon_instance().await? {
        Some(daemon_instance) => verify(
            binding,
            BindingFacts::DaemonObserved {
                daemon_instance: &daemon_instance,
            },
        ),
        None => verify(binding, BindingFacts::DaemonUnverifiable),
    };
    if let Some(failure) = refused_failure(verdict) {
        return Err(binding_failure_error(binding, failure));
    }
    if !verdict.is_valid() {
        // 旧 daemon 不携带实例身份：身份无法确认，但 pane id 仍是可寻址实体，
        // 存在性由 daemon 在操作上判定（缺失即 PaneNotFound），不回落槽位。
        tracing::debug!(
            session = binding.session.as_str(),
            pane_id = binding.pane_id.as_u32(),
            "daemon advertises no instance identity; addressing the captured pane id"
        );
    }
    Ok(())
}

/// Returns the pane handle for `resolved` after re-checking its binding.
///
/// The pane itself is addressed by stable pane id and the daemon decides
/// existence on the operation, which keeps the check off the pane-resolution
/// path: no `list-panes` round trip is added.
pub(super) async fn pane_for_binding(
    terminal: &Terminal,
    resolved: &ResolvedTerminal,
) -> Result<Pane, TerminalError> {
    let binding = &resolved.binding;
    verify_binding(terminal, binding).await?;

    terminal
        .session(binding.session.clone())
        .await?
        .pane_handle_by_id(
            binding.pane_id,
            resolved.target.window_index,
            resolved.target.pane_index,
        )
        .guard_generation_if_supported(binding.generation)
        .await
}

/// A verified binding resolved against the live daemon.
///
/// Unlike [`pane_for_binding`], the pane id is resolved eagerly: that costs one
/// `list-panes` round trip but returns the pane's **current** window slot,
/// which window-level operations need. Window geometry is a window property,
/// and the slot captured by an earlier scan may have been renumbered since.
pub(super) struct BoundPane {
    /// Session the bound pane belongs to.
    pub(super) session: Session,
    /// Pane handle addressed by stable pane id.
    pub(super) pane: Pane,
}

impl BoundPane {
    /// Window slot the pane occupies right now, as the daemon reports it.
    pub(super) fn window_index(&self) -> u32 {
        self.pane.target().window_index
    }
}

/// Resolves `resolved` eagerly for window-level operations such as resize.
pub(super) async fn bound_pane(
    terminal: &Terminal,
    resolved: &ResolvedTerminal,
) -> Result<BoundPane, TerminalError> {
    let binding = &resolved.binding;
    verify_binding(terminal, binding).await?;
    let session = terminal.session(binding.session.clone()).await?;
    // Deferred failure: the pane id must still resolve in the daemon, which is
    // also what proves the terminal is alive before a window operation.
    let pane = session.pane_by_id(binding.pane_id).await?;
    Ok(BoundPane { session, pane })
}

/// Builds the deterministic failure for a binding that no longer matches.
///
/// `resolved.target` is deliberately not consulted: a reused slot is what the
/// check exists to reject, so re-resolving it would hand the caller a different
/// process under the old identity.
fn binding_failure_error(binding: &RuntimeBinding, failure: PaneBindingFailure) -> TerminalError {
    tracing::warn!(
        session = binding.session.as_str(),
        pane_id = binding.pane_id.as_u32(),
        reason = %failure,
        "terminal pane binding is no longer valid"
    );
    TerminalError::protocol(ProtocolError::pane_binding_invalid(failure))
}

#[cfg(test)]
#[path = "binding_tests.rs"]
mod tests;
