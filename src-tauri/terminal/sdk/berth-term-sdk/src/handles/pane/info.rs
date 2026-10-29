use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::handles::session::unexpected_response;
use crate::transport::TransportClient;
use crate::{
    InfoSnapshot, PaneAgentSignal, PaneExitState, PaneId, PaneInfo, PaneProcessState, PaneRef,
    Result, SessionId, SessionInfo, TerminalError, TerminalSizeSpec, WindowId, WindowInfo,
};
use berth_term_proto::{
    DisplayMessageRequest, ListPanesRequest, ListSessionsRequest, ListWindowsRequest,
    PaneBindingFailure, Request, Response, Target,
};

use super::target::{is_already_closed_error, parse_error};

const SESSION_INFO_FORMAT: &str =
    "#{session_name}\t#{session_id}\t#{session_path}\t#{session_attached}";
const PANE_LIST_FORMAT: &str = "#{window_index}:#{pane_index}:#{pane_id}";
const PANE_INFO_FORMAT: &str =
    "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\
     \t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\
     \t#{cursor_shape}\t#{history_bytes}\t#{history_size}\t#{pane_start_command}\
     \t#{pane_lifecycle_generation}\t#{pane_lifecycle_revision}\t#{pane_output_sequence}\
     \t#{pane_agent_state}\t#{pane_agent_state_time}\t#{pane_pb_state}\t#{pane_pb_progress}\
     \t#{pane_agent_notification}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_start_path}";

#[derive(Debug, Clone)]
pub(super) struct ListedPane {
    pub(super) window_index: u32,
    pub(super) pane_index: u32,
    pub(super) pane_id: PaneId,
}

#[derive(Debug, Clone)]
struct ListedSession {
    name: berth_term_proto::SessionName,
    id: SessionId,
    working_directory: Option<String>,
    attached_clients: u32,
}

impl ListedSession {
    fn into_info(self) -> SessionInfo {
        let mut info = SessionInfo::new(self.id, self.name);
        info.working_directory = self.working_directory;
        info.attached_clients = self.attached_clients;
        info
    }
}

#[derive(Debug, Clone)]
struct ListedWindow {
    index: u32,
    id: WindowId,
    name: Option<String>,
    size: TerminalSizeSpec,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct LiveDetails {
    pub(super) pane_id: Option<PaneId>,
    pub(super) pid: Option<u32>,
    pub(super) dead: bool,
    pub(super) dead_status: Option<i32>,
    pub(super) dead_signal: Option<i32>,
    pub(super) cols: u16,
    pub(super) rows: u16,
    pub(super) cursor_x: u16,
    pub(super) cursor_y: u16,
    pub(super) cursor_visible: bool,
    pub(super) cursor_style: u32,
    pub(super) history_bytes: u64,
    pub(super) history_size: u64,
    pub(super) start_command: Option<Vec<String>>,
    pub(super) generation: u64,
    pub(super) lifecycle_revision: u64,
    pub(super) output_sequence: u64,
    pub(super) agent: PaneAgentSignal,
    pub(super) current_path: Option<String>,
    pub(super) foreground_command: Option<String>,
    pub(super) foreground_path: Option<String>,
}

pub(super) async fn pane_info_snapshot(
    client: &TransportClient,
    target: &PaneRef,
    guarded_pane_id: Option<PaneId>,
) -> Result<InfoSnapshot> {
    let parents = session_info_snapshot(client, &target.session_name).await?;
    pane_info_snapshot_with_parents(client, target, guarded_pane_id, &parents).await
}

// 仅在一次查询内复用父元数据；不缓存到句柄或 transport。
pub(crate) async fn session_info_snapshot(
    client: &TransportClient,
    session_name: &berth_term_proto::SessionName,
) -> Result<InfoSnapshot> {
    let session = match current_session_info(client, session_name).await? {
        Some(session) => session.into_info(),
        None => return Ok(InfoSnapshot::default()),
    };
    let windows = match list_window_entries(client, session_name).await {
        Ok(windows) => windows,
        Err(error)
            if is_already_closed_error(&error, &PaneRef::new(session_name.clone(), 0, 0)) =>
        {
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    let windows = windows
        .into_iter()
        .map(|window| WindowInfo {
            index: window.index,
            name: window.name,
            size: window.size,
            ..WindowInfo::new(window.id, session.id)
        })
        .collect();
    Ok(InfoSnapshot::new(vec![session], windows, Vec::new()))
}

pub(crate) async fn pane_info_snapshot_with_parents(
    client: &TransportClient,
    target: &PaneRef,
    guarded_pane_id: Option<PaneId>,
    parents: &InfoSnapshot,
) -> Result<InfoSnapshot> {
    let Some(session) = parents
        .sessions
        .iter()
        .find(|session| session.name == target.session_name)
    else {
        return Ok(InfoSnapshot::default());
    };
    let Some(window) = parents
        .windows
        .iter()
        .find(|window| window.session_id == session.id && window.index == target.window_index)
    else {
        return Ok(InfoSnapshot::new(
            vec![session.clone()],
            Vec::new(),
            Vec::new(),
        ));
    };

    // 已知稳定 ID 时不重复 list-panes；每条详情仍核对实体身份，
    // 不能让发现期间复用的槽位把另一 pane 的内容混进库存。
    let pane_id = match guarded_pane_id {
        Some(pane_id) => pane_id,
        None => {
            let Some(pane) = current_pane_entry(client, target).await? else {
                return Ok(InfoSnapshot::new(
                    vec![session.clone()],
                    vec![window.clone()],
                    Vec::new(),
                ));
            };
            pane.pane_id
        }
    };

    let details = fetch_live_details_or_default(client, target).await?;
    if let Some(expected) = guarded_pane_id {
        verify_guarded_details_pane_id(expected, pane_id, &details)?;
    }
    let mut pane_info = PaneInfo::new(pane_id, window.id, session.id);
    pane_info.index = target.pane_index;
    pane_info.size = pane_size_from_details(&details, &window.size);
    pane_info.process = derive_process_state(&details);
    pane_info.exit_state = derive_exit_state(&details);
    pane_info.command = details.start_command.clone();
    pane_info.working_directory = details.current_path.clone();
    pane_info.foreground_command = details.foreground_command.clone();
    pane_info.foreground_path = details.foreground_path.clone();
    pane_info.generation = details.generation;
    pane_info.revision = if details.lifecycle_revision == 0 {
        revision_from_details(&details)
    } else {
        details.lifecycle_revision
    };
    pane_info.output_sequence = details.output_sequence;
    pane_info.agent = details.agent.clone();

    Ok(InfoSnapshot::new(
        vec![session.clone()],
        vec![window.clone()],
        vec![pane_info],
    ))
}

pub(super) fn verify_guarded_details_pane_id(
    expected: PaneId,
    listed: PaneId,
    details: &LiveDetails,
) -> Result<()> {
    if listed == expected && details.pane_id == Some(expected) {
        return Ok(());
    }
    Err(TerminalError::protocol(
        berth_term_proto::TerminalError::pane_binding_invalid(PaneBindingFailure::StalePane),
    ))
}

pub(super) fn pane_size_from_details(
    details: &LiveDetails,
    fallback: &TerminalSizeSpec,
) -> TerminalSizeSpec {
    if details.cols == 0 && details.rows == 0 {
        // A zero size here means the detail probe yielded no usable pane
        // dimensions (for example, the pane vanished after list-panes saw it).
        // Preserve the already-listed parent window size rather than
        // publishing a synthetic 0x0 pane in the sticky info snapshot.
        *fallback
    } else {
        TerminalSizeSpec::new(details.cols, details.rows)
    }
}

pub(super) fn derive_process_state(details: &LiveDetails) -> PaneProcessState {
    if details.dead {
        PaneProcessState::Exited
    } else if let Some(pid) = details.pid {
        PaneProcessState::Running { pid: Some(pid) }
    } else {
        PaneProcessState::Unknown
    }
}

pub(super) fn derive_exit_state(details: &LiveDetails) -> Option<PaneExitState> {
    if !details.dead {
        return None;
    }
    Some(PaneExitState {
        code: details.dead_status,
        signal: details.dead_signal.filter(|signal| *signal != 0),
        message: None,
    })
}

pub(super) fn revision_from_details(details: &LiveDetails) -> u64 {
    let mut hasher = DefaultHasher::new();
    details.pane_id.hash(&mut hasher);
    details.dead.hash(&mut hasher);
    details.dead_status.hash(&mut hasher);
    details.dead_signal.hash(&mut hasher);
    details.history_bytes.hash(&mut hasher);
    details.history_size.hash(&mut hasher);
    details.start_command.hash(&mut hasher);
    details.generation.hash(&mut hasher);
    details.lifecycle_revision.hash(&mut hasher);
    details.output_sequence.hash(&mut hasher);
    details.cols.hash(&mut hasher);
    details.rows.hash(&mut hasher);
    details.cursor_x.hash(&mut hasher);
    details.cursor_y.hash(&mut hasher);
    let raw = hasher.finish();
    if raw == 0 {
        1
    } else {
        raw
    }
}

async fn current_session_info(
    client: &TransportClient,
    session_name: &berth_term_proto::SessionName,
) -> Result<Option<ListedSession>> {
    let response = client
        .request(Request::ListSessions(ListSessionsRequest {
            format: Some(SESSION_INFO_FORMAT.to_owned()),
            filter: None,
            sort_order: Some("name".to_owned()),
            reversed: false,
        }))
        .await?;

    let output = match response {
        Response::ListSessions(response) => response.output.stdout,
        response => return Err(unexpected_response("list-sessions", response)),
    };

    for line in String::from_utf8_lossy(&output).lines() {
        let session = parse_session_line(line)?;
        if &session.name == session_name {
            return Ok(Some(session));
        }
    }

    Ok(None)
}

async fn list_window_entries(
    client: &TransportClient,
    session_name: &berth_term_proto::SessionName,
) -> Result<Vec<ListedWindow>> {
    match client
        .request(Request::ListWindows(ListWindowsRequest {
            target: session_name.clone(),
            format: None,
        }))
        .await?
    {
        Response::ListWindows(response) => response
            .windows
            .into_iter()
            .map(|entry| {
                Ok(ListedWindow {
                    index: entry.target.window_index(),
                    id: parse_window_id(&entry.window_id)?,
                    name: entry.name,
                    size: entry.size.into(),
                })
            })
            .collect(),
        response => Err(unexpected_response("list-windows", response)),
    }
}

pub(super) async fn current_pane_entry(
    client: &TransportClient,
    target: &PaneRef,
) -> Result<Option<ListedPane>> {
    match list_window_pane_entries(client, target).await {
        Ok(entries) => Ok(entries.into_iter().find(|entry| {
            entry.window_index == target.window_index && entry.pane_index == target.pane_index
        })),
        Err(error) if is_already_closed_error(&error, target) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) async fn current_pane_ref_for_id(
    client: &TransportClient,
    session_name: &berth_term_proto::SessionName,
    pane_id: PaneId,
) -> Result<Option<PaneRef>> {
    let target = PaneRef::new(session_name.clone(), 0, 0);
    match list_all_pane_entries(client, &target).await {
        Ok(entries) => Ok(entries
            .into_iter()
            .find(|entry| entry.pane_id == pane_id)
            .map(|entry| PaneRef::new(session_name.clone(), entry.window_index, entry.pane_index))),
        Err(error) if is_already_closed_error(&error, &target) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn list_window_pane_entries(
    client: &TransportClient,
    target: &PaneRef,
) -> Result<Vec<ListedPane>> {
    list_pane_entries(client, target, Some(target.window_index)).await
}

async fn list_all_pane_entries(
    client: &TransportClient,
    target: &PaneRef,
) -> Result<Vec<ListedPane>> {
    list_pane_entries(client, target, None).await
}

async fn list_pane_entries(
    client: &TransportClient,
    target: &PaneRef,
    target_window_index: Option<u32>,
) -> Result<Vec<ListedPane>> {
    let response = client
        .request(Request::ListPanes(ListPanesRequest {
            target: target.session_name.clone(),
            target_window_index,
            format: Some(PANE_LIST_FORMAT.to_owned()),
        }))
        .await?;

    let output = match response {
        Response::ListPanes(response) => response.output.stdout,
        response => return Err(unexpected_response("list-panes", response)),
    };

    String::from_utf8_lossy(&output)
        .lines()
        .map(parse_pane_list_line)
        .collect()
}

pub(super) async fn fetch_live_details_or_default(
    client: &TransportClient,
    target: &PaneRef,
) -> Result<LiveDetails> {
    match fetch_live_details(client, target).await {
        Ok(details) => Ok(details),
        Err(error) if is_already_closed_error(&error, target) => Ok(LiveDetails::default()),
        Err(error) => Err(error),
    }
}

async fn fetch_live_details(client: &TransportClient, target: &PaneRef) -> Result<LiveDetails> {
    let response = client
        .request(Request::DisplayMessage(DisplayMessageRequest {
            target: Some(Target::Pane(target.into())),
            print: true,
            message: Some(PANE_INFO_FORMAT.to_owned()),
            empty_target_context: false,
        }))
        .await?;

    let output = match response {
        Response::DisplayMessage(response) => response.output,
        response => return Err(unexpected_response("display-message", response)),
    };

    let bytes = output.map(|out| out.stdout).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().next().unwrap_or("");
    parse_details_line(line)
}

pub(super) fn parse_details_line(line: &str) -> Result<LiveDetails> {
    if line.is_empty() {
        return Ok(LiveDetails::default());
    }
    // The trailing field is `#{pane_start_path}`, which is a filesystem
    // path. Tabs in such a path are valid bytes on Unix, so the parser
    // anchors the leading separators with `splitn` and treats the
    // remainder as the path verbatim instead of dropping characters past
    // an embedded tab.
    // OSC 字符串里的 C0（含制表符）被 termd 丢弃，通知文本不会含分隔符。
    // ponytail: 前台进程 cwd 不是末字段，含制表符的路径会错位；真遇到再给它单独一次查询。
    let fields: Vec<&str> = line.splitn(25, '\t').collect();
    if fields.len() < 25 {
        return Ok(LiveDetails::default());
    }

    Ok(LiveDetails {
        pane_id: parse_optional_pane_id(fields[0])?,
        pid: parse_optional_u32(fields[1]),
        dead: parse_truthy_flag(fields[2]),
        dead_status: parse_optional_i32(fields[3]),
        dead_signal: parse_optional_i32(fields[4]),
        cols: parse_optional_u16(fields[5]).unwrap_or(0),
        rows: parse_optional_u16(fields[6]).unwrap_or(0),
        cursor_x: parse_optional_u16(fields[7]).unwrap_or(0),
        cursor_y: parse_optional_u16(fields[8]).unwrap_or(0),
        cursor_visible: parse_truthy_flag_default(fields[9], true),
        cursor_style: parse_optional_u32(fields[10]).unwrap_or(0),
        history_bytes: parse_optional_u64(fields[11]).unwrap_or(0),
        history_size: parse_optional_u64(fields[12]).unwrap_or(0),
        start_command: decode_command_field(fields[13])?,
        generation: parse_optional_u64(fields[14]).unwrap_or(0),
        lifecycle_revision: parse_optional_u64(fields[15]).unwrap_or(0),
        output_sequence: parse_optional_u64(fields[16]).unwrap_or(0),
        agent: PaneAgentSignal {
            state: fields[17].to_owned(),
            changed_at: fields[18].parse().ok(),
            progress_state: fields[19].to_owned(),
            progress: fields[20].parse().unwrap_or(0),
            notification: fields[21].to_owned(),
        },
        foreground_command: optional_string(fields[22]),
        foreground_path: optional_string(fields[23]),
        current_path: optional_string(fields[24]),
    })
}

fn parse_session_line(line: &str) -> Result<ListedSession> {
    let mut fields = line.split('\t');
    let name = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted name"))?;
    let id = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted id"))?;
    let path = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted path"))?;
    let attached = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted attached count"))?;
    if fields.next().is_some() {
        return Err(parse_error("session info line had trailing fields"));
    }
    Ok(ListedSession {
        name: berth_term_proto::SessionName::new(name).map_err(TerminalError::protocol)?,
        id: parse_session_id(id)?,
        working_directory: optional_string(path),
        attached_clients: attached.parse::<u32>().map_err(|error| {
            parse_error(format!(
                "invalid session attached count `{attached}`: {error}"
            ))
        })?,
    })
}

fn parse_pane_list_line(line: &str) -> Result<ListedPane> {
    let mut fields = line.split(':');
    let window_index = fields
        .next()
        .ok_or_else(|| parse_error("pane list line omitted window index"))?;
    let pane_index = fields
        .next()
        .ok_or_else(|| parse_error("pane list line omitted pane index"))?;
    let pane_id = fields
        .next()
        .ok_or_else(|| parse_error("pane list line omitted pane id"))?;
    if fields.next().is_some() {
        return Err(parse_error("pane list line had trailing fields"));
    }

    let window_index = parse_u32(window_index, "pane list window index")?;
    Ok(ListedPane {
        window_index,
        pane_index: parse_u32(pane_index, "pane index")?,
        pane_id: parse_pane_id(pane_id)?,
    })
}

fn parse_session_id(value: &str) -> Result<SessionId> {
    parse_prefixed_u32(value, '$', "session id").map(SessionId::new)
}

fn parse_window_id(value: &str) -> Result<WindowId> {
    parse_prefixed_u32(value, '@', "window id").map(WindowId::new)
}

fn parse_pane_id(value: &str) -> Result<PaneId> {
    parse_prefixed_u32(value, '%', "pane id").map(PaneId::new)
}

fn parse_optional_pane_id(value: &str) -> Result<Option<PaneId>> {
    if value.is_empty() {
        Ok(None)
    } else {
        parse_pane_id(value).map(Some)
    }
}

fn parse_prefixed_u32(value: &str, prefix: char, field: &str) -> Result<u32> {
    let raw = value
        .strip_prefix(prefix)
        .ok_or_else(|| parse_error(format!("{field} `{value}` omitted `{prefix}` prefix")))?;
    parse_u32(raw, field)
}

fn parse_u32(value: &str, field: &str) -> Result<u32> {
    value
        .parse::<u32>()
        .map_err(|error| parse_error(format!("invalid {field} `{value}`: {error}")))
}

fn parse_truthy_flag(value: &str) -> bool {
    !value.is_empty() && value != "0"
}

fn parse_truthy_flag_default(value: &str, default: bool) -> bool {
    if value.is_empty() {
        default
    } else {
        value != "0"
    }
}

fn parse_optional_u16(value: &str) -> Option<u16> {
    if value.is_empty() {
        None
    } else {
        value.parse::<u16>().ok()
    }
}

fn parse_optional_u32(value: &str) -> Option<u32> {
    if value.is_empty() {
        None
    } else {
        value.parse::<u32>().ok()
    }
}

fn parse_optional_u64(value: &str) -> Option<u64> {
    if value.is_empty() {
        None
    } else {
        value.parse::<u64>().ok()
    }
}

fn parse_optional_i32(value: &str) -> Option<i32> {
    if value.is_empty() {
        None
    } else {
        value.parse::<i32>().ok()
    }
}

fn optional_string(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

fn decode_command_field(value: &str) -> Result<Option<Vec<String>>> {
    if value.is_empty() {
        return Ok(None);
    }
    let mut command = value
        .split('\x1f')
        .map(percent_decode_string)
        .collect::<Result<Vec<_>>>()?;
    if command.len() == 1 {
        command[0] = unquote_tmux_shell_command(&command[0]);
    }
    Ok(Some(command))
}

fn unquote_tmux_shell_command(value: &str) -> String {
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return value.to_owned();
    };
    let mut unquoted = String::with_capacity(inner.len());
    let mut escaped = false;
    for character in inner.chars() {
        if escaped {
            unquoted.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            unquoted.push(character);
        }
    }
    if escaped {
        unquoted.push('\\');
    }
    unquoted
}

fn percent_decode_string(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(parse_error("truncated percent escape in pane command"));
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded)
        .map_err(|error| parse_error(format!("pane command was not utf-8: {error}")))
}

fn hex_value(byte: u8) -> Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(parse_error(format!(
            "invalid percent escape digit `{}` in pane command",
            char::from(byte)
        ))),
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::parse_session_line;
    use crate::SessionId;

    #[test]
    fn parse_session_line_preserves_structured_project_metadata() {
        let session = parse_session_line("berth\t$7\t/home/project\t2").expect("parses");
        assert_eq!(session.name.as_str(), "berth");
        assert_eq!(session.id, SessionId::new(7));
        assert_eq!(session.working_directory.as_deref(), Some("/home/project"));
        assert_eq!(session.attached_clients, 2);
    }
}
