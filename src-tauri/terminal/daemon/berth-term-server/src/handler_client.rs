use std::path::PathBuf;

use berth_term_engine::formats::FormatContext;
use berth_term_proto::{TerminalError, TerminalGeometry, TerminalSize};

use crate::format_runtime::{render_runtime_template, RuntimeFormatContext};
use crate::handler_support::{ambiguous_attached_client, attached_client_required};
use crate::pane_terminals::session_not_found;

use super::{
    attach_support::ClientFlags, attached_client_matches_target, normalize_target_client,
    session_selection_prefers_live_process, RequestHandler,
};

#[path = "handler_client/attach.rs"]
mod attach;
#[path = "handler_client/detach.rs"]
mod detach;
#[path = "handler_client/switching.rs"]
mod switching;

/// 命令作用的客户端：只有 attach 客户端（控制模式已移除）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ManagedClient {
    Attach(u32),
}

impl RequestHandler {
    /// 会话当前接入的客户端数（只有 attach 客户端）。
    pub(super) async fn attached_count(
        &self,
        session_name: &berth_term_proto::SessionName,
    ) -> usize {
        self.active_attach.lock().await.attached_count(session_name)
    }

    /// 客户端切到 `session_name` 后该会话的接入数。
    pub(super) async fn attached_count_after_switch(
        &self,
        session_name: &berth_term_proto::SessionName,
        client: ManagedClient,
    ) -> usize {
        let attached_count = self.attached_count(session_name).await;
        let ManagedClient::Attach(attach_pid) = client;
        let active_attach = self.active_attach.lock().await;
        if active_attach
            .by_pid
            .get(&attach_pid)
            .is_some_and(|active| &active.session_name == session_name)
        {
            attached_count
        } else {
            attached_count.saturating_add(1)
        }
    }

    pub(super) async fn current_session_candidate(
        &self,
        requester_pid: u32,
    ) -> Option<berth_term_proto::SessionName> {
        self.active_attach
            .lock()
            .await
            .current_session_candidate(requester_pid)
    }

    pub(super) async fn resolve_managed_client(
        &self,
        requester_pid: u32,
        command_name: &str,
    ) -> Result<ManagedClient, berth_term_proto::TerminalError> {
        let active_attach = self.active_attach.lock().await;
        if active_attach.by_pid.contains_key(&requester_pid) {
            return Ok(ManagedClient::Attach(requester_pid));
        }
        let mut candidates = active_attach.by_pid.keys().copied();
        match (candidates.next(), candidates.next()) {
            (None, _) => Err(attached_client_required(command_name)),
            (Some(pid), None) => Ok(ManagedClient::Attach(pid)),
            _ => Err(ambiguous_attached_client(command_name)),
        }
    }

    async fn managed_client_for_pid(&self, requester_pid: u32) -> Option<ManagedClient> {
        {
            let active_attach = self.active_attach.lock().await;
            if active_attach.by_pid.contains_key(&requester_pid) {
                return Some(ManagedClient::Attach(requester_pid));
            }
        }
        None
    }

    async fn set_attached_client_flags(
        &self,
        attach_pid: u32,
        mut flags: ClientFlags,
    ) -> Result<(), TerminalError> {
        let mut active_attach = self.active_attach.lock().await;
        let active = active_attach
            .by_pid
            .get_mut(&attach_pid)
            .ok_or_else(|| attached_client_required("attach-session"))?;
        if !active.can_write {
            flags = flags.with_read_only();
        }
        active.flags = flags;
        Ok(())
    }

    pub(in crate::handler) async fn resolve_target_managed_client(
        &self,
        requester_pid: u32,
        target_client: Option<&str>,
        command_name: &str,
    ) -> Result<ManagedClient, TerminalError> {
        let Some(target_client) = target_client.map(normalize_target_client) else {
            return self
                .resolve_managed_client(requester_pid, command_name)
                .await;
        };
        if target_client == "=" {
            return self
                .resolve_managed_client(requester_pid, command_name)
                .await;
        }

        {
            let active_attach = self.active_attach.lock().await;
            if let Ok(pid) = target_client.parse::<u32>() {
                if active_attach.by_pid.contains_key(&pid) {
                    return Ok(ManagedClient::Attach(pid));
                }
            } else if let Some((&pid, _)) = active_attach
                .by_pid
                .iter()
                .find(|(pid, _)| attached_client_matches_target(**pid, target_client))
            {
                return Ok(ManagedClient::Attach(pid));
            }
        }

        Err(TerminalError::Server(format!(
            "can't find client: {target_client}"
        )))
    }

    pub(in crate::handler) async fn find_target_attach_client_pid(
        &self,
        requester_pid: u32,
        target_client: &str,
        command_name: &str,
    ) -> Result<Option<u32>, TerminalError> {
        let target_client = normalize_target_client(target_client);
        if target_client == "=" {
            return self
                .resolve_target_attach_client_pid(requester_pid, Some(target_client), command_name)
                .await
                .map(Some);
        }

        {
            let active_attach = self.active_attach.lock().await;
            if let Ok(pid) = target_client.parse::<u32>() {
                if active_attach.by_pid.contains_key(&pid) {
                    return Ok(Some(pid));
                }
            } else if let Some((&pid, _)) = active_attach
                .by_pid
                .iter()
                .find(|(pid, _)| attached_client_matches_target(**pid, target_client))
            {
                return Ok(Some(pid));
            }
        }

        Ok(None)
    }

    pub(in crate::handler) async fn resolve_target_attach_client_pid(
        &self,
        requester_pid: u32,
        target_client: Option<&str>,
        command_name: &str,
    ) -> Result<u32, TerminalError> {
        match self
            .resolve_target_managed_client(requester_pid, target_client, command_name)
            .await?
        {
            ManagedClient::Attach(attach_pid) => Ok(attach_pid),
        }
    }

    async fn update_session_cwd_from_template(
        &self,
        session_name: &berth_term_proto::SessionName,
        template: &str,
    ) -> Result<(), TerminalError> {
        let rendered = {
            let state = self.state.lock().await;
            let session = state
                .sessions
                .session(session_name)
                .ok_or_else(|| session_not_found(session_name))?;
            let context = RuntimeFormatContext::new(FormatContext::from_session(session))
                .with_state(&state)
                .with_session(session);
            render_runtime_template(template, &context, false)
        };

        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .session_mut(session_name)
            .ok_or_else(|| session_not_found(session_name))?;
        session.set_cwd((!rendered.is_empty()).then(|| PathBuf::from(rendered)));
        Ok(())
    }

    pub(in crate::handler) async fn preferred_session_name(
        &self,
    ) -> Result<berth_term_proto::SessionName, TerminalError> {
        let sessions = {
            let state = self.state.lock().await;
            let mut sessions = state
                .sessions
                .iter()
                .map(|(session_name, session)| {
                    let active_window = session.active_window_index();
                    let active_pane = session.window().active_pane_index();
                    (
                        session_name.clone(),
                        session.id(),
                        state
                            .pane_pid_in_window(session_name, active_window, active_pane)
                            .ok()
                            .map(session_selection_prefers_live_process),
                        session.last_attached_at(),
                        session.activity_at(),
                        session.created_at(),
                    )
                })
                .collect::<Vec<_>>();
            sessions.sort_by(|(left, ..), (right, ..)| left.as_str().cmp(right.as_str()));
            sessions
        };
        let Some((_first_session, ..)) = sessions.first().cloned() else {
            return Err(TerminalError::Server("no sessions".to_owned()));
        };

        let mut preferred = Vec::new();
        for (session_name, session_id, live_process, last_attached_at, activity_at, created_at) in
            &sessions
        {
            if self.attached_count(session_name).await == 0 {
                preferred.push((
                    session_name.clone(),
                    *session_id,
                    *live_process,
                    *last_attached_at,
                    *activity_at,
                    *created_at,
                ));
            }
        }

        let candidates = if preferred.is_empty() {
            sessions
        } else {
            preferred
        };
        let candidates = if candidates
            .iter()
            .any(|(_, _, live_process, ..)| live_process.unwrap_or(false))
        {
            candidates
                .into_iter()
                .filter(|(_, _, live_process, ..)| live_process.unwrap_or(false))
                .collect::<Vec<_>>()
        } else {
            candidates
        };

        let (session_name, ..) = candidates
            .into_iter()
            .max_by(
                |(left_name, left_id, _, left_attached, left_activity, left_created),
                 (right_name, right_id, _, right_attached, right_activity, right_created)| {
                    left_attached
                        .unwrap_or(i64::MIN)
                        .cmp(&right_attached.unwrap_or(i64::MIN))
                        .then(
                            left_activity
                                .cmp(right_activity)
                                .then(left_created.cmp(right_created))
                                .then(left_id.cmp(right_id))
                                .then(right_name.as_str().cmp(left_name.as_str())),
                        )
                },
            )
            .ok_or_else(|| TerminalError::Server("no sessions".to_owned()))?;

        Ok(session_name)
    }

    async fn resize_session_for_attach_client(
        &self,
        session_name: &berth_term_proto::SessionName,
        client_size: Option<TerminalSize>,
    ) -> Result<(), TerminalError> {
        self.resize_session_geometry_for_attach_client(
            session_name,
            client_size.map(TerminalGeometry::from_size),
        )
        .await
    }

    async fn resize_session_geometry_for_attach_client(
        &self,
        session_name: &berth_term_proto::SessionName,
        client_geometry: Option<TerminalGeometry>,
    ) -> Result<(), TerminalError> {
        let Some(client_geometry) =
            client_geometry.filter(|geometry| geometry.size.cols > 0 && geometry.size.rows > 0)
        else {
            return Ok(());
        };
        let client_size = client_geometry.size;

        #[cfg(windows)]
        self.wait_for_windows_deferred_all_pane_pids().await;
        let mut state = self.state.lock().await;
        state.set_attached_terminal_pixels(session_name, client_geometry.pixels);
        state.mutate_session_and_resize_terminals(session_name, |session| {
            session.touch_attached();
            session.resize_terminal(client_size);
            Ok(())
        })
    }
}
