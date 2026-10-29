use std::collections::HashSet;

use berth_term_engine::{LifecycleEvent, PaneId};
use berth_term_proto::{
    ErrorResponse, HookName, KillSessionResponse, PaneTarget, PaneWindowOperation,
    PaneWindowRequest, ResizeWindowRequest, Response, ScopeSelector, SessionId, SessionName,
    Target, TerminalError, WindowTarget,
};

#[cfg(windows)]
use super::pane_support::format_references_pane_pid;
use super::{
    client_environment_snapshot, client_spawn_environment, pane_support::resolve_pane_target_ref,
    scripting_support::render_start_directory_template, session_support::remove_session_locked,
    QueuedLifecycleEvent, RequestHandler,
};
use crate::hook_runtime::PendingInlineHookFormat;
use crate::pane_terminals::{
    HandlerState, KilledWindowResult, NewWindowOptions, RespawnWindowOptions, WindowSpawnOptions,
};

#[derive(Debug, Clone)]
struct UnlinkedWindowSnapshot {
    target: berth_term_proto::WindowTarget,
    window_id: u32,
    window_name: String,
    pane_ids: Vec<PaneId>,
    link_count: usize,
}

enum PaneWindowOutcome {
    Resized(WindowTarget, Vec<SessionName>),
    Killed(SessionName, KilledWindowResult),
    ClosedSession(SessionName, SessionId, Vec<PaneId>, QueuedLifecycleEvent),
}

impl RequestHandler {
    pub(super) async fn handle_new_window(
        &self,
        requester_pid: u32,
        request: berth_term_proto::NewWindowRequest,
    ) -> Response {
        let session_name = request.target;
        let environment_overrides = request.environment;
        let start_directory = request.start_directory;
        let command = request.command;
        let process_command = request
            .process_command
            .or_else(|| crate::legacy_command::from_legacy_command(command.as_deref()));
        let socket_path = self.socket_path();
        let client_environment = client_environment_snapshot(requester_pid);
        let spawn_environment = client_spawn_environment(client_environment.as_ref());
        let attached_count = self.attached_count(&session_name).await;
        #[cfg(windows)]
        if !request.detached {
            self.wait_for_windows_deferred_all_pane_pids().await;
        }
        let response = {
            let mut state = self.state.lock().await;
            let start_directory = match render_start_directory_template(
                &state,
                &Target::Session(session_name.clone()),
                attached_count,
                start_directory,
            ) {
                Ok(start_directory) => start_directory,
                Err(error) => return Response::Error(ErrorResponse { error }),
            };
            let options = NewWindowOptions {
                name: request.name,
                detached: request.detached,
                spawn: WindowSpawnOptions {
                    start_directory: start_directory.as_deref(),
                    command: process_command.as_ref(),
                    socket_path: &socket_path,
                    spawn_environment: spawn_environment.as_ref(),
                    environment_overrides: environment_overrides.as_deref(),
                    pane_alert_callback: Some(self.pane_alert_callback()),
                    pane_exit_callback: Some(self.pane_exit_callback()),
                },
            };
            let result = match request.target_window_index {
                Some(window_index) => state.create_window_at_requested_index(
                    &session_name,
                    Some(window_index),
                    request.insert_at_target,
                    options,
                ),
                None => state.create_window(&session_name, options),
            };
            match result {
                Ok(response) => Response::NewWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::NewWindow(_)) {
            self.sync_session_silence_timers(&session_name).await;
            if let Response::NewWindow(success) = &response {
                self.queue_inline_hook(
                    HookName::AfterNewWindow,
                    ScopeSelector::Session(session_name.clone()),
                    Some(Target::Pane(PaneTarget::with_window(
                        success.target.session_name().clone(),
                        success.target.window_index(),
                        0,
                    ))),
                    PendingInlineHookFormat::AfterCommand,
                );
                self.emit(LifecycleEvent::WindowLinked {
                    session_name: session_name.clone(),
                    target: Some(success.target.clone()),
                })
                .await;
            }
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    pub(super) async fn handle_kill_window(
        &self,
        request: berth_term_proto::KillWindowRequest,
    ) -> Response {
        let session_name = request.target.session_name().clone();
        let result = {
            let mut state = self.state.lock().await;
            state.kill_window(request.target, request.kill_all_others)
        };
        match result {
            Ok(result) => self.finish_kill_window(session_name, result).await,
            Err(error) => Response::Error(ErrorResponse { error }),
        }
    }

    pub(super) async fn handle_pane_window(&self, request: PaneWindowRequest) -> Response {
        let outcome = {
            // pane 代际校验、当前窗口定位与修改必须共用同一个 HandlerState 锁。
            let mut state = self.state.lock().await;
            (|| -> Result<PaneWindowOutcome, TerminalError> {
                let pane = resolve_pane_target_ref(&state, &request.target)?;
                let session_name = pane.session_name().clone();
                let window = WindowTarget::with_window(session_name.clone(), pane.window_index());
                match request.operation {
                    PaneWindowOperation::Resize { width, height } => {
                        state.resize_window(ResizeWindowRequest {
                            target: window.clone(),
                            width: Some(width),
                            height: Some(height),
                            adjustment: None,
                        })?;
                        let refresh_sessions = state.window_linked_session_family_list(
                            window.session_name(),
                            window.window_index(),
                        );
                        Ok(PaneWindowOutcome::Resized(window, refresh_sessions))
                    }
                    PaneWindowOperation::Close => {
                        let last_window = state
                            .sessions
                            .session(&session_name)
                            .is_some_and(|session| session.windows().len() == 1);
                        if last_window {
                            let current_runtime_owner = state.sessions.runtime_owner(&session_name);
                            if current_runtime_owner.as_ref() == Some(&session_name)
                                && !state.contains_session_terminals(&session_name)
                            {
                                return Err(TerminalError::Server(format!(
                                    "missing pane terminals for session {}",
                                    session_name
                                )));
                            }
                            let (pane_ids, session_id, event) =
                                remove_session_locked(&mut state, &session_name)?;
                            Ok(PaneWindowOutcome::ClosedSession(
                                session_name,
                                session_id,
                                pane_ids,
                                event,
                            ))
                        } else {
                            let killed = state.kill_window(window, false)?;
                            Ok(PaneWindowOutcome::Killed(session_name, killed))
                        }
                    }
                }
            })()
        };

        match outcome {
            Ok(PaneWindowOutcome::Resized(target, refresh_sessions)) => {
                self.queue_inline_hook(
                    HookName::AfterResizeWindow,
                    ScopeSelector::Session(target.session_name().clone()),
                    Some(Target::Window(target.clone())),
                    PendingInlineHookFormat::AfterCommand,
                );
                self.emit(LifecycleEvent::WindowLayoutChanged {
                    target: target.clone(),
                })
                .await;
                self.emit(LifecycleEvent::WindowResized {
                    target: target.clone(),
                })
                .await;
                for refresh_session in refresh_sessions {
                    self.refresh_attached_session(&refresh_session).await;
                }
                Response::ResizeWindow(berth_term_proto::ResizeWindowResponse { target })
            }
            Ok(PaneWindowOutcome::Killed(session_name, killed)) => {
                self.finish_kill_window(session_name, killed).await
            }
            Ok(PaneWindowOutcome::ClosedSession(session_name, session_id, pane_ids, event)) => {
                self.exit_attached_session(&session_name).await;
                self.cancel_session_silence_timers(&session_name).await;
                self.prune_web_session(Some((session_name.clone(), session_id)));
                self.forget_pane_snapshot_coalescers(&pane_ids);
                self.emit_prepared(event);
                self.remove_session_leases(std::slice::from_ref(&session_name));
                let _ = self.queue_shutdown_if_server_empty().await;
                Response::KillSession(KillSessionResponse { existed: true })
            }
            Err(error) => Response::Error(ErrorResponse { error }),
        }
    }

    async fn finish_kill_window(
        &self,
        session_name: SessionName,
        killed: KilledWindowResult,
    ) -> Response {
        self.forget_pane_snapshot_coalescers(&killed.removed_pane_ids);
        let mut affected_sessions = killed
            .removed_windows
            .iter()
            .map(|removed_window| removed_window.target.session_name().clone())
            .collect::<HashSet<_>>();
        let _ = affected_sessions.insert(session_name);
        for affected_session in &affected_sessions {
            self.sync_session_silence_timers(affected_session).await;
        }
        for removed_window in killed.removed_windows {
            let removed_session_name = removed_window.target.session_name().clone();
            self.emit(LifecycleEvent::WindowUnlinked {
                session_name: removed_session_name,
                target: Some(removed_window.target),
                window_id: Some(removed_window.window_id),
                window_name: Some(removed_window.window_name),
            })
            .await;
        }
        for affected_session in affected_sessions {
            self.refresh_attached_session(&affected_session).await;
        }
        Response::KillWindow(killed.response)
    }

    pub(super) async fn handle_select_window(
        &self,
        request: berth_term_proto::SelectWindowRequest,
    ) -> Response {
        let session_name = request.target.session_name().clone();
        let target_window_index = request.target.window_index();
        let (response, window_changed) = {
            let mut state = self.state.lock().await;
            let window_changed = state
                .sessions
                .session(&session_name)
                .is_some_and(|session| session.active_window_index() != target_window_index);
            match state.select_window(request.target) {
                Ok(response) => (Response::SelectWindow(response), window_changed),
                Err(error) => (Response::Error(ErrorResponse { error }), false),
            }
        };

        if matches!(response, Response::SelectWindow(_)) {
            if window_changed {
                self.emit(LifecycleEvent::SessionWindowChanged {
                    session_name: session_name.clone(),
                })
                .await;
            }
            self.queue_inline_hook(
                HookName::AfterSelectWindow,
                ScopeSelector::Session(session_name.clone()),
                Some(Target::Window(berth_term_proto::WindowTarget::with_window(
                    session_name.clone(),
                    target_window_index,
                ))),
                PendingInlineHookFormat::AfterCommand,
            );
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    pub(super) async fn handle_rename_window(
        &self,
        request: berth_term_proto::RenameWindowRequest,
    ) -> Response {
        let target = request.target.clone();
        let (response, refresh_sessions) = {
            let mut state = self.state.lock().await;
            match state.rename_window(request.target, request.name) {
                Ok(response) => {
                    let refresh_sessions = state.window_linked_session_family_list(
                        target.session_name(),
                        target.window_index(),
                    );
                    (Response::RenameWindow(response), refresh_sessions)
                }
                Err(error) => (Response::Error(ErrorResponse { error }), Vec::new()),
            }
        };

        if matches!(response, Response::RenameWindow(_)) {
            self.emit(LifecycleEvent::WindowRenamed { target }).await;
            for refresh_session in refresh_sessions {
                self.refresh_attached_session(&refresh_session).await;
            }
        }

        response
    }

    pub(super) async fn handle_next_window(
        &self,
        request: berth_term_proto::NextWindowRequest,
    ) -> Response {
        let session_name = request.target;
        let response = {
            let mut state = self.state.lock().await;
            match state.next_window(&session_name, request.alerts_only) {
                Ok(response) => Response::NextWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::NextWindow(_)) {
            self.emit(LifecycleEvent::SessionWindowChanged {
                session_name: session_name.clone(),
            })
            .await;
            if let Response::NextWindow(success) = &response {
                self.queue_inline_hook(
                    HookName::AfterSelectWindow,
                    ScopeSelector::Session(session_name.clone()),
                    Some(Target::Window(success.target.clone())),
                    PendingInlineHookFormat::AfterCommand,
                );
            }
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    pub(super) async fn handle_previous_window(
        &self,
        request: berth_term_proto::PreviousWindowRequest,
    ) -> Response {
        let session_name = request.target;
        let response = {
            let mut state = self.state.lock().await;
            match state.previous_window(&session_name, request.alerts_only) {
                Ok(response) => Response::PreviousWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::PreviousWindow(_)) {
            self.emit(LifecycleEvent::SessionWindowChanged {
                session_name: session_name.clone(),
            })
            .await;
            if let Response::PreviousWindow(success) = &response {
                self.queue_inline_hook(
                    HookName::AfterSelectWindow,
                    ScopeSelector::Session(session_name.clone()),
                    Some(Target::Window(success.target.clone())),
                    PendingInlineHookFormat::AfterCommand,
                );
            }
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    pub(super) async fn handle_last_window(
        &self,
        request: berth_term_proto::LastWindowRequest,
    ) -> Response {
        let session_name = request.target;
        let response = {
            let mut state = self.state.lock().await;
            match state.last_window(&session_name) {
                Ok(response) => Response::LastWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::LastWindow(_)) {
            self.emit(LifecycleEvent::SessionWindowChanged {
                session_name: session_name.clone(),
            })
            .await;
            if let Response::LastWindow(success) = &response {
                self.queue_inline_hook(
                    HookName::AfterSelectWindow,
                    ScopeSelector::Session(session_name.clone()),
                    Some(Target::Window(success.target.clone())),
                    PendingInlineHookFormat::AfterCommand,
                );
            }
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    pub(super) async fn handle_list_windows(
        &self,
        request: berth_term_proto::ListWindowsRequest,
    ) -> Response {
        let attached_count = {
            let active_attach = self.active_attach.lock().await;
            active_attach.attached_count(&request.target)
        };
        #[cfg(windows)]
        if format_references_pane_pid(request.format.as_deref()) {
            self.wait_for_windows_deferred_all_pane_pids().await;
        }
        let state = self.state.lock().await;
        match state.list_windows(&request.target, request.format.as_deref(), attached_count) {
            Ok(response) => Response::ListWindows(response),
            Err(error) => Response::Error(ErrorResponse { error }),
        }
    }

    pub(super) async fn handle_link_window(
        &self,
        request: berth_term_proto::LinkWindowRequest,
    ) -> Response {
        let refresh_sessions =
            unique_sessions(request.source.session_name(), request.target.session_name());
        let removed_destination_pane_ids = {
            let state = self.state.lock().await;
            link_window_replaced_destination_pane_ids(&state, &request)
        };
        let response = {
            let mut state = self.state.lock().await;
            match state.link_window(request.clone()) {
                Ok(response) => Response::LinkWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if let Response::LinkWindow(success) = &response {
            self.forget_pane_snapshot_coalescers(&removed_destination_pane_ids);
            self.emit(LifecycleEvent::WindowLinked {
                session_name: success.target.session_name().clone(),
                target: Some(success.target.clone()),
            })
            .await;
            for session_name in refresh_sessions {
                self.sync_session_silence_timers(&session_name).await;
                self.refresh_attached_session(&session_name).await;
            }
        }

        response
    }

    pub(super) async fn handle_move_window(
        &self,
        request: berth_term_proto::MoveWindowRequest,
    ) -> Response {
        let refresh_sessions = move_window_refresh_sessions(&request);
        let unlinked_window = {
            let state = self.state.lock().await;
            move_window_unlinked_window_snapshot(&state, &request)
        };
        let removed_destination_pane_ids = {
            let state = self.state.lock().await;
            move_window_replaced_destination_pane_ids(&state, &request)
        };
        let response = {
            let mut state = self.state.lock().await;
            match state.move_window(request.clone()) {
                Ok(response) => Response::MoveWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::MoveWindow(_)) {
            self.forget_pane_snapshot_coalescers(&removed_destination_pane_ids);
            let lifecycle_events =
                move_window_lifecycle_events(&response, &request, unlinked_window.as_ref());
            for event in lifecycle_events {
                self.emit(event).await;
            }
            for session_name in refresh_sessions {
                self.sync_session_silence_timers(&session_name).await;
                self.refresh_attached_session(&session_name).await;
            }
        }

        response
    }

    pub(super) async fn handle_unlink_window(
        &self,
        request: berth_term_proto::UnlinkWindowRequest,
    ) -> Response {
        let kill_if_last = request.kill_if_last;
        let removed_window = {
            let state = self.state.lock().await;
            state
                .sessions
                .session(request.target.session_name())
                .and_then(|session| session.window_at(request.target.window_index()))
                .map(|window| UnlinkedWindowSnapshot {
                    target: request.target.clone(),
                    window_id: window.id().as_u32(),
                    window_name: window.name().unwrap_or_default().to_owned(),
                    pane_ids: window_pane_ids(window),
                    link_count: state.window_link_count(
                        request.target.session_name(),
                        request.target.window_index(),
                    ),
                })
        };
        let session_name = request.target.session_name().clone();
        let response = {
            let mut state = self.state.lock().await;
            match state.unlink_window(request.target, request.kill_if_last) {
                Ok(response) => Response::UnlinkWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::UnlinkWindow(_)) {
            if let Some(removed_window) = removed_window {
                if kill_if_last && removed_window.link_count == 1 {
                    self.forget_pane_snapshot_coalescers(&removed_window.pane_ids);
                }
                self.emit(LifecycleEvent::WindowUnlinked {
                    session_name: session_name.clone(),
                    target: Some(removed_window.target),
                    window_id: Some(removed_window.window_id),
                    window_name: Some(removed_window.window_name),
                })
                .await;
            }
            self.sync_session_silence_timers(&session_name).await;
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    pub(super) async fn handle_swap_window(
        &self,
        request: berth_term_proto::SwapWindowRequest,
    ) -> Response {
        let refresh_sessions =
            unique_sessions(request.source.session_name(), request.target.session_name());
        let response = {
            let mut state = self.state.lock().await;
            match state.swap_window(request.source, request.target, request.detached) {
                Ok(response) => Response::SwapWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::SwapWindow(_)) {
            for session_name in refresh_sessions {
                self.sync_session_silence_timers(&session_name).await;
                self.refresh_attached_session(&session_name).await;
            }
        }

        response
    }

    pub(super) async fn handle_rotate_window(
        &self,
        request: berth_term_proto::RotateWindowRequest,
    ) -> Response {
        let session_name = request.target.session_name().clone();
        let target = request.target;
        let response = {
            let mut state = self.state.lock().await;
            match state.rotate_window(target.clone(), request.direction, request.restore_zoom) {
                Ok(response) => Response::RotateWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::RotateWindow(_)) {
            self.emit(LifecycleEvent::WindowLayoutChanged { target })
                .await;
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    pub(super) async fn handle_resize_window(
        &self,
        request: berth_term_proto::ResizeWindowRequest,
    ) -> Response {
        let request = match self
            .resolve_resize_window_linked_session_size(request)
            .await
        {
            Ok(request) => request,
            Err(error) => return Response::Error(ErrorResponse { error }),
        };
        let session_name = request.target.session_name().clone();
        let target = request.target.clone();
        let (response, refresh_sessions) = {
            let mut state = self.state.lock().await;
            match state.resize_window(request) {
                Ok(response) => {
                    let refresh_sessions = state.window_linked_session_family_list(
                        target.session_name(),
                        target.window_index(),
                    );
                    (Response::ResizeWindow(response), refresh_sessions)
                }
                Err(error) => (Response::Error(ErrorResponse { error }), Vec::new()),
            }
        };

        if matches!(response, Response::ResizeWindow(_)) {
            self.queue_inline_hook(
                HookName::AfterResizeWindow,
                ScopeSelector::Session(session_name.clone()),
                Some(Target::Window(target.clone())),
                PendingInlineHookFormat::AfterCommand,
            );
            self.emit(LifecycleEvent::WindowLayoutChanged {
                target: target.clone(),
            })
            .await;
            self.emit(LifecycleEvent::WindowResized { target }).await;
            for refresh_session in refresh_sessions {
                self.refresh_attached_session(&refresh_session).await;
            }
        }

        response
    }

    pub(super) async fn handle_respawn_window(
        &self,
        requester_pid: u32,
        mut request: berth_term_proto::RespawnWindowRequest,
    ) -> Response {
        let session_name = request.target.session_name().clone();
        let target = request.target.clone();
        let socket_path = self.socket_path();
        let process_command =
            crate::legacy_command::from_legacy_command(request.command.as_deref());
        let client_environment = client_environment_snapshot(requester_pid);
        let spawn_environment = client_spawn_environment(client_environment.as_ref());
        let attached_count = self.attached_count(&session_name).await;
        let response = {
            let mut state = self.state.lock().await;
            request.start_directory = match render_start_directory_template(
                &state,
                &Target::Window(target),
                attached_count,
                request.start_directory,
            ) {
                Ok(start_directory) => start_directory,
                Err(error) => return Response::Error(ErrorResponse { error }),
            };
            match state.respawn_window(
                request.target,
                RespawnWindowOptions {
                    kill: request.kill,
                    spawn: WindowSpawnOptions {
                        start_directory: request.start_directory.as_deref(),
                        command: process_command.as_ref(),
                        socket_path: &socket_path,
                        spawn_environment: spawn_environment.as_ref(),
                        environment_overrides: request.environment.as_deref(),
                        pane_alert_callback: Some(self.pane_alert_callback()),
                        pane_exit_callback: Some(self.pane_exit_callback()),
                    },
                },
            ) {
                Ok(response) => Response::RespawnWindow(response),
                Err(error) => Response::Error(ErrorResponse { error }),
            }
        };

        if matches!(response, Response::RespawnWindow(_)) {
            self.refresh_attached_session(&session_name).await;
        }

        response
    }

    async fn resolve_resize_window_linked_session_size(
        &self,
        mut request: berth_term_proto::ResizeWindowRequest,
    ) -> Result<berth_term_proto::ResizeWindowRequest, berth_term_proto::TerminalError> {
        use berth_term_proto::ResizeWindowAdjustment::{
            LargestLinkedSession, SmallestLinkedSession,
        };

        let largest = match request.adjustment {
            Some(LargestLinkedSession) => true,
            Some(SmallestLinkedSession) => false,
            _ => return Ok(request),
        };

        let (linked_sessions, fallback_size) = {
            let state = self.state.lock().await;
            let session = state
                .sessions
                .session(request.target.session_name())
                .ok_or_else(|| {
                    crate::pane_terminals::session_not_found(request.target.session_name())
                })?;
            let _window = session
                .window_at(request.target.window_index())
                .ok_or_else(|| {
                    berth_term_proto::TerminalError::invalid_target(
                        request.target.to_string(),
                        "window index does not exist in session",
                    )
                })?;
            (
                state.window_linked_sessions_list(
                    request.target.session_name(),
                    request.target.window_index(),
                ),
                session.terminal_size(),
            )
        };
        let linked_sessions = linked_sessions.into_iter().collect::<HashSet<_>>();
        let selected = {
            let active_attach = self.active_attach.lock().await;
            let sizes = active_attach
                .by_pid
                .values()
                .filter(|active| {
                    !active.suspended && linked_sessions.contains(&active.session_name)
                })
                .map(|active| active.client_size);
            if largest {
                sizes.max_by_key(resize_window_size_rank)
            } else {
                sizes.min_by_key(resize_window_size_rank)
            }
        }
        .unwrap_or(fallback_size);

        request.width = Some(selected.cols);
        request.height = Some(selected.rows);
        request.adjustment = None;
        Ok(request)
    }
}

fn resize_window_size_rank(size: &berth_term_proto::TerminalSize) -> (u32, u16, u16) {
    (
        u32::from(size.cols) * u32::from(size.rows),
        size.cols,
        size.rows,
    )
}

fn move_window_refresh_sessions(
    request: &berth_term_proto::MoveWindowRequest,
) -> Vec<berth_term_proto::SessionName> {
    if request.renumber {
        return match &request.target {
            berth_term_proto::MoveWindowTarget::Session(session_name) => vec![session_name.clone()],
            berth_term_proto::MoveWindowTarget::Window(target) => {
                vec![target.session_name().clone()]
            }
        };
    }

    let Some(source) = &request.source else {
        return Vec::new();
    };
    let berth_term_proto::MoveWindowTarget::Window(target) = &request.target else {
        return vec![source.session_name().clone()];
    };
    unique_sessions(source.session_name(), target.session_name())
}

fn move_window_lifecycle_events(
    response: &Response,
    request: &berth_term_proto::MoveWindowRequest,
    unlinked_window: Option<&UnlinkedWindowSnapshot>,
) -> Vec<LifecycleEvent> {
    if request.renumber {
        return Vec::new();
    }

    let Some(source) = &request.source else {
        return Vec::new();
    };

    let Response::MoveWindow(success) = response else {
        return Vec::new();
    };
    let destination_session = success.session_name.clone();
    let destination_window_index = success.target.as_ref().map(|target| target.window_index());
    if source.session_name() == &destination_session
        && Some(source.window_index()) == destination_window_index
    {
        return Vec::new();
    }

    vec![
        LifecycleEvent::WindowUnlinked {
            session_name: source.session_name().clone(),
            target: unlinked_window.as_ref().map(|window| window.target.clone()),
            window_id: unlinked_window.map(|window| window.window_id),
            window_name: unlinked_window.map(|window| window.window_name.clone()),
        },
        LifecycleEvent::WindowLinked {
            session_name: destination_session.clone(),
            target: success.target.clone(),
        },
    ]
}

fn move_window_unlinked_window_snapshot(
    state: &HandlerState,
    request: &berth_term_proto::MoveWindowRequest,
) -> Option<UnlinkedWindowSnapshot> {
    let source = request.source.as_ref()?;
    let window = state
        .sessions
        .session(source.session_name())?
        .window_at(source.window_index())?;
    Some(UnlinkedWindowSnapshot {
        target: source.clone(),
        window_id: window.id().as_u32(),
        window_name: window.name().unwrap_or_default().to_owned(),
        pane_ids: window_pane_ids(window),
        link_count: state.window_link_count(source.session_name(), source.window_index()),
    })
}

fn link_window_replaced_destination_pane_ids(
    state: &HandlerState,
    request: &berth_term_proto::LinkWindowRequest,
) -> Vec<PaneId> {
    if !request.kill_destination || request.after || request.before {
        return Vec::new();
    }
    if state.window_link_count(request.target.session_name(), request.target.window_index()) > 1 {
        return Vec::new();
    }
    state
        .sessions
        .session(request.target.session_name())
        .and_then(|session| session.window_at(request.target.window_index()))
        .map(window_pane_ids)
        .unwrap_or_default()
}

fn move_window_replaced_destination_pane_ids(
    state: &HandlerState,
    request: &berth_term_proto::MoveWindowRequest,
) -> Vec<PaneId> {
    if request.renumber || !request.kill_destination || request.after || request.before {
        return Vec::new();
    }
    let Some(source) = request.source.as_ref() else {
        return Vec::new();
    };
    let berth_term_proto::MoveWindowTarget::Window(target) = &request.target else {
        return Vec::new();
    };
    if source.session_name() == target.session_name()
        && source.window_index() == target.window_index()
    {
        return Vec::new();
    }
    state
        .sessions
        .session(target.session_name())
        .and_then(|session| session.window_at(target.window_index()))
        .map(window_pane_ids)
        .unwrap_or_default()
}

fn window_pane_ids(window: &berth_term_engine::Window) -> Vec<PaneId> {
    window.panes().iter().map(|pane| pane.id()).collect()
}

fn unique_sessions(
    source_session: &berth_term_proto::SessionName,
    target_session: &berth_term_proto::SessionName,
) -> Vec<berth_term_proto::SessionName> {
    if source_session == target_session {
        vec![source_session.clone()]
    } else {
        vec![source_session.clone(), target_session.clone()]
    }
}
