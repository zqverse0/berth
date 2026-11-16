use berth_term_proto::{
    CommandOutput, ErrorResponse, OptionScopeSelector, Response, ShowOptionsResponse, TerminalError,
};

use super::RequestHandler;
use crate::handler_support::ensure_option_scope_exists;
use crate::terminal::TerminalProfile;

impl RequestHandler {
    pub(super) async fn handle_show_options(
        &self,
        request: berth_term_proto::ShowOptionsRequest,
    ) -> Response {
        let state = self.state.lock().await;

        if let Err(error) = ensure_option_scope_exists(&state, &request.scope) {
            return Response::Error(ErrorResponse { error });
        }

        let mode = if request.include_inherited {
            berth_term_engine::ShowOptionsMode::ResolvedWithInheritanceMarkers
        } else if matches!(
            request.scope,
            OptionScopeSelector::ServerGlobal
                | OptionScopeSelector::SessionGlobal
                | OptionScopeSelector::WindowGlobal
        ) {
            berth_term_engine::ShowOptionsMode::Resolved
        } else {
            berth_term_engine::ShowOptionsMode::Explicit
        };
        match state.options.show_options_lines_with_mode_filtered(
            &request.scope,
            request.name.as_deref(),
            request.value_only,
            mode,
        ) {
            Ok(lines) => {
                let lines = self.render_runtime_show_options_lines(&state, &request, lines);
                Response::ShowOptions(ShowOptionsResponse {
                    scope: request.scope,
                    output: command_output_from_lines(&lines),
                })
            }
            Err(error) if request.quiet && show_options_quiet_suppresses(&error) => {
                Response::ShowOptions(ShowOptionsResponse {
                    scope: request.scope,
                    output: command_output_from_lines(&[]),
                })
            }
            Err(error) => Response::Error(ErrorResponse { error }),
        }
    }

    fn render_runtime_show_options_lines(
        &self,
        state: &super::HandlerState,
        request: &berth_term_proto::ShowOptionsRequest,
        lines: Vec<String>,
    ) -> Vec<String> {
        if !matches!(request.name.as_deref(), Some("default-shell")) {
            return lines;
        }
        if !matches!(request.scope, OptionScopeSelector::SessionGlobal) {
            return lines;
        }
        let session_name = show_options_session_name(&request.scope);
        let shell = TerminalProfile::resolved_default_shell(
            &state.environment,
            &state.options,
            session_name,
        )
        .to_string_lossy()
        .into_owned();
        if request.value_only {
            vec![shell]
        } else {
            vec![format!("default-shell {shell}")]
        }
    }
}

fn show_options_quiet_suppresses(error: &TerminalError) -> bool {
    let message = match error {
        TerminalError::Server(message) | TerminalError::Message(message) => message.as_str(),
        _ => return false,
    };
    message.starts_with("unknown option: ")
        || message.starts_with("invalid option: ")
        || message.starts_with("ambiguous option: ")
}

fn show_options_session_name(
    scope: &OptionScopeSelector,
) -> Option<&berth_term_proto::SessionName> {
    match scope {
        OptionScopeSelector::Session(session_name) => Some(session_name),
        OptionScopeSelector::Window(target) => Some(target.session_name()),
        OptionScopeSelector::Pane(target) => Some(target.session_name()),
        OptionScopeSelector::ServerGlobal
        | OptionScopeSelector::SessionGlobal
        | OptionScopeSelector::WindowGlobal => None,
    }
}

fn command_output_from_lines(lines: &[String]) -> CommandOutput {
    if lines.is_empty() {
        return CommandOutput::from_stdout(Vec::new());
    }

    CommandOutput::from_stdout(format!("{}\n", lines.join("\n")).into_bytes())
}
