//! Opaque SDK facade and daemon-backed session handles.
//!
//! Constructing facade builders records caller intent without resolving
//! endpoints. Session handles are returned only after a daemon operation has
//! created or reused a live session.

mod builder;
#[cfg(feature = "available")]
mod owned_session;
mod pane;
pub(crate) mod session;
#[cfg(feature = "available")]
mod split;
mod terminal;
mod window;

pub use builder::TerminalClientBuilder;
#[cfg(feature = "available")]
pub use owned_session::{
    CleanupPolicy, LeaseState, OwnedSession, OwnedSessionBuilder, OwnedSessionSignalHandlers,
};
#[cfg(feature = "available")]
pub(crate) use pane::{
    is_already_closed_pane_error, pane_info_snapshot_with_parents, session_info_snapshot,
};
pub use pane::{Pane, PaneCapture, PaneCaptureBuilder, PaneCloseOutcome};
#[cfg(feature = "available")]
pub use pane::{PaneRespawnOptions, PaneSpawnBuilder, PaneSplitBuilder};
pub use session::Session;
#[cfg(feature = "available")]
pub use split::SplitDirection;
#[cfg(feature = "available")]
pub(crate) use terminal::connect_transport_to_endpoint;
pub use terminal::Terminal;
pub(crate) use window::list_window_entries_for_session;
pub use window::{ListedWindowEntry, NewWindowBuilder, Window, WindowCloseOutcome, WindowPane};

#[allow(dead_code)]
fn assert_static_facade_contract<T: Send + Sync + 'static>() {
    let _ = std::marker::PhantomData::<T>;
}

const _: fn() = assert_static_facade_contract::<Terminal>;
const _: fn() = assert_static_facade_contract::<TerminalClientBuilder>;
const _: fn() = assert_static_facade_contract::<Session>;
const _: fn() = assert_static_facade_contract::<Window>;
const _: fn() = assert_static_facade_contract::<Pane>;
