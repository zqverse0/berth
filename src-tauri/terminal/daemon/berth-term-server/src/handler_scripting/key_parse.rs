use berth_term_proto::{Request, SendKeysRequest, TerminalError};

use super::parse_pane_target;
use super::tokens::CommandTokens;
use super::values::{missing_argument, parse_usize, unsupported_flag};

pub(super) fn parse_send_keys(mut args: CommandTokens) -> Result<Request, TerminalError> {
    let mut target = None;
    let mut target_client = None;
    let mut expand_formats = false;
    let mut hex = false;
    let mut literal = false;
    let mut dispatch_key_table = false;
    let mut copy_mode_command = false;
    let mut forward_mouse_event = false;
    let mut reset_terminal = false;
    let mut repeat_count = None;

    while let Some(token) = args.peek().map(str::to_owned) {
        if let Some(flags) = args.optional_compact_flags("FHlKMRX") {
            for flag in flags {
                match flag {
                    'F' => expand_formats = true,
                    'H' => hex = true,
                    'l' => literal = true,
                    'K' => dispatch_key_table = true,
                    'M' => forward_mouse_event = true,
                    'R' => reset_terminal = true,
                    'X' => copy_mode_command = true,
                    _ => unreachable!("compact send-keys flags are prevalidated"),
                }
            }
            continue;
        }
        match token.as_str() {
            "--" => {
                let _ = args.optional();
                break;
            }
            "-F" => {
                let _ = args.optional();
                expand_formats = true;
            }
            "-H" => {
                let _ = args.optional();
                hex = true;
            }
            "-l" => {
                let _ = args.optional();
                literal = true;
            }
            "-K" => {
                let _ = args.optional();
                dispatch_key_table = true;
            }
            "-M" => {
                let _ = args.optional();
                forward_mouse_event = true;
            }
            "-N" => {
                let _ = args.optional();
                repeat_count = Some(parse_send_keys_repeat_count(&args.required("-N count")?)?);
            }
            "-p" => return Err(unsupported_flag("send-keys", "-p")),
            value if value.starts_with("-N") && value.len() > 2 => {
                let count = value[2..].to_owned();
                let _ = args.optional();
                repeat_count = Some(parse_send_keys_repeat_count(&count)?);
            }
            "-R" => {
                let _ = args.optional();
                reset_terminal = true;
            }
            "-X" => {
                let _ = args.optional();
                copy_mode_command = true;
            }
            "-c" => {
                let _ = args.optional();
                target_client = Some(args.required("-c target-client")?);
            }
            "-t" => {
                let _ = args.optional();
                target = Some(parse_pane_target("send-keys", args.required("-t target")?)?);
            }
            _ => break,
        }
    }

    let keys = args.remaining();
    if target.is_some()
        && !expand_formats
        && !hex
        && !literal
        && !dispatch_key_table
        && !copy_mode_command
        && !forward_mouse_event
        && !reset_terminal
        && repeat_count.is_none()
        && target_client.is_none()
    {
        return Ok(Request::SendKeys(SendKeysRequest {
            target: target.ok_or_else(|| missing_argument("send-keys", "-t target"))?,
            keys,
        }));
    }

    if target_client.is_some() {
        return Ok(Request::SendKeysExt2(Box::new(
            berth_term_proto::SendKeysExt2Request {
                target,
                keys,
                expand_formats,
                hex,
                literal,
                dispatch_key_table,
                copy_mode_command,
                forward_mouse_event,
                reset_terminal,
                repeat_count,
                target_client,
            },
        )));
    }

    Ok(Request::SendKeysExt(berth_term_proto::SendKeysExtRequest {
        target,
        keys,
        expand_formats,
        hex,
        literal,
        dispatch_key_table,
        copy_mode_command,
        forward_mouse_event,
        reset_terminal,
        repeat_count,
    }))
}

fn parse_send_keys_repeat_count(value: &str) -> Result<usize, TerminalError> {
    let count = parse_usize("send-keys", "-N", value)?;
    if count == 0 {
        return Err(TerminalError::Message("repeat count too small".to_owned()));
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(value: &str) -> String {
        value.to_owned()
    }

    #[test]
    fn parse_send_keys_accepts_tmux_compact_repeat_count() {
        let request = parse_send_keys(CommandTokens::new(vec![
            token("-N5"),
            token("-X"),
            token("scroll-up"),
        ]))
        .expect("compact repeat send-keys parses");

        let Request::SendKeysExt(request) = request else {
            panic!("compact repeat must use extended send-keys request");
        };
        assert_eq!(request.repeat_count, Some(5));
        assert!(request.copy_mode_command);
        assert_eq!(request.keys, vec!["scroll-up"]);
    }

    #[test]
    fn parse_send_keys_rejects_zero_repeat_count() {
        let error = parse_send_keys(CommandTokens::new(vec![token("-N0"), token("A")]))
            .expect_err("send-keys -N0 must reject zero repeats");

        assert_eq!(error.to_string(), "repeat count too small");
    }

    #[test]
    fn parse_send_keys_rejects_unknown_prefix_flag() {
        let error = parse_send_keys(CommandTokens::new(vec![token("-p"), token("abc")]))
            .expect_err("send-keys -p should be rejected before keys");

        assert_eq!(
            error,
            TerminalError::Server("command send-keys: unknown flag -p".to_owned())
        );
    }
}
