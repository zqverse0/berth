//! Runtime pane bindings and their deterministic verification.
//!
//! A binding is the inner identity of a live terminal pane: the daemon instance
//! (epoch) it was captured from, its session, its stable pane id and the pane
//! process generation. Slot indices (`window_index` / `pane_index`) are only a
//! first resolution hint — the daemon renumbers them while pane ids stay put —
//! so every captured binding is re-checked before it is used again.
//!
//! [`verify`] is the single judgement shared by the Tauri adapter and the CLI.
//! It is a pure function of the binding and the observed facts: no I/O, no
//! clock, no randomness, and no active-pane guessing. Unknown identity is
//! [`BindingVerdict::Unverifiable`], never "probably fine".

use berth_term_proto::PaneBindingFailure;

use crate::types::{PaneId, SessionName};

/// Identity of one live pane, captured by a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeBinding {
    /// Daemon instance (epoch) the binding was captured from.
    ///
    /// `None` 表示捕获时 daemon 未提供 epoch。只有当前 daemon 也不提供 epoch
    /// 才允许 [`BindingVerdict::Unverifiable`] 降级；现代 daemon 必须拒绝此旧绑定。
    pub daemon_instance: Option<String>,
    /// Session that owns the pane.
    pub session: SessionName,
    /// Stable pane id, unaffected by window/pane index renumbering.
    pub pane_id: PaneId,
    /// Pane process generation at capture time.
    pub generation: u64,
}

impl RuntimeBinding {
    /// Creates a binding from an observed daemon instance and pane.
    #[must_use]
    pub fn new(
        daemon_instance: Option<String>,
        session: SessionName,
        pane_id: PaneId,
        generation: u64,
    ) -> Self {
        Self {
            daemon_instance,
            session,
            pane_id,
            generation,
        }
    }
}

/// Facts observed while re-checking a binding.
///
/// [`BindingFacts::DaemonUnverifiable`] is the honest answer for a daemon that
/// advertises no instance identity (an older daemon); it never means "assume
/// the daemon is unchanged". `generation: None` is the same honesty for a hot
/// path that confirmed the pane id without paying for a pane info round trip:
/// the generation check is skipped rather than fed a fabricated value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingFacts<'a> {
    /// The live daemon advertised its instance identity and the pane was looked up.
    Observed {
        /// Daemon instance advertised by the live handshake.
        daemon_instance: &'a str,
        /// Whether the bound pane id still exists in the session.
        pane_present: bool,
        /// Current pane process generation, when the caller observed it.
        generation: Option<u64>,
    },
    /// The live daemon advertised its instance identity, but the pane itself was
    /// not probed.
    ///
    /// Used by hot paths that must not pay a resolution round trip before the
    /// operation: input, resize and snapshot address the pane through the
    /// daemon's stable pane-id targeting, so the daemon decides existence and
    /// reports a missing pane on the operation itself. Only the epoch is
    /// confirmed here; passing an unprobed `pane_present: true` would be a
    /// fabricated fact.
    DaemonObserved {
        /// Daemon instance advertised by the live handshake.
        daemon_instance: &'a str,
    },
    /// The live daemon advertised no instance identity.
    DaemonUnverifiable,
}

/// Deterministic result of re-checking a captured binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingVerdict {
    /// The binding still addresses the same live pane process.
    Valid,
    /// 当前 daemon 提供 epoch，但捕获的 epoch 缺失或不匹配，不能安全复用绑定。
    StaleDaemon,
    /// The bound pane no longer exists.
    StalePane,
    /// The pane exists but its process generation changed (respawn).
    StaleGeneration,
    /// No daemon instance identity is available, so the binding cannot be confirmed.
    Unverifiable,
}

impl BindingVerdict {
    /// Returns `true` when the binding may be used without re-resolution.
    #[must_use]
    pub const fn is_valid(self) -> bool {
        matches!(self, Self::Valid)
    }

    /// Whether the captured pane id may still be addressed as this terminal's
    /// pane.
    ///
    /// An observed epoch conflict
    /// ([`StaleDaemon`](Self::StaleDaemon)) and a disproved pane
    /// ([`StalePane`](Self::StalePane) / [`StaleGeneration`](Self::StaleGeneration))
    /// must never be addressed. [`Unverifiable`](Self::Unverifiable) may: it
    /// means the live daemon advertises no instance identity (an older daemon),
    /// so the captured identity can be neither confirmed nor disproved. The
    /// captured pane id is still that daemon's stable pane identity within its
    /// own lifetime, so addressing it is correct as long as the daemon is the
    /// one the binding came from — and the daemon itself decides existence,
    /// reporting a missing pane on the operation instead of retargeting a slot.
    ///
    /// The trade-off is deliberate and documented: an older daemon cannot be
    /// distinguished across its own restart (that is exactly why the daemon
    /// instance entry exists), but mixing a newer client with an older daemon
    /// must not make terminals unusable. Callers that need a hard guarantee
    /// read [`Self::is_valid`] instead.
    #[must_use]
    pub const fn allows_pane_address(self) -> bool {
        matches!(self, Self::Valid | Self::Unverifiable)
    }

    /// Returns the stable failure code for this verdict, or `None` when valid.
    #[must_use]
    pub const fn failure(self) -> Option<PaneBindingFailure> {
        match self {
            Self::Valid => None,
            Self::StaleDaemon => Some(PaneBindingFailure::StaleDaemon),
            Self::StalePane => Some(PaneBindingFailure::StalePane),
            Self::StaleGeneration => Some(PaneBindingFailure::StaleGeneration),
            Self::Unverifiable => Some(PaneBindingFailure::Unverifiable),
        }
    }
}

/// Re-checks `binding` against `facts`.
///
/// Judgement order is fixed: the daemon instance decides first, because after a
/// restart every pane-level observation (session, pane id, generation) can be
/// reused by the new daemon. A caller that fails this check must surface the
/// verdict instead of re-resolving the captured slot.
#[must_use]
pub fn verify(binding: &RuntimeBinding, facts: BindingFacts<'_>) -> BindingVerdict {
    let daemon_instance = match facts {
        BindingFacts::Observed {
            daemon_instance, ..
        }
        | BindingFacts::DaemonObserved { daemon_instance } => daemon_instance,
        BindingFacts::DaemonUnverifiable => return BindingVerdict::Unverifiable,
    };

    // 当前 daemon 已提供 epoch，缺失的旧 epoch 不能借用同值 pane 身份。
    // 只有对端本身不提供 epoch 时，才走上方的旧 daemon 兼容降级。
    let Some(captured_instance) = binding.daemon_instance.as_deref() else {
        return BindingVerdict::StaleDaemon;
    };
    if daemon_instance != captured_instance {
        return BindingVerdict::StaleDaemon;
    }

    let BindingFacts::Observed {
        pane_present,
        generation,
        ..
    } = facts
    else {
        // The pane was not probed: the operation addresses it by stable pane id
        // and the daemon decides existence. Epoch alone is confirmed here.
        return BindingVerdict::Valid;
    };
    if !pane_present {
        return BindingVerdict::StalePane;
    }
    // `None` means the caller confirmed the pane id without observing its
    // generation (no pane info round trip): skip the generation check instead
    // of comparing against a fabricated value.
    if let Some(generation) = generation {
        if generation != binding.generation {
            return BindingVerdict::StaleGeneration;
        }
    }

    BindingVerdict::Valid
}

#[cfg(test)]
#[path = "binding_tests.rs"]
mod tests;
