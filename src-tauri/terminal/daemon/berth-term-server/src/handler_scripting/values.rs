use berth_term_proto::TerminalError;

pub(super) fn parse_usize(command: &str, flag: &str, value: &str) -> Result<usize, TerminalError> {
    value.parse::<usize>().map_err(|error| {
        TerminalError::Server(format!(
            "{command} {flag} expects an unsigned integer: {error}"
        ))
    })
}

pub(super) fn parse_u16(command: &str, flag: &str, value: &str) -> Result<u16, TerminalError> {
    value.parse().map_err(|error| {
        TerminalError::Server(format!(
            "{command} {flag} expects an unsigned 16-bit integer: {error}"
        ))
    })
}

pub(super) fn parse_u32(command: &str, flag: &str, value: &str) -> Result<u32, TerminalError> {
    value.parse().map_err(|error| {
        TerminalError::Server(format!(
            "{command} {flag} expects an unsigned 32-bit integer: {error}"
        ))
    })
}

pub(super) fn parse_u64(command: &str, flag: &str, value: &str) -> Result<u64, TerminalError> {
    value.parse().map_err(|error| {
        TerminalError::Server(format!(
            "{command} {flag} expects an unsigned 64-bit integer: {error}"
        ))
    })
}

pub(super) fn parse_percentage(
    command: &str,
    flag: &str,
    value: &str,
) -> Result<u8, TerminalError> {
    let percentage = value.parse::<u8>().map_err(|error| {
        TerminalError::Server(format!("{command} {flag} expects a percentage: {error}"))
    })?;
    if percentage > 100 {
        return Err(TerminalError::Server(format!(
            "{command} {flag} expects a percentage between 0 and 100"
        )));
    }
    Ok(percentage)
}

pub(super) fn parse_f64(command: &str, flag: &str, value: &str) -> Result<f64, TerminalError> {
    value.parse().map_err(|error| {
        TerminalError::Server(format!(
            "{command} {flag} expects a floating-point number: {error}"
        ))
    })
}

pub(super) fn parse_non_negative_f64(
    command: &str,
    flag: &str,
    value: &str,
) -> Result<f64, TerminalError> {
    let parsed = parse_f64(command, flag, value)?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(TerminalError::Server(format!(
            "{command} {flag} expects a non-negative finite delay"
        )));
    }
    Ok(parsed)
}

pub(super) fn missing_argument(command: &str, argument: &str) -> TerminalError {
    TerminalError::Server(format!("{command} requires {argument}"))
}

pub(super) fn unsupported_flag(command: &str, flag: &str) -> TerminalError {
    TerminalError::Server(format!("command {command}: unknown flag {flag}"))
}
