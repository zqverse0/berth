use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use berth_term_proto::{CommandOutput, Target, TerminalError};

use super::super::scripting_support::format_context_for_target;
use super::super::RequestHandler;
use super::layout::{
    overlay_position_context, popup_content_size, popup_styles_for_target, resolve_popup_size,
};
use super::parse::{ParsedDisplayPopupCommand, PopupSizeSpec};
use super::popup_job::{spawn_popup_job, PopupDragMode, PopupSurface};
use super::state::{ClientOverlayState, PopupOverlayState};
use super::support::popup_shell_command;
use crate::format_runtime::render_runtime_template;
use crate::handler_support::attached_client_required;
use crate::renderer::resolve_overlay_rect;
use crate::terminal::TerminalProfile;

impl RequestHandler {
    pub(in crate::handler) async fn show_attached_command_output_popup(
        &self,
        attach_pid: u32,
        requester_pid: u32,
        target: Target,
        title: &str,
        output: &CommandOutput,
    ) -> Result<bool, TerminalError> {
        if output.stdout().is_empty() || self.mode_tree_active(attach_pid).await {
            return Ok(false);
        }
        let overlay_available = {
            let active_attach = self.active_attach.lock().await;
            active_attach
                .by_pid
                .get(&attach_pid)
                .ok_or_else(|| attached_client_required("attached command output"))?
                .overlay
                .is_none()
        };
        if !overlay_available {
            return Ok(false);
        }

        let command = ParsedDisplayPopupCommand {
            title: title.to_owned(),
            x: Some("C".to_owned()),
            y: Some("C".to_owned()),
            width: Some(PopupSizeSpec::Percent(90)),
            height: Some(PopupSizeSpec::Percent(80)),
            style: None,
            border_style: None,
            border_lines: None,
            close_on_exit: false,
            close_on_zero_exit: false,
            close_any_key: true,
            no_job: true,
            start_directory: None,
            environment: Vec::new(),
            command: None,
        };
        let mut popup = self
            .build_display_popup_state(attach_pid, requester_pid, command, target)
            .await?;
        popup
            .surface
            .lock()
            .expect("popup surface")
            .append(&popup_output_bytes(output));

        {
            let mut active_attach = self.active_attach.lock().await;
            let active = active_attach
                .by_pid
                .get_mut(&attach_pid)
                .ok_or_else(|| attached_client_required("attached command output"))?;
            active.overlay_state_id = active.overlay_state_id.saturating_add(1);
            popup.id = active.overlay_state_id;
            active.overlay = Some(ClientOverlayState::Popup(Box::new(popup)));
        }

        self.refresh_interactive_overlay_if_active(attach_pid)
            .await?;
        Ok(true)
    }

    async fn build_display_popup_state(
        &self,
        attach_pid: u32,
        requester_pid: u32,
        command: ParsedDisplayPopupCommand,
        target: Target,
    ) -> Result<PopupOverlayState, TerminalError> {
        let attached_count = self.attached_count(target.session_name()).await;
        let (client_size, mouse, session_name) = {
            let active_attach = self.active_attach.lock().await;
            let active = active_attach
                .by_pid
                .get(&attach_pid)
                .ok_or_else(|| attached_client_required("display-popup"))?;
            (
                active.client_size,
                active.mouse.current_event.clone(),
                active.session_name.clone(),
            )
        };

        let state = self.state.lock().await;
        let runtime = format_context_for_target(&state, &target, attached_count)?;
        let title = render_runtime_template(&command.title, &runtime, true);
        let rendered_start_directory = command
            .start_directory
            .as_ref()
            .map(|cwd| render_runtime_template(&cwd.to_string_lossy(), &runtime, false))
            .map(PathBuf::from);
        let command_text = popup_shell_command(&state, &session_name, &command, &runtime)?;
        let styles = popup_styles_for_target(&state, &target, &command, &runtime);
        let width = resolve_popup_size(
            command.width,
            client_size.cols.max(1) / 2,
            client_size.cols.max(1),
        );
        let height = resolve_popup_size(
            command.height,
            client_size.rows.max(1) / 2,
            client_size.rows.max(1),
        );
        let context =
            overlay_position_context(&state, &session_name, &target, client_size, mouse.as_ref());
        let rect = resolve_overlay_rect(
            runtime,
            context,
            command.x.as_deref(),
            command.y.as_deref(),
            width,
            height,
        )
        .ok_or_else(|| {
            TerminalError::Server("display-popup does not fit in attached client".to_owned())
        })?;
        let content_size = popup_content_size(rect, styles.border_lines);
        let surface = Arc::new(StdMutex::new(PopupSurface::new(content_size)));

        let mut popup = PopupOverlayState {
            id: 0,
            requester_pid,
            current_target: target.clone(),
            rect,
            preferred_width: width,
            preferred_height: height,
            title,
            style: styles.style,
            border_style: styles.border_style,
            border_lines: styles.border_lines,
            close_on_exit: command.close_on_exit,
            close_on_zero_exit: command.close_on_zero_exit,
            close_any_key: command.close_any_key,
            no_job: command.no_job,
            surface,
            job: None,
            nested_menu: None,
            dragging: PopupDragMode::Off,
        };

        let should_spawn_job =
            !command.no_job && (!command.close_any_key || command_text.is_some());
        if should_spawn_job {
            let profile = TerminalProfile::for_run_shell(
                &state.environment,
                &state.options,
                Some(&session_name),
                state
                    .sessions
                    .session(&session_name)
                    .map(|session| session.id().as_u32()),
                &self.socket_path(),
                true,
                rendered_start_directory.as_deref(),
            )?;
            let (job, initial_bytes) = spawn_popup_job(
                content_size,
                &profile,
                command_text.as_deref(),
                &command.environment,
            )?;
            if !initial_bytes.is_empty() {
                popup
                    .surface
                    .lock()
                    .expect("popup surface")
                    .append(&initial_bytes);
            }
            popup.job = Some(job);
        }

        Ok(popup)
    }
}

fn popup_output_bytes(output: &CommandOutput) -> Vec<u8> {
    let stdout = output.stdout();
    let mut normalized = Vec::with_capacity(stdout.len());
    let mut previous_was_cr = false;
    for byte in stdout {
        if *byte == b'\n' && !previous_was_cr {
            normalized.push(b'\r');
        }
        normalized.push(*byte);
        previous_was_cr = *byte == b'\r';
    }
    normalized
}
