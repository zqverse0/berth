use super::{
    after_hook_format_values, AccessMode, RequestHandler, ServerAccessStore, DEFAULT_SESSION_SIZE,
};
use crate::control::ControlModeUpgrade;
use crate::daemon::ShutdownHandle;
use crate::pane_io::AttachControl;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use berth_term_engine::{
    command_parser::parse_command_string, PaneGeometry, WINDOW_ALERTFLAGS, WINLINK_ALERTFLAGS,
};
use berth_term_ipc::PeerIdentity;
use berth_term_os::identity::UserIdentity;
use berth_term_proto::{
    ControlMode, DisplayMessageRequest, ErrorResponse, HasSessionRequest, HookName,
    KillPaneRequest, KillSessionRequest, LayoutName, ListPanesRequest, ListSessionsRequest,
    NewSessionExtRequest, NewSessionRequest, OptionName, PaneTarget, RenameSessionRequest, Request,
    ResizePaneAdjustment, ResizePaneTargetActionRequest, Response, ScopeSelector,
    SelectPaneRequest, SessionName, SetOptionMode, SetOptionRequest, SplitWindowRequest,
    SplitWindowTarget, SplitWindowTargetActionRequest, Target, TerminalError, TerminalSize,
};
use tokio::sync::mpsc;

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

#[path = "handler_tests/new_session.rs"]
mod new_session;

#[path = "handler_tests/kill_session.rs"]
mod kill_session;

#[path = "handler_tests/session_leases.rs"]
mod session_leases;

#[path = "handler_tests/clients.rs"]
mod clients;

#[path = "handler_tests/panes.rs"]
mod panes;

#[path = "handler_tests/split_before.rs"]
mod split_before;

#[path = "handler_tests/rename_session.rs"]
mod rename_session;

#[path = "handler_tests/lists_and_hooks.rs"]
mod lists_and_hooks;

#[path = "handler_send_keys_tests.rs"]
mod send_keys_tests;

#[path = "handler_copy_mode_tests.rs"]
mod copy_mode_tests;

#[path = "handler_overlay_tests.rs"]
mod overlay_tests;

#[tokio::test]
async fn handshake_advertises_a_distinct_daemon_instance_epoch_per_handler() {
    let first = RequestHandler::new();
    let second = RequestHandler::new();

    let first_epoch = handshake_epoch(&first).await;
    let second_epoch = handshake_epoch(&second).await;

    assert_eq!(
        first_epoch.len(),
        berth_term_proto::DAEMON_INSTANCE_TOKEN_HEX_LEN
    );
    assert!(first_epoch.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(
        first_epoch, second_epoch,
        "a restarted daemon must advertise a new instance epoch"
    );
}

async fn handshake_epoch(handler: &RequestHandler) -> String {
    let response = handler
        .handle(Request::Handshake(
            berth_term_proto::HandshakeRequest::current(),
        ))
        .await;
    match response {
        Response::Handshake(response) => {
            berth_term_proto::daemon_instance_from_capabilities(&response.capabilities)
                .expect("new daemon must advertise its instance epoch")
                .to_owned()
        }
        response => panic!("expected handshake response, got {response:?}"),
    }
}


#[test]
fn access_mode_for_peer_uses_user_identity_not_pid() {
    let owner = UserIdentity::Sid("S-1-5-21-1000".into());
    let handler = RequestHandler::new();
    *handler
        .server_access
        .lock()
        .expect("server access mutex must not be poisoned") =
        ServerAccessStore::new_for_identity(0, owner.clone());

    let owner_peer = PeerIdentity {
        pid: 4242,
        uid: 0,
        user: owner,
    };
    let untrusted_peer_with_reused_pid = PeerIdentity {
        pid: owner_peer.pid,
        uid: 0,
        user: UserIdentity::Sid("S-1-5-21-2000".into()),
    };

    assert_eq!(
        handler.access_mode_for_peer(&owner_peer),
        Some(AccessMode::ReadWrite)
    );
    assert_eq!(
        handler.access_mode_for_peer(&untrusted_peer_with_reused_pid),
        None
    );
}
