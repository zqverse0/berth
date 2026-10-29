#![deny(missing_docs)]

//! Local IPC boundary for Berth terminal.
//!
//! This crate owns endpoint naming and local transport handles. It deliberately
//! transports bytes only; the Berth terminal request/response protocol stays in
//! `berth-term-proto`.

mod endpoint;
mod listener;
mod stream;
#[cfg(windows)]
mod windows_mutex;

pub use endpoint::{
    default_endpoint, endpoint_for_label, resolve_endpoint, resolve_tmux_compatible_endpoint,
    LocalEndpoint,
};
pub use listener::LocalListener;
pub use stream::{
    connect_blocking, is_peer_disconnect, wait_for_peer_activity, wait_for_peer_close,
    BlockingLocalStream, LocalStream, PeerActivity, PeerIdentity,
};
#[cfg(windows)]
pub use windows_mutex::{
    acquire_named_mutex, NamedMutexAcquire, NamedMutexError, NamedMutexGuard, MAX_NAMED_MUTEX_LEN,
};
