use std::path::PathBuf;

use berth_term_engine::{SessionStore, TargetFindContext};
use berth_term_proto::{
    KillPaneRequest, Request, RespawnPaneRequest, SelectPaneAdjacentRequest, SelectPaneDirection,
    SelectPaneMarkRequest, SelectPaneRequest, SplitDirection, SplitWindowExtRequest,
    SplitWindowRequest, TerminalError,
};

use super::tokens::{parse_compact_flag_cluster, CommandTokens, CompactFlag};
use super::values::{parse_percentage, removed_option, unsupported_flag};
use super::{
    implicit_pane_target, implicit_split_target, parse_pane_target, parse_split_window_target,
};

const DEFAULT_SPLIT_WINDOW_PRINT_FORMAT: &str = "#{session_name}:#{window_index}.#{pane_index}";

#[path = "pane_parse/join_move.rs"]
mod join_move;

#[derive(Debug, Clone)]
pub(super) struct ParsedSplitWindowCommand {
    pub(super) request: Request,
    pub(super) print_target: bool,
    pub(super) format: String,
}

pub(super) fn parse_pane_request(
    mut args: CommandTokens,
    command: &str,
    sessions: &SessionStore,
    find_context: &TargetFindContext,
) -> Result<Request, TerminalError> {
    let mut target = None;
    let mut kill_all_except = false;

    while let Some(token) = args.peek() {
        match token {
            "--" => {
                let _ = args.optional();
                break;
            }
            "-a" if command == "kill-pane" => {
                let _ = args.optional();
                kill_all_except = true;
            }
            "-t" => {
                let _ = args.optional();
                target = Some(parse_pane_target(command, args.required("-t target")?)?);
            }
            token => {
                let Some(cluster) = parse_compact_flag_cluster(token, "a", "t") else {
                    break;
                };
                let _ = args.optional();
                for flag in cluster {
                    match flag {
                        CompactFlag::Bare('a') if command == "kill-pane" => {
                            kill_all_except = true;
                        }
                        CompactFlag::Bare(flag) => {
                            return Err(unsupported_flag(command, &format!("-{flag}")));
                        }
                        compact_flag @ CompactFlag::Value { flag: 't', .. } => {
                            target = Some(parse_pane_target(
                                command,
                                compact_flag.value_or_next(&mut args, "-t target")?,
                            )?);
                        }
                        CompactFlag::Value { flag, .. } => {
                            return Err(unsupported_flag(command, &format!("-{flag}")));
                        }
                    }
                }
            }
        }
    }
    args.no_extra(command)?;

    let target = target.unwrap_or(implicit_pane_target(sessions, find_context, command)?);
    match command {
        "kill-pane" => Ok(Request::KillPane(KillPaneRequest {
            target,
            kill_all_except,
        })),
        _ => Err(TerminalError::Server(format!(
            "unsupported pane request parser command: {command}"
        ))),
    }
}

pub(super) fn parse_select_pane(
    mut args: CommandTokens,
    sessions: &SessionStore,
    find_context: &TargetFindContext,
) -> Result<Request, TerminalError> {
    let mut target = None;
    let mut mark = false;
    let mut clear_marked = false;
    let mut title = None;
    let mut style = None;
    let mut direction = None;
    let mut last = false;
    let mut input_disabled = None;
    let mut preserve_zoom = false;

    while let Some(token) = args.peek() {
        match token {
            "--" => {
                let _ = args.optional();
                break;
            }
            "-t" => {
                let _ = args.optional();
                target = Some(parse_pane_target(
                    "select-pane",
                    args.required("-t target")?,
                )?);
            }
            "-m" => {
                let _ = args.optional();
                mark = true;
            }
            "-M" => {
                let _ = args.optional();
                clear_marked = true;
            }
            "-l" => {
                let _ = args.optional();
                last = true;
            }
            "-Z" => {
                let _ = args.optional();
                preserve_zoom = true;
            }
            "-d" => {
                let _ = args.optional();
                input_disabled = Some(true);
            }
            "-e" => {
                let _ = args.optional();
                input_disabled = Some(false);
            }
            "-T" => {
                let _ = args.optional();
                title = Some(args.required("-T title")?.to_owned());
            }
            "-P" => {
                let _ = args.optional();
                style = Some(args.required("-P style")?.to_owned());
            }
            "-U" => {
                let _ = args.optional();
                direction = Some(SelectPaneDirection::Up);
            }
            "-D" => {
                let _ = args.optional();
                direction = Some(SelectPaneDirection::Down);
            }
            "-L" => {
                let _ = args.optional();
                direction = Some(SelectPaneDirection::Left);
            }
            "-R" => {
                let _ = args.optional();
                direction = Some(SelectPaneDirection::Right);
            }
            _ => break,
        }
    }
    args.no_extra("select-pane")?;

    if mark && clear_marked {
        return Err(TerminalError::Server(
            "select-pane flags -m and -M cannot be used together".to_owned(),
        ));
    }
    if direction.is_some() && (mark || clear_marked || title.is_some()) {
        return Err(TerminalError::Server(
            "select-pane -U/-D/-L/-R cannot be combined with -m, -M, or -T".to_owned(),
        ));
    }
    if style.is_some() && (direction.is_some() || last || mark || clear_marked) {
        return Err(TerminalError::Server(
            "select-pane -P cannot be combined with -U, -D, -L, -R, -l, -m, or -M".to_owned(),
        ));
    }
    if last && (direction.is_some() || mark || clear_marked) {
        return Err(TerminalError::Server(
            "select-pane -l cannot be combined with -U, -D, -L, -R, -m, or -M".to_owned(),
        ));
    }

    let target = match target {
        Some(target) => target,
        None => implicit_pane_target(sessions, find_context, "select-pane")?,
    };

    if last {
        Err(removed_option("select-pane -l"))
    } else if let Some(direction) = direction {
        Ok(Request::SelectPaneAdjacent(SelectPaneAdjacentRequest {
            target,
            direction,
            preserve_zoom,
        }))
    } else if mark || clear_marked {
        Ok(Request::SelectPaneMark(SelectPaneMarkRequest {
            target,
            clear: clear_marked,
            title,
        }))
    } else {
        Ok(Request::SelectPane(Box::new(SelectPaneRequest {
            target,
            title,
            style,
            input_disabled,
            preserve_zoom,
        })))
    }
}

pub(super) fn parse_split_window(
    args: CommandTokens,
    sessions: &SessionStore,
    find_context: &TargetFindContext,
) -> Result<Request, TerminalError> {
    parse_split_window_command(args, sessions, find_context, false).map(|command| command.request)
}

pub(super) fn parse_queued_split_window(
    args: CommandTokens,
    sessions: &SessionStore,
    find_context: &TargetFindContext,
) -> Result<ParsedSplitWindowCommand, TerminalError> {
    parse_split_window_command(args, sessions, find_context, true)
}

fn parse_split_window_command(
    mut args: CommandTokens,
    sessions: &SessionStore,
    find_context: &TargetFindContext,
    allow_print_flags: bool,
) -> Result<ParsedSplitWindowCommand, TerminalError> {
    let mut direction = SplitDirection::Vertical;
    let mut direction_set = false;
    let mut before = false;
    let mut environment = Vec::new();
    let mut target = None;
    let mut start_directory: Option<std::path::PathBuf> = None;
    let mut detached = false;
    let mut size = None;
    let mut full_size = false;
    let mut preserve_zoom = false;
    let mut print_target = false;
    let mut format = None;

    while let Some(token) = args.peek() {
        match token {
            "--" => {
                let _ = args.optional();
                break;
            }
            "-h" => {
                let _ = args.optional();
                if direction_set {
                    return Err(TerminalError::Server(
                        "split-window accepts only one of -h or -v".to_owned(),
                    ));
                }
                direction = SplitDirection::Horizontal;
                direction_set = true;
            }
            "-v" => {
                let _ = args.optional();
                if direction_set {
                    return Err(TerminalError::Server(
                        "split-window accepts only one of -h or -v".to_owned(),
                    ));
                }
                direction = SplitDirection::Vertical;
                direction_set = true;
            }
            "-b" => {
                let _ = args.optional();
                before = true;
            }
            "-d" => {
                let _ = args.optional();
                detached = true;
            }
            "-f" => {
                let _ = args.optional();
                full_size = true;
            }
            "-Z" => {
                let _ = args.optional();
                preserve_zoom = true;
            }
            "-l" => {
                let _ = args.optional();
                size = Some(args.required("-l size")?);
            }
            "-p" => {
                let _ = args.optional();
                let percentage =
                    parse_percentage("split-window", "-p", &args.required("-p size")?)?;
                size = Some(format!("{percentage}%"));
            }
            "-P" if allow_print_flags => {
                let _ = args.optional();
                print_target = true;
            }
            "-F" if allow_print_flags => {
                let _ = args.optional();
                format = Some(args.required("-F format")?);
            }
            "-F" | "-I" | "-P" => {
                return Err(unsupported_flag("split-window", token));
            }
            "-c" => {
                let _ = args.optional();
                start_directory = Some(std::path::PathBuf::from(
                    args.required("-c start-directory")?,
                ));
            }
            "-t" => {
                let _ = args.optional();
                target = Some(parse_split_window_target(args.required("-t target")?)?);
            }
            "-e" => {
                let _ = args.optional();
                environment.push(args.required("-e name=value")?);
            }
            _ => break,
        }
    }
    let command = (!args.is_empty()).then_some(args.remaining());
    let target = target.unwrap_or(implicit_split_target(
        sessions,
        find_context,
        "split-window",
    )?);

    let request = if command.is_some()
        || start_directory.is_some()
        || detached
        || size.is_some()
        || full_size
        || preserve_zoom
    {
        Request::SplitWindowExt(Box::new(SplitWindowExtRequest {
            target,
            direction,
            before,
            environment: (!environment.is_empty()).then_some(environment),
            command,
            process_command: None,
            start_directory,
            keep_alive_on_exit: None,
            detached,
            size,
            preserve_zoom,
            full_size,
            stdin_payload: None,
        }))
    } else {
        Request::SplitWindow(SplitWindowRequest {
            target,
            direction,
            before,
            environment: (!environment.is_empty()).then_some(environment),
        })
    };

    Ok(ParsedSplitWindowCommand {
        request,
        print_target,
        format: format.unwrap_or_else(|| DEFAULT_SPLIT_WINDOW_PRINT_FORMAT.to_owned()),
    })
}

pub(super) fn parse_respawn_pane(
    mut args: CommandTokens,
    sessions: &SessionStore,
    find_context: &TargetFindContext,
) -> Result<Request, TerminalError> {
    let mut target = None;
    let mut kill = false;
    let mut start_directory = None;
    let mut environment = Vec::new();

    while let Some(token) = args.peek() {
        match token {
            "--" => {
                let _ = args.optional();
                break;
            }
            "-c" => {
                let _ = args.optional();
                start_directory = Some(PathBuf::from(args.required("-c start-directory")?));
            }
            "-e" => {
                let _ = args.optional();
                environment.push(args.required("-e environment")?);
            }
            "-k" => {
                let _ = args.optional();
                kill = true;
            }
            "-t" => {
                let _ = args.optional();
                target = Some(parse_pane_target(
                    "respawn-pane",
                    args.required("-t target")?,
                )?);
            }
            _ => break,
        }
    }

    let command = {
        let remaining = args.remaining();
        (!remaining.is_empty()).then_some(remaining)
    };

    Ok(Request::RespawnPane(Box::new(RespawnPaneRequest {
        target: target.unwrap_or(implicit_pane_target(
            sessions,
            find_context,
            "respawn-pane",
        )?),
        kill,
        start_directory,
        environment: (!environment.is_empty()).then_some(environment),
        command,
        process_command: None,
    })))
}
