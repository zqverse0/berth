use std::collections::BTreeMap;

use berth_term_os::identity::{IdentityResolver, UserIdentity};
use berth_term_proto::request::{AttachSessionExt2Request, AttachSessionExt3Request};
use berth_term_proto::{AttachSessionExtRequest, Request, SessionName, Target, TerminalError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessMode {
    ReadWrite,
}

impl AccessMode {
    #[must_use]
    pub(crate) const fn can_write(self) -> bool {
        matches!(self, Self::ReadWrite)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerAccessStore {
    owner_uid: u32,
    owner_identity: UserIdentity,
    entries: BTreeMap<UserIdentity, AccessMode>,
}

impl ServerAccessStore {
    #[must_use]
    pub(crate) fn new(owner_uid: u32) -> Self {
        let owner_identity = current_user_identity().unwrap_or(UserIdentity::Uid(owner_uid));
        Self::new_for_identity(owner_uid, owner_identity)
    }

    #[must_use]
    pub(crate) fn new_for_identity(owner_uid: u32, owner_identity: UserIdentity) -> Self {
        let mut entries = BTreeMap::new();
        insert_platform_superuser_access(&mut entries);
        entries.insert(owner_identity.clone(), AccessMode::ReadWrite);
        Self {
            owner_uid,
            owner_identity,
            entries,
        }
    }

    #[must_use]
    pub(crate) fn mode_for_identity(&self, identity: &UserIdentity) -> Option<AccessMode> {
        self.entries.get(identity).copied()
    }
}

#[cfg(unix)]
fn insert_platform_superuser_access(entries: &mut BTreeMap<UserIdentity, AccessMode>) {
    entries.insert(UserIdentity::Uid(0), AccessMode::ReadWrite);
}

#[cfg(windows)]
fn insert_platform_superuser_access(_entries: &mut BTreeMap<UserIdentity, AccessMode>) {}

pub(crate) fn current_owner_uid() -> u32 {
    current_user_identity()
        .ok()
        .and_then(|identity| match identity {
            UserIdentity::Uid(uid) => Some(uid),
            UserIdentity::Sid(_) => None,
        })
        .unwrap_or(0)
}

fn current_user_identity() -> std::io::Result<UserIdentity> {
    IdentityResolver::current()
}

#[must_use]
pub(crate) fn user_name_for_uid(uid: u32) -> String {
    #[cfg(unix)]
    {
        IdentityResolver::unix_user_by_uid(uid)
            .ok()
            .flatten()
            .map(|entry| entry.name)
            .unwrap_or_else(|| uid.to_string())
    }

    #[cfg(windows)]
    {
        uid.to_string()
    }
}

pub(crate) fn apply_access_policy(
    request: Request,
    can_write: bool,
) -> Result<Request, TerminalError> {
    if can_write {
        return Ok(request);
    }

    match request {
        Request::AttachSession(request) => Ok(Request::AttachSessionExt(AttachSessionExtRequest {
            target: Some(request.target),
            detach_other_clients: false,
            kill_other_clients: false,
            read_only: true,
            skip_environment_update: true,
            flags: None,
        })),
        Request::AttachSessionExt(request) => Ok(Request::AttachSessionExt(
            sanitize_read_only_attach_session_ext(request),
        )),
        Request::AttachSessionExt2(request) => Ok(Request::AttachSessionExt2(Box::new(
            sanitize_read_only_attach_session_ext2(*request),
        ))),
        Request::AttachSessionExt3(request) => Ok(Request::AttachSessionExt3(Box::new(
            sanitize_read_only_attach_session_ext3(*request),
        ))),
        request if read_only_request_allowed(&request) => Ok(request),
        _ => Err(TerminalError::Server("client is read-only".to_owned())),
    }
}

fn sanitize_read_only_attach_session_ext(
    mut request: AttachSessionExtRequest,
) -> AttachSessionExtRequest {
    request.detach_other_clients = false;
    request.kill_other_clients = false;
    request.read_only = true;
    request.skip_environment_update = true;
    request
}

fn sanitize_read_only_attach_session_ext2(
    mut request: AttachSessionExt2Request,
) -> AttachSessionExt2Request {
    request.target = read_only_attach_target(request.target, request.target_spec.as_deref());
    request.target_spec = None;
    request.detach_other_clients = false;
    request.kill_other_clients = false;
    request.read_only = true;
    request.skip_environment_update = true;
    request.working_directory = None;
    request.client_size = None;
    request
}

fn sanitize_read_only_attach_session_ext3(
    mut request: AttachSessionExt3Request,
) -> AttachSessionExt3Request {
    request.target = read_only_attach_target(request.target, request.target_spec.as_deref());
    request.target_spec = None;
    request.detach_other_clients = false;
    request.kill_other_clients = false;
    request.read_only = true;
    request.skip_environment_update = true;
    request.working_directory = None;
    request.client_size = None;
    request
}

fn read_only_attach_target(
    target: Option<SessionName>,
    target_spec: Option<&str>,
) -> Option<SessionName> {
    target.or_else(|| {
        target_spec
            .and_then(|spec| Target::parse(spec).ok())
            .map(|target| target.session_name().clone())
    })
}

fn read_only_request_allowed(request: &Request) -> bool {
    match request {
        Request::CapturePane(request) => {
            capture_pane_request_is_read_only(request.print, request.buffer_name.as_deref())
        }
        Request::CapturePaneRef(request) => capture_pane_request_is_read_only(
            request.capture.print,
            request.capture.buffer_name.as_deref(),
        ),
        Request::CapturePaneTargetAction(request) => {
            capture_pane_request_is_read_only(request.print, request.buffer_name.as_deref())
        }
        Request::DisplayMessage(request) => display_message_request_is_read_only(request.print),
        Request::DisplayMessageExt(request) => display_message_request_is_read_only(request.print),
        _ => matches!(
            request,
            Request::HasSession(_)
                | Request::ListWindows(_)
                | Request::ListPanes(_)
                | Request::AttachSession(_)
                | Request::AttachSessionExt(_)
                | Request::AttachSessionExt2(_)
                | Request::AttachSessionExt3(_)
                | Request::ShowOptions(_)
                | Request::ShowBuffer(_)
                | Request::SubscribePaneOutput(_)
                | Request::SubscribePaneOutputRef(_)
                | Request::UnsubscribePaneOutput(_)
                | Request::PaneOutputCursor(_)
                | Request::PaneOutputCursorWait(_)
                | Request::PaneSnapshot(_)
                | Request::PaneSnapshotRef(_)
                | Request::ResolveTarget(_)
                | Request::SdkWaitForOutput(_)
                | Request::SdkWaitForOutputRef(_)
                | Request::CancelSdkWait(_)
                | Request::ListSessions(_)
                | Request::Handshake(_)
        ),
    }
}

fn capture_pane_request_is_read_only(print: bool, buffer_name: Option<&str>) -> bool {
    print && buffer_name.is_none()
}

fn display_message_request_is_read_only(print: bool) -> bool {
    print
}

#[cfg(test)]
mod tests {
    use super::*;
    use berth_term_proto::{
        AttachSessionExt2Request, AttachSessionExt3Request, AttachSessionExtRequest,
        AttachSessionRequest, CancelSdkWaitRequest, CapturePaneRequest,
        CapturePaneTargetActionRequest, DisplayMessageExtRequest, DisplayMessageRequest,
        PaneOutputSubscriptionStart, PaneSnapshotRequest, PaneTarget, ResolveTargetRequest,
        ResolveTargetType, SdkWaitForOutputRequest, SdkWaitId, SdkWaitOwnerId, SessionName,
        TerminalSize,
    };

    #[test]
    fn access_store_can_key_owner_by_windows_sid() {
        let owner = UserIdentity::Sid("S-1-5-21-1000".into());
        let store = ServerAccessStore::new_for_identity(0, owner.clone());

        assert_eq!(store.mode_for_identity(&owner), Some(AccessMode::ReadWrite));
        assert_eq!(
            store.mode_for_identity(&UserIdentity::Sid("S-1-5-21-2000".into())),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn access_store_does_not_trust_uid_zero_on_windows() {
        let owner = UserIdentity::Sid("S-1-5-21-1000".into());
        let store = ServerAccessStore::new_for_identity(0, owner.clone());

        assert_eq!(store.mode_for_identity(&owner), Some(AccessMode::ReadWrite));
        assert_eq!(store.mode_for_identity(&UserIdentity::Uid(0)), None);
    }

    #[cfg(unix)]
    #[test]
    fn access_store_trusts_uid_zero_only_on_unix() {
        let owner = UserIdentity::Uid(1000);
        let store = ServerAccessStore::new_for_identity(1000, owner);

        assert_eq!(
            store.mode_for_identity(&UserIdentity::Uid(0)),
            Some(AccessMode::ReadWrite)
        );
    }

    #[test]
    fn access_store_tracks_current_platform_identity_for_owner() {
        let owner = current_user_identity().expect("current identity");
        let store = ServerAccessStore::new(current_owner_uid());

        assert_eq!(store.mode_for_identity(&owner), Some(AccessMode::ReadWrite));
    }

    #[test]
    fn read_only_access_allows_sdk_wait_observation_and_cancel() {
        let target = PaneTarget::new(SessionName::new("s").expect("session name"), 0);
        let wait = Request::SdkWaitForOutput(SdkWaitForOutputRequest {
            owner_id: SdkWaitOwnerId::new(7),
            wait_id: SdkWaitId::new(1),
            target,
            bytes: b"ready".to_vec(),
            start: PaneOutputSubscriptionStart::Now,
        });
        let cancel = Request::CancelSdkWait(CancelSdkWaitRequest {
            owner_id: SdkWaitOwnerId::new(7),
            wait_id: SdkWaitId::new(1),
        });

        assert_eq!(
            apply_access_policy(wait.clone(), false).expect("SDK wait is read-only observation"),
            wait
        );
        assert_eq!(
            apply_access_policy(cancel.clone(), false)
                .expect("SDK wait cancel is read-only cleanup"),
            cancel
        );
    }

    #[test]
    fn read_only_access_allows_sdk_target_discovery_and_snapshot() {
        let session = session_name();
        let pane = PaneTarget::new(session.clone(), 0);
        let resolve = Request::ResolveTarget(ResolveTargetRequest {
            target: Some("s:0.0".to_owned()),
            target_type: ResolveTargetType::Pane,
            window_index: false,
            prefer_unattached: false,
        });
        let snapshot = Request::PaneSnapshot(PaneSnapshotRequest { target: pane });

        assert_eq!(
            apply_access_policy(resolve.clone(), false)
                .expect("target resolution is read-only discovery"),
            resolve
        );
        assert_eq!(
            apply_access_policy(snapshot.clone(), false)
                .expect("pane snapshot is read-only observation"),
            snapshot
        );
    }

    #[test]
    fn read_only_access_allows_capture_pane_target_action() {
        let capture =
            Request::CapturePaneTargetAction(Box::new(capture_pane_target_action(true, None)));

        assert_eq!(
            apply_access_policy(capture.clone(), false)
                .expect("capture-pane target action is read-only observation"),
            capture
        );
    }

    #[test]
    fn read_only_access_rejects_capture_pane_target_action_that_writes_buffer() {
        let unnamed_buffer =
            Request::CapturePaneTargetAction(Box::new(capture_pane_target_action(false, None)));
        let named_buffer = Request::CapturePaneTargetAction(Box::new(capture_pane_target_action(
            false,
            Some("clip".to_owned()),
        )));

        assert_read_only_rejected(unnamed_buffer);
        assert_read_only_rejected(named_buffer);
    }

    #[test]
    fn read_only_access_allows_direct_capture_pane_output_only() {
        let capture = Request::CapturePane(Box::new(capture_pane_request(true, None)));

        assert_eq!(
            apply_access_policy(capture.clone(), false)
                .expect("printed capture-pane is read-only observation"),
            capture
        );
    }

    #[test]
    fn read_only_access_rejects_direct_capture_pane_that_writes_buffer() {
        let unnamed_buffer = Request::CapturePane(Box::new(capture_pane_request(false, None)));
        let named_buffer = Request::CapturePane(Box::new(capture_pane_request(
            false,
            Some("clip".to_owned()),
        )));

        assert_read_only_rejected(unnamed_buffer);
        assert_read_only_rejected(named_buffer);
    }

    #[test]
    fn guarded_capture_preserves_read_only_policy_and_window_actions_are_writes() {
        let target = berth_term_proto::PaneTargetRef::guarded_by_id(
            session_name(),
            berth_term_proto::PaneId::new(1),
            3,
        );
        let capture = Request::CapturePaneRef(Box::new(berth_term_proto::CapturePaneRefRequest {
            target: target.clone(),
            capture: capture_pane_request(true, None),
        }));
        assert_eq!(
            apply_access_policy(capture.clone(), false).expect("printed capture allowed"),
            capture
        );
        assert_read_only_rejected(Request::CapturePaneRef(Box::new(
            berth_term_proto::CapturePaneRefRequest {
                target: target.clone(),
                capture: capture_pane_request(false, None),
            },
        )));
        for operation in [
            berth_term_proto::PaneWindowOperation::Resize {
                width: 80,
                height: 24,
            },
            berth_term_proto::PaneWindowOperation::Close,
        ] {
            assert_read_only_rejected(Request::PaneWindow(berth_term_proto::PaneWindowRequest {
                target: target.clone(),
                operation,
            }));
        }
    }

    #[test]
    fn read_only_access_allows_printed_display_message() {
        let message = Request::DisplayMessage(DisplayMessageRequest {
            target: None,
            print: true,
            message: Some("#{session_name}".to_owned()),
            empty_target_context: false,
        });
        let extended = Request::DisplayMessageExt(Box::new(DisplayMessageExtRequest {
            target: None,
            print: true,
            message: Some("#{client_name}".to_owned()),
            target_client: Some("=".to_owned()),
            empty_target_context: false,
        }));

        assert_eq!(
            apply_access_policy(message.clone(), false)
                .expect("display-message -p is read-only format expansion"),
            message
        );
        assert_eq!(
            apply_access_policy(extended.clone(), false)
                .expect("display-message -p -c is read-only format expansion"),
            extended
        );
    }

    #[test]
    fn read_only_access_sanitizes_attach_session_ext_options() {
        let session = session_name();
        let request = Request::AttachSessionExt(AttachSessionExtRequest {
            target: Some(session.clone()),
            detach_other_clients: true,
            kill_other_clients: true,
            read_only: false,
            skip_environment_update: false,
            flags: Some(vec!["active-pane".to_owned()]),
        });

        let Request::AttachSessionExt(sanitized) =
            apply_access_policy(request, false).expect("read-only attach is allowed")
        else {
            panic!("expected sanitized attach-session ext request");
        };

        assert_eq!(sanitized.target, Some(session));
        assert!(!sanitized.detach_other_clients);
        assert!(!sanitized.kill_other_clients);
        assert!(sanitized.read_only);
        assert!(sanitized.skip_environment_update);
        assert_eq!(sanitized.flags, Some(vec!["active-pane".to_owned()]));
    }

    #[test]
    fn read_only_access_sanitizes_legacy_attach_session_options() {
        let session = session_name();
        let request = Request::AttachSession(AttachSessionRequest {
            target: session.clone(),
        });

        let Request::AttachSessionExt(sanitized) =
            apply_access_policy(request, false).expect("read-only legacy attach is allowed")
        else {
            panic!("expected sanitized attach-session ext request");
        };

        assert_eq!(sanitized.target, Some(session));
        assert!(!sanitized.detach_other_clients);
        assert!(!sanitized.kill_other_clients);
        assert!(sanitized.read_only);
        assert!(sanitized.skip_environment_update);
        assert_eq!(sanitized.flags, None);
    }

    #[test]
    fn read_only_access_sanitizes_attach_session_ext2_options() {
        let request = Request::AttachSessionExt2(Box::new(AttachSessionExt2Request {
            target: None,
            target_spec: Some("s:1.2".to_owned()),
            detach_other_clients: true,
            kill_other_clients: true,
            read_only: false,
            skip_environment_update: false,
            flags: None,
            working_directory: Some("/tmp".to_owned()),
            client_terminal: Default::default(),
            client_size: Some(TerminalSize {
                cols: 120,
                rows: 40,
            }),
        }));

        let Request::AttachSessionExt2(sanitized) =
            apply_access_policy(request, false).expect("read-only attach is allowed")
        else {
            panic!("expected sanitized attach-session ext2 request");
        };

        assert_eq!(sanitized.target, Some(session_name()));
        assert_eq!(sanitized.target_spec, None);
        assert!(!sanitized.detach_other_clients);
        assert!(!sanitized.kill_other_clients);
        assert!(sanitized.read_only);
        assert!(sanitized.skip_environment_update);
        assert_eq!(sanitized.working_directory, None);
        assert_eq!(sanitized.client_size, None);
    }

    #[test]
    fn read_only_access_sanitizes_attach_session_ext3_options() {
        let request = Request::AttachSessionExt3(Box::new(AttachSessionExt3Request {
            target: None,
            target_spec: Some("s:2.3".to_owned()),
            detach_other_clients: true,
            kill_other_clients: true,
            read_only: false,
            skip_environment_update: false,
            flags: None,
            working_directory: Some("/tmp".to_owned()),
            client_terminal: Default::default(),
            client_size: Some(TerminalSize {
                cols: 100,
                rows: 30,
            }),
            attach_capabilities: vec!["attach-render".to_owned()],
        }));

        let Request::AttachSessionExt3(sanitized) =
            apply_access_policy(request, false).expect("read-only attach is allowed")
        else {
            panic!("expected sanitized attach-session ext3 request");
        };

        assert_eq!(sanitized.target, Some(session_name()));
        assert_eq!(sanitized.target_spec, None);
        assert!(!sanitized.detach_other_clients);
        assert!(!sanitized.kill_other_clients);
        assert!(sanitized.read_only);
        assert!(sanitized.skip_environment_update);
        assert_eq!(sanitized.working_directory, None);
        assert_eq!(sanitized.client_size, None);
        assert_eq!(sanitized.attach_capabilities, vec!["attach-render"]);
    }

    fn assert_read_only_rejected(request: Request) {
        let error =
            apply_access_policy(request, false).expect_err("write request must be rejected");
        assert_eq!(error.to_string(), "server error: client is read-only");
    }

    fn session_name() -> SessionName {
        SessionName::new("s").expect("session name")
    }

    fn capture_pane_target_action(
        print: bool,
        buffer_name: Option<String>,
    ) -> CapturePaneTargetActionRequest {
        CapturePaneTargetActionRequest {
            target: Some("s:0.0".to_owned()),
            start: None,
            end: None,
            print,
            buffer_name,
            alternate: false,
            escape_ansi: false,
            escape_sequences: false,
            join_wrapped: false,
            use_mode_screen: false,
            preserve_trailing_spaces: false,
            do_not_trim_spaces: false,
            pending_input: false,
            quiet: false,
            start_is_absolute: false,
            end_is_absolute: false,
        }
    }

    fn capture_pane_request(print: bool, buffer_name: Option<String>) -> CapturePaneRequest {
        CapturePaneRequest {
            target: PaneTarget::new(SessionName::new("s").expect("session name"), 0),
            start: None,
            end: None,
            print,
            buffer_name,
            alternate: false,
            escape_ansi: false,
            escape_sequences: false,
            join_wrapped: false,
            use_mode_screen: false,
            preserve_trailing_spaces: false,
            do_not_trim_spaces: false,
            pending_input: false,
            quiet: false,
            start_is_absolute: false,
            end_is_absolute: false,
        }
    }
}
