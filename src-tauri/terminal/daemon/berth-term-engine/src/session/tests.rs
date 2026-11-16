use std::collections::BTreeSet;

use super::{PaneSwapOptions, Session, SessionPaneTarget, SessionStore};
use crate::{PaneGeometry, PaneId};
use berth_term_proto::{
    LayoutName, ResizePaneAdjustment, SessionName, SplitDirection, TerminalError, TerminalSize,
};

#[path = "window_tests.rs"]
mod window_tests;
fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

#[path = "tests/pane_basics.rs"]
mod pane_basics;

#[path = "tests/pane_layout_resize.rs"]
mod pane_layout_resize;

#[path = "tests/pane_transfer.rs"]
mod pane_transfer;

#[path = "tests/store_sessions.rs"]
mod store_sessions;

#[path = "tests/pane_transfer_edge_cases.rs"]
mod pane_transfer_edge_cases;
