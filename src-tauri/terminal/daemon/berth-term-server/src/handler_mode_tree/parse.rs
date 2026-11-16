use std::collections::VecDeque;

use berth_term_engine::command_parser::{CommandArgument, ParsedCommand};
use berth_term_proto::TerminalError;

use super::mode_tree_model::{
    ModeTreeKind, ParsedModeTreeCommand, PreviewMode, SortOrder, TreeDepth,
};

pub(super) fn parse_mode_tree_queue_command(
    command: ParsedCommand,
) -> Result<Option<ParsedModeTreeCommand>, TerminalError> {
    let kind = match command.name() {
        "choose-tree" => ModeTreeKind::Tree,
        _ => return Ok(None),
    };

    let mut args = VecDeque::from(command.arguments().to_vec());
    let mut preview_state = PreviewMode::Normal;
    let mut row_format = None;
    let mut filter_format = None;
    let mut key_format = None;
    let mut sort_order = None;
    let mut reversed = false;
    let mut tree_depth = TreeDepth::Pane;
    let mut show_all_group_members = false;
    let auto_accept = false;
    let mut zoom = false;
    let mut target = None;

    while let Some(token) = args.front().and_then(CommandArgument::as_string) {
        if token == "--" {
            let _ = args.pop_front();
            break;
        }
        if token == "-" || !token.starts_with('-') {
            break;
        }

        let flag_token = pop_string_argument(&mut args, "mode-tree flag")?;
        let chars = flag_token.chars().collect::<Vec<_>>();
        let mut index = 1;
        while index < chars.len() {
            match chars[index] {
                'F' => {
                    row_format = Some(inline_flag_value(
                        &chars, &mut index, &mut args, "-F value",
                    )?);
                    break;
                }
                'f' => {
                    filter_format = Some(inline_flag_value(
                        &chars, &mut index, &mut args, "-f value",
                    )?);
                    break;
                }
                'G' => show_all_group_members = true,
                'K' => {
                    key_format = Some(inline_flag_value(
                        &chars, &mut index, &mut args, "-K value",
                    )?);
                    break;
                }
                'N' => {
                    preview_state = match preview_state {
                        PreviewMode::Normal => PreviewMode::Off,
                        PreviewMode::Off => PreviewMode::Big,
                        PreviewMode::Big => PreviewMode::Big,
                    };
                }
                'O' => {
                    let value = inline_flag_value(&chars, &mut index, &mut args, "-O value")?;
                    sort_order = Some(parse_sort_order(kind, &value)?);
                    break;
                }
                'r' => reversed = true,
                's' => tree_depth = TreeDepth::Session,
                'w' => tree_depth = TreeDepth::Window,
                'y' => {
                    return Err(TerminalError::Server(format!(
                        "unsupported flag '-y' for {}",
                        command.name()
                    )));
                }
                'Z' => zoom = true,
                't' => {
                    target = Some(inline_flag_value(
                        &chars,
                        &mut index,
                        &mut args,
                        "-t target",
                    )?);
                    break;
                }
                other => {
                    return Err(TerminalError::Server(format!(
                        "unsupported flag '-{other}' for {}",
                        command.name()
                    )));
                }
            }
            index += 1;
        }
    }

    let template = if args.is_empty() {
        None
    } else {
        Some(join_command_arguments(&mut args, "mode-tree template")?)
    };

    if let Some(extra) = args.front() {
        return Err(TerminalError::Server(format!(
            "unexpected argument '{}' for {}",
            command_argument_for_error(extra),
            command.name()
        )));
    }

    Ok(Some(ParsedModeTreeCommand {
        kind,
        target,
        preview_mode: preview_state,
        row_format,
        filter_format,
        key_format,
        template,
        sort_order,
        reversed,
        tree_depth,
        show_all_group_members,
        auto_accept,
        zoom,
    }))
}

pub(super) fn default_order_seq(kind: ModeTreeKind) -> Vec<SortOrder> {
    match kind {
        ModeTreeKind::Tree => vec![SortOrder::Index, SortOrder::Name, SortOrder::Activity],
    }
}

fn parse_sort_order(kind: ModeTreeKind, value: &str) -> Result<SortOrder, TerminalError> {
    let lowered = value.to_ascii_lowercase();
    let order = match lowered.as_str() {
        "index" | "order" => SortOrder::Index,
        "name" | "title" => SortOrder::Name,
        "activity" => SortOrder::Activity,
        "creation" => SortOrder::Creation,
        "size" => SortOrder::Size,
        _ => {
            return Err(TerminalError::Server(format!(
                "invalid sort order: {value}"
            )))
        }
    };
    if default_order_seq(kind).contains(&order) {
        Ok(order)
    } else {
        Err(TerminalError::Server(format!(
            "invalid sort order: {value}"
        )))
    }
}

fn pop_string_argument(
    args: &mut VecDeque<CommandArgument>,
    what: &str,
) -> Result<String, TerminalError> {
    let argument = args
        .pop_front()
        .ok_or_else(|| TerminalError::Server(format!("missing {what}")))?;
    argument
        .as_string()
        .map(str::to_owned)
        .ok_or_else(|| TerminalError::Server(format!("invalid {what}")))
}

fn inline_flag_value(
    chars: &[char],
    index: &mut usize,
    args: &mut VecDeque<CommandArgument>,
    what: &str,
) -> Result<String, TerminalError> {
    if *index + 1 < chars.len() {
        Ok(chars[*index + 1..].iter().collect())
    } else {
        pop_string_argument(args, what)
    }
}

fn join_command_arguments(
    args: &mut VecDeque<CommandArgument>,
    what: &str,
) -> Result<String, TerminalError> {
    if args.is_empty() {
        return Err(TerminalError::Server(format!("missing {what}")));
    }
    Ok(args
        .drain(..)
        .map(|argument| argument.to_tmux_string())
        .collect::<Vec<_>>()
        .join(" "))
}

fn command_argument_for_error(argument: &CommandArgument) -> String {
    argument.to_tmux_string()
}
