//! Daemon-backed pane handle.
//!
//! A pane handle can address either an index slot or a stable [`PaneId`].
//! Slot handles preserve existing tmux-like `(session, window, pane)` behavior;
//! stable handles use by-id daemon routes where available and otherwise resolve
//! the id against the daemon's current view before issuing the request.

use std::fmt;
#[cfg(feature = "available")]
use std::path::PathBuf;
use std::time::Duration;

#[cfg(feature = "available")]
use crate::events::render::PaneRenderStream;
#[cfg(feature = "available")]
use crate::events::streams::PaneLineStream;
use crate::events::streams::{PaneOutputStart, PaneOutputStream};
#[cfg(feature = "available")]
use crate::handles::split::SplitDirection;
use crate::transport::TransportClient;
#[cfg(feature = "available")]
use crate::{
    ArmedWait, CollectedPaneOutput, PaneExitState, PaneTextMatch, ProcessSpec,
    VisibleTextExpectation,
};
use crate::{
    InfoSnapshot, PaneId, PaneRef, PaneSnapshot, Result, TerminalEndpoint, TerminalError,
    TerminalSizeSpec,
};
use berth_term_proto::PaneBindingFailure;

#[path = "pane/capture_pane.rs"]
mod capture_pane;
#[path = "pane/info.rs"]
mod info;
#[path = "pane/input.rs"]
mod input;
#[path = "pane/lifecycle.rs"]
mod lifecycle;
#[path = "pane/snapshot.rs"]
mod snapshot;
#[cfg(feature = "available")]
#[path = "pane/spawn.rs"]
mod spawn;
#[cfg(feature = "available")]
#[path = "pane/split.rs"]
mod split;
#[cfg(feature = "available")]
#[path = "pane/split_builder.rs"]
mod split_builder;
#[path = "pane/target.rs"]
mod target;
#[path = "pane/title.rs"]
mod title;

pub use capture_pane::{PaneCapture, PaneCaptureBuilder};
use info::{current_pane_entry, current_pane_ref_for_id, pane_info_snapshot};
#[cfg(feature = "available")]
pub(crate) use info::{pane_info_snapshot_with_parents, session_info_snapshot};
#[cfg(feature = "available")]
use input::{cancel_copy_mode, scroll_history};
use input::{resize_to_size, send_key, send_text};
use lifecycle::close_pane;
#[cfg(feature = "available")]
use lifecycle::respawn_pane;
use snapshot::pane_snapshot;
#[cfg(feature = "available")]
pub use spawn::PaneSpawnBuilder;
#[cfg(feature = "available")]
use split::split_pane;
#[cfg(feature = "available")]
pub use split_builder::PaneSplitBuilder;
#[cfg(feature = "available")]
pub(crate) use target::is_already_closed_pane_error;
use title::{display_format, get_title, set_title};

pub(crate) async fn resolve_pane_ref_for_id(
    transport: &TransportClient,
    session_name: &berth_term_proto::SessionName,
    pane_id: PaneId,
) -> Result<Option<PaneRef>> {
    current_pane_ref_for_id(transport, session_name, pane_id).await
}

/// Result of consuming a [`Pane`] handle with [`Pane::close`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum PaneCloseOutcome {
    /// The daemon killed the addressed pane.
    Closed {
        /// The pane target consumed by the close call.
        target: PaneRef,
        /// Whether the pane removal also destroyed its window.
        window_destroyed: bool,
    },
    /// The addressed pane was already absent by the time close ran.
    AlreadyClosed {
        /// The stale target consumed by the close call.
        target: PaneRef,
    },
}

/// Process and policy fields for [`Pane::respawn`].
#[cfg(feature = "available")]
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PaneRespawnOptions {
    /// Whether a running pane should be killed before respawning.
    pub kill: bool,
    /// Optional working-directory override for the new process.
    pub start_directory: Option<PathBuf>,
    /// Process argv and per-spawn environment overrides.
    pub process: ProcessSpec,
    /// Optional keep-dead-pane policy applied before respawn.
    pub keep_alive_on_exit: Option<bool>,
}

/// Opaque handle for one daemon pane slot.
///
/// A pane handle addresses a `(session, window, pane)` triple rather than
/// caching a `PaneId`. Every operation resolves that slot against the
/// daemon's current state, so:
///
/// * linked windows and grouped sessions keep returning the same stable
///   `%N` identity through every sibling view, and
/// * stale handles for an already-closed pane resolve to typed
///   `None`/empty results — never to a panic and never to a `PaneId` from
///   a prior epoch.
///
/// The handle deliberately exposes no `current_revision()` accessor.
/// Revision values are only observable through
/// [`PaneSnapshot::revision`] on a freshly captured snapshot, or through
/// the revision-carrying [`PaneEvent`](crate::PaneEvent) variants emitted
/// over a control-mode subscription.
#[derive(Clone)]
pub struct Pane {
    target: PaneRef,
    stable_id: Option<PaneId>,
    generation_guard: Option<u64>,
    endpoint: TerminalEndpoint,
    default_timeout: Option<Duration>,
    transport: TransportClient,
}

impl Pane {
    pub(crate) fn new(
        target: PaneRef,
        endpoint: TerminalEndpoint,
        default_timeout: Option<Duration>,
        transport: TransportClient,
    ) -> Self {
        Self {
            target,
            stable_id: None,
            generation_guard: None,
            endpoint,
            default_timeout,
            transport,
        }
    }

    pub(crate) fn new_by_id(
        target: PaneRef,
        pane_id: PaneId,
        endpoint: TerminalEndpoint,
        default_timeout: Option<Duration>,
        transport: TransportClient,
    ) -> Self {
        Self {
            target,
            stable_id: Some(pane_id),
            generation_guard: None,
            endpoint,
            default_timeout,
            transport,
        }
    }

    /// Returns the exact protocol-owned pane target addressed by this
    /// handle.
    #[must_use]
    pub const fn target(&self) -> &PaneRef {
        &self.target
    }

    /// Returns the endpoint that was resolved when this handle was created.
    #[must_use]
    pub const fn endpoint(&self) -> &TerminalEndpoint {
        &self.endpoint
    }

    /// Returns the default timeout configured on the parent facade.
    #[must_use]
    pub const fn configured_default_timeout(&self) -> Option<Duration> {
        self.default_timeout
    }

    pub(crate) const fn transport(&self) -> &TransportClient {
        &self.transport
    }

    /// 将已捕获的进程代际绑定到稳定 pane id。无 epoch 的旧 daemon 降级按 pane id
    /// 寻址；有 epoch 却无原子守卫能力时明确拒绝，绝不静默丢弃代际。
    pub async fn guard_generation_if_supported(mut self, generation: u64) -> Result<Self> {
        if self.stable_id.is_some() {
            let capabilities =
                crate::capabilities::negotiated_capabilities(&self.transport).await?;
            if berth_term_proto::daemon_instance_from_capabilities(&capabilities).is_some() {
                let guard_capability = berth_term_proto::CAPABILITY_SDK_PANE_GENERATION_GUARD;
                if !capabilities
                    .iter()
                    .any(|capability| capability == guard_capability)
                {
                    return Err(TerminalError::unsupported(
                        guard_capability,
                        "upgrade and restart the berth daemon to enable pane generation guards",
                    ));
                }
                self.generation_guard = Some(generation);
            }
        }
        Ok(self)
    }

    /// 当前 handle 是否经过 daemon 代际守卫能力协商。
    #[must_use]
    pub const fn is_generation_guarded(&self) -> bool {
        self.generation_guard.is_some()
    }

    pub(crate) fn proto_target_ref(&self) -> berth_term_proto::PaneTargetRef {
        match (self.stable_id, self.generation_guard) {
            (Some(pane_id), Some(generation)) => berth_term_proto::PaneTargetRef::guarded_by_id(
                self.target.session_name.clone(),
                pane_id,
                generation,
            ),
            (Some(pane_id), None) => {
                berth_term_proto::PaneTargetRef::by_id(self.target.session_name.clone(), pane_id)
            }
            (None, _) => berth_term_proto::PaneTargetRef::slot(self.target.to_proto()),
        }
    }

    #[cfg(feature = "available")]
    pub(crate) const fn is_stable_id(&self) -> bool {
        self.stable_id.is_some()
    }

    pub(crate) async fn current_target(&self) -> Result<PaneRef> {
        if self.is_generation_guarded() {
            return Err(TerminalError::unsupported(
                "pane.slot_target",
                "this operation cannot atomically guard the pane generation",
            ));
        }
        let Some(pane_id) = self.stable_id else {
            return Ok(self.target.clone());
        };
        current_pane_ref_for_id(&self.transport, &self.target.session_name, pane_id)
            .await?
            .ok_or_else(|| TerminalError::pane_not_found(self.target.session_name.clone(), pane_id))
    }

    fn verify_info_snapshot(&self, info: &InfoSnapshot) -> Result<()> {
        let (Some(pane_id), Some(generation)) = (self.stable_id, self.generation_guard) else {
            return Ok(());
        };
        let failure = match info.panes.first() {
            Some(pane) if pane.id == pane_id && pane.generation == generation => return Ok(()),
            Some(pane) if pane.id == pane_id => PaneBindingFailure::StaleGeneration,
            _ => PaneBindingFailure::StalePane,
        };
        Err(TerminalError::protocol(
            berth_term_proto::TerminalError::pane_binding_invalid(failure),
        ))
    }
}

#[cfg(feature = "available")]
#[path = "../available/pane/automation.rs"]
mod available_automation;
#[cfg(feature = "available")]
#[path = "../available/pane/control.rs"]
mod available_control;
#[path = "pane/berth.rs"]
mod berth_api;

impl fmt::Debug for Pane {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Pane")
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
#[path = "pane/tests.rs"]
mod tests;
