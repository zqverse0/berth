//! Berth's single terminal runtime authority.
//!
//! The implementation lives in [`terminal_manager`]. This module remains the
//! stable import path used by Tauri commands and application state. The old
//! native-PTY manager and web/WebSocket forwarders are no longer in the build.

#[path = "attach.rs"]
mod attach;
#[path = "attach_io.rs"]
mod attach_io;
#[path = "binding.rs"]
mod binding;
#[path = "lifecycle.rs"]
mod lifecycle;
#[path = "model.rs"]
mod model;
#[path = "remote.rs"]
mod remote;
#[path = "runtime.rs"]
pub(crate) mod runtime;
#[path = "snapshot.rs"]
mod snapshot;
#[path = "stream.rs"]
mod stream;
#[path = "terminal_manager.rs"]
mod terminal_manager;
#[path = "validation.rs"]
mod validation;

pub use model::{
    CreateTerminalRequest, TerminalAgentSignal, TerminalDescriptor, TerminalLimits,
    TerminalOperationError, TerminalOwnership,
};
pub use terminal_manager::*;
pub use validation::resolve_shell;
