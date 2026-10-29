use std::collections::VecDeque;

use berth_term_engine::command_parser::{CommandArgument, ParsedCommands};
use berth_term_proto::TerminalError;

#[derive(Debug, Clone)]
pub(super) enum CommandListArgument {
    Parsed(ParsedCommands),
    String(String),
}

pub(super) fn pop_string_argument(
    args: &mut VecDeque<CommandArgument>,
    description: &str,
) -> Result<String, TerminalError> {
    match args.pop_front() {
        Some(CommandArgument::String(value)) => Ok(value),
        Some(CommandArgument::Commands(_)) => Err(TerminalError::Server(format!(
            "{description} must be a string argument"
        ))),
        None => Err(TerminalError::Server(format!("missing {description}"))),
    }
}

pub(super) fn pop_command_list_argument(
    args: &mut VecDeque<CommandArgument>,
    description: &str,
) -> Result<CommandListArgument, TerminalError> {
    match args.pop_front() {
        Some(CommandArgument::String(value)) => Ok(CommandListArgument::String(value)),
        Some(CommandArgument::Commands(commands)) => Ok(CommandListArgument::Parsed(commands)),
        None => Err(TerminalError::Server(format!("missing {description}"))),
    }
}

pub(super) fn command_argument_for_error(argument: &CommandArgument) -> String {
    match argument {
        CommandArgument::String(value) => value.clone(),
        CommandArgument::Commands(_) => "{ ... }".to_owned(),
    }
}

pub(super) fn command_arguments_as_strings(
    command_name: &str,
    arguments: &[CommandArgument],
) -> Result<Vec<String>, TerminalError> {
    arguments
        .iter()
        .map(|argument| match argument {
            CommandArgument::String(value) => Ok(value.clone()),
            CommandArgument::Commands(_) => Err(TerminalError::Server(format!(
                "{command_name} does not accept a parsed command-list argument"
            ))),
        })
        .collect()
}

pub(super) fn command_arguments_with_blocks_as_strings(
    arguments: &[CommandArgument],
) -> Vec<String> {
    arguments
        .iter()
        .map(|argument| match argument {
            CommandArgument::String(value) => value.clone(),
            CommandArgument::Commands(commands) => commands.to_tmux_string(),
        })
        .collect()
}
