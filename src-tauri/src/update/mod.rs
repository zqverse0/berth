//! Desktop (Tauri) self-update state, shared between the platform updater
//! (`tauri-plugin-updater`) and the frontend snapshot/event surface.
//!
//! The standalone-server in-place updater (install/verify/version modules,
//! the `--supervise` supervisor, and the on-disk `web/` swap) was retired with
//! the `berth-server` binary — see docs/REMOVED.md. Desktop builds self-update
//! through `tauri-plugin-updater`.

pub mod runtime;
pub mod state;

pub use runtime::UpdateCapability;
pub use state::{new_handle as new_update_state_handle, AppUpdateState, AppUpdateStateHandle};
