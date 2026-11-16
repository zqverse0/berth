use berth_term_proto::request::DetachClientExtRequest;
use berth_term_proto::{Request, TerminalError};

use super::parse_session_name;
use super::tokens::CommandTokens;
use super::values::unsupported_flag;

pub(super) fn parse_detach_client(mut args: CommandTokens) -> Result<Request, TerminalError> {
    let mut target_client = None;
    let mut all_other_clients = false;
    let mut target_session = None;
    let mut kill_on_detach = false;
    let mut exec_command = None;

    while let Some(token) = args.peek() {
        match token {
            "--" => {
                let _ = args.optional();
                break;
            }
            "-a" => {
                let _ = args.optional();
                all_other_clients = true;
            }
            "-E" => {
                let _ = args.optional();
                exec_command = Some(args.required("-E shell-command")?);
            }
            "-P" => {
                let _ = args.optional();
                kill_on_detach = true;
            }
            "-s" => {
                let _ = args.optional();
                target_session = Some(parse_session_name(args.required("-s target-session")?)?);
            }
            "-t" => {
                let _ = args.optional();
                target_client = Some(args.required("-t target-client")?);
            }
            flag if flag.starts_with('-') => return Err(unsupported_flag("detach-client", flag)),
            _ => break,
        }
    }
    args.no_extra("detach-client")?;
    Ok(Request::DetachClientExt(DetachClientExtRequest {
        target_client,
        all_other_clients,
        target_session,
        kill_on_detach,
        exec_command,
    }))
}
