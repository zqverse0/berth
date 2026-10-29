//! SDK-side discovery helpers for existing terminal-managed terminals.
//!
//! Discovery is deliberately an inventory layer, not a metadata database.
//! It queries the daemon's current session and pane lists, enriches matches
//! through existing pane info/title accessors, and returns regular [`Pane`]
//! handles that callers can use immediately.
//!
//! P3 discovery is SDK-side and performs one or more daemon round-trips per
//! discovered pane. Scope queries with [`PaneFinder::session`] when possible
//! for large workspaces.

use std::collections::HashSet;

use crate::handles::session::unexpected_response;
use crate::handles::{pane_info_snapshot_with_parents, session_info_snapshot};
use crate::{
    Pane, PaneId, PaneInfo, PaneProcessState, PaneSet, Result, Session, SessionId, SessionName,
    Terminal, TerminalError, WindowId,
};
use berth_term_proto::{ListPanesRequest, Request, Response};

const PANE_DISCOVERY_FORMAT: &str = "#{window_index}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_left}:#{pane_top}:#{pane_width}:#{pane_height}";

/// Geometry of one pane in its Berth terminal window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PaneGeometry {
    /// Zero-based horizontal position within the window.
    pub left: u16,
    /// Zero-based vertical position within the window.
    pub top: u16,
    /// Pane width in terminal columns.
    pub width: u16,
    /// Pane height in terminal rows.
    pub height: u16,
}

/// One pane discovered from the daemon's current inventory.
#[derive(Debug, Clone)]
pub struct DiscoveredPane {
    /// Owning session name.
    pub session_name: SessionName,
    /// Owning session id.
    pub session_id: SessionId,
    /// Owning window id.
    pub window_id: WindowId,
    /// Current window index inside the owning session.
    pub window_index: u32,
    /// Stable daemon pane id.
    pub pane_id: PaneId,
    /// 与 pane 身份同次观测的进程代次，用于捕获运行绑定而不重复探测。
    pub generation: u64,
    /// Current pane index inside the owning window.
    pub pane_index: u32,
    /// Whether this pane is currently selected in its window.
    pub active: bool,
    /// Current pane geometry inside the owning window.
    pub geometry: PaneGeometry,
    /// Current pane title, when the daemon exposes one.
    pub title: Option<String>,
    /// Spawned process argv recorded by the daemon.
    pub command: Option<Vec<String>>,
    /// Process working directory recorded by the daemon.
    pub working_directory: Option<String>,
    /// Tags recorded on the pane/window/session info surfaces.
    pub tags: Vec<String>,
    /// Current pane process state.
    pub process: PaneProcessState,
    /// Stable pane handle addressed by pane id.
    pub pane: Pane,
}

/// One session discovered from the daemon inventory.
#[derive(Debug)]
pub struct DiscoveredSession {
    /// Session name.
    pub name: SessionName,
    /// Live session handle.
    pub session: Session,
}

/// Query builder for terminal-managed sessions.
#[derive(Debug)]
#[must_use = "session discovery queries do nothing unless all() or one() is awaited"]
pub struct SessionFinder<'a> {
    terminal: &'a Terminal,
    name: Option<String>,
}

impl<'a> SessionFinder<'a> {
    pub(crate) const fn new(terminal: &'a Terminal) -> Self {
        Self {
            terminal,
            name: None,
        }
    }

    /// Restricts discovery to one exact session name.
    pub fn name(mut self, name: impl AsRef<str>) -> Self {
        self.name = Some(name.as_ref().to_owned());
        self
    }

    /// Returns every session matching this query.
    pub async fn all(self) -> Result<Vec<DiscoveredSession>> {
        let names = match &self.name {
            Some(name) => {
                let name = SessionName::new(name).map_err(TerminalError::protocol)?;
                if self.terminal.has_session(name.clone()).await? {
                    vec![name]
                } else {
                    Vec::new()
                }
            }
            None => self.terminal.list_sessions().await?,
        };
        let mut sessions = Vec::new();
        for name in names {
            let session = self.terminal.session(name.clone()).await?;
            sessions.push(DiscoveredSession { name, session });
        }
        Ok(sessions)
    }

    /// Returns the single session matching this query.
    pub async fn one(self) -> Result<Session> {
        let matches = self.all().await?;
        match matches.len() {
            1 => Ok(matches
                .into_iter()
                .next()
                .expect("single match length guarantees one entry")
                .session),
            count => Err(TerminalError::protocol(
                berth_term_proto::TerminalError::Server(format!(
                    "strict session discovery violation: expected 1 match, found {count}"
                )),
            )),
        }
    }
}

/// Query builder for panes already managed by terminal.
#[derive(Debug)]
#[must_use = "pane discovery queries do nothing unless all(), one(), or collect_paneset() is awaited"]
pub struct PaneFinder<'a> {
    terminal: &'a Terminal,
    filters: PaneFilters,
}

#[derive(Debug, Default, Clone)]
struct PaneFilters {
    session: Option<String>,
    title: Option<String>,
    title_prefix: Option<String>,
    command_contains: Option<String>,
    cwd_contains: Option<String>,
    running: Option<bool>,
    window_index: Option<u32>,
}

impl<'a> PaneFinder<'a> {
    pub(crate) fn new(terminal: &'a Terminal) -> Self {
        Self {
            terminal,
            filters: PaneFilters::default(),
        }
    }

    /// Restricts discovery to one session.
    pub fn session(mut self, session_name: impl AsRef<str>) -> Self {
        self.filters.session = Some(session_name.as_ref().to_owned());
        self
    }

    /// Restricts discovery to panes with this exact title.
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.filters.title = Some(title.into());
        self
    }

    /// Restricts discovery to panes whose title starts with `prefix`.
    pub fn title_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.filters.title_prefix = Some(prefix.into());
        self
    }

    /// Restricts discovery to panes whose recorded argv contains `needle`.
    pub fn command_contains(mut self, needle: impl Into<String>) -> Self {
        self.filters.command_contains = Some(needle.into());
        self
    }

    /// Restricts discovery to panes whose recorded cwd contains `needle`.
    pub fn cwd_contains(mut self, needle: impl Into<String>) -> Self {
        self.filters.cwd_contains = Some(needle.into());
        self
    }

    /// Restricts discovery to one window index.
    pub const fn window_index(mut self, index: u32) -> Self {
        self.filters.window_index = Some(index);
        self
    }

    /// Restricts discovery to panes whose process is currently running.
    pub const fn running(mut self) -> Self {
        self.filters.running = Some(true);
        self
    }

    /// Restricts discovery to panes whose process has exited.
    pub const fn exited(mut self) -> Self {
        self.filters.running = Some(false);
        self
    }

    /// Returns every pane matching this query, deduplicated by session and pane id.
    pub async fn all(self) -> Result<Vec<DiscoveredPane>> {
        discover_panes(self.terminal, &self.filters).await
    }

    /// Returns the single pane matching this query.
    ///
    /// A zero-match or multi-match result is reported as a strict discovery
    /// violation with the query summary in the diagnostic text.
    pub async fn one(self) -> Result<Pane> {
        let filters = self.filters.clone();
        let matches = discover_panes(self.terminal, &filters).await?;
        match matches.len() {
            1 => Ok(matches
                .into_iter()
                .next()
                .expect("single match length guarantees one entry")
                .pane),
            count => Err(strict_discovery_error(count, &filters)),
        }
    }

    /// Collects matching panes into a [`PaneSet`].
    pub async fn collect_paneset(self) -> Result<PaneSet> {
        let panes = self
            .all()
            .await?
            .into_iter()
            .map(|discovered| discovered.pane);
        Ok(PaneSet::new(panes))
    }
}

async fn discover_panes(terminal: &Terminal, filters: &PaneFilters) -> Result<Vec<DiscoveredPane>> {
    let session_names = match &filters.session {
        Some(session_name) => {
            vec![SessionName::new(session_name).map_err(TerminalError::protocol)?]
        }
        None => terminal.list_sessions().await?,
    };

    let mut seen = HashSet::new();
    let mut discovered = Vec::new();
    for session_name in session_names {
        if !terminal.has_session(session_name.clone()).await? {
            continue;
        }
        let session = terminal.session(session_name.clone()).await?;
        let parents = session_info_snapshot(session.transport(), &session_name).await?;
        if parents.sessions.is_empty() {
            continue;
        }
        for listed in list_session_panes(&session).await? {
            if !seen.insert((session_name.clone(), listed.pane_id)) {
                continue;
            }
            // 复用本次发现的父元数据与槽位，详情必须核对同一个稳定 ID。
            let pane =
                session.pane_handle_by_id(listed.pane_id, listed.window_index, listed.pane_index);
            let snapshot = pane_info_snapshot_with_parents(
                session.transport(),
                pane.target(),
                Some(listed.pane_id),
                &parents,
            )
            .await?;
            let Some(info) = snapshot.pane(listed.pane_id).cloned() else {
                continue;
            };
            let title = pane.title().await?;
            let Some(entry) =
                discovered_from_info(session_name.clone(), listed, pane, info, title, &snapshot)
            else {
                continue;
            };
            if filters.matches(&entry) {
                discovered.push(entry);
            }
        }
    }

    Ok(discovered)
}

fn discovered_from_info(
    session_name: SessionName,
    listed: ListedPane,
    pane: Pane,
    info: PaneInfo,
    title: Option<String>,
    snapshot: &crate::InfoSnapshot,
) -> Option<DiscoveredPane> {
    let window = snapshot.window(info.window_id)?;
    let tags = merge_tags(
        &info.tags,
        &window.tags,
        snapshot
            .session(info.session_id)
            .map(|session| &session.tags),
    );
    Some(DiscoveredPane {
        session_name,
        session_id: info.session_id,
        window_id: info.window_id,
        window_index: listed.window_index,
        pane_id: info.id,
        generation: info.generation,
        pane_index: listed.pane_index,
        active: listed.active,
        geometry: listed.geometry,
        title,
        command: info.command,
        working_directory: info.working_directory,
        tags,
        process: info.process,
        pane,
    })
}

fn merge_tags(pane: &[String], window: &[String], session: Option<&Vec<String>>) -> Vec<String> {
    let mut tags = Vec::new();
    for tag in pane
        .iter()
        .chain(window.iter())
        .chain(session.into_iter().flatten())
    {
        if !tags.iter().any(|seen| seen == tag) {
            tags.push(tag.clone());
        }
    }
    tags
}

impl PaneFilters {
    fn matches(&self, pane: &DiscoveredPane) -> bool {
        if let Some(title) = &self.title {
            if pane.title.as_deref() != Some(title.as_str()) {
                return false;
            }
        }
        if let Some(prefix) = &self.title_prefix {
            if !pane
                .title
                .as_deref()
                .is_some_and(|title| title.starts_with(prefix))
            {
                return false;
            }
        }
        if let Some(needle) = &self.command_contains {
            if !pane
                .command
                .as_ref()
                .is_some_and(|argv| argv.iter().any(|arg| arg.contains(needle)))
            {
                return false;
            }
        }
        if let Some(needle) = &self.cwd_contains {
            if !pane
                .working_directory
                .as_deref()
                .is_some_and(|cwd| cwd.contains(needle))
            {
                return false;
            }
        }
        if let Some(running) = self.running {
            if !pane.process_matches(running) {
                return false;
            }
        }
        if let Some(window_index) = self.window_index {
            if pane.window_index != window_index {
                return false;
            }
        }
        true
    }
}

impl DiscoveredPane {
    fn process_matches(&self, running: bool) -> bool {
        matches!(
            (running, &self.process),
            (true, PaneProcessState::Running { .. }) | (false, PaneProcessState::Exited)
        )
    }
}

#[derive(Debug, Clone, Copy)]
struct ListedPane {
    window_index: u32,
    pane_index: u32,
    pane_id: PaneId,
    active: bool,
    geometry: PaneGeometry,
}

async fn list_session_panes(session: &crate::Session) -> Result<Vec<ListedPane>> {
    let response = session
        .transport()
        .request(Request::ListPanes(ListPanesRequest {
            target: session.name().clone(),
            target_window_index: None,
            format: Some(PANE_DISCOVERY_FORMAT.to_owned()),
        }))
        .await?;

    let output = match response {
        Response::ListPanes(response) => response.output.stdout,
        response => return Err(unexpected_response("list-panes", response)),
    };

    String::from_utf8_lossy(&output)
        .lines()
        .map(parse_listed_pane)
        .collect()
}

fn parse_listed_pane(line: &str) -> Result<ListedPane> {
    let mut fields = line.split(':');
    let window_index = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted window index"))?;
    let pane_index = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted pane index"))?;
    let pane_id = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted pane id"))?;
    let active = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted active state"))?;
    let left = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted left coordinate"))?;
    let top = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted top coordinate"))?;
    let width = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted width"))?;
    let height = fields
        .next()
        .ok_or_else(|| parse_error("pane discovery line omitted height"))?;
    if fields.next().is_some() {
        return Err(parse_error("pane discovery line had trailing fields"));
    }
    Ok(ListedPane {
        window_index: parse_u32(window_index, "window index")?,
        pane_index: parse_u32(pane_index, "pane index")?,
        pane_id: parse_pane_id(pane_id)?,
        active: parse_bool(active, "pane active state")?,
        geometry: PaneGeometry {
            left: parse_u16(left, "pane left coordinate")?,
            top: parse_u16(top, "pane top coordinate")?,
            width: parse_u16(width, "pane width")?,
            height: parse_u16(height, "pane height")?,
        },
    })
}

fn parse_pane_id(value: &str) -> Result<PaneId> {
    let raw = value
        .strip_prefix('%')
        .ok_or_else(|| parse_error(format!("pane id `{value}` omitted `%` prefix")))?;
    parse_u32(raw, "pane id").map(PaneId::new)
}

fn parse_u16(value: &str, field: &str) -> Result<u16> {
    value
        .parse::<u16>()
        .map_err(|error| parse_error(format!("invalid {field} `{value}`: {error}")))
}

fn parse_u32(value: &str, field: &str) -> Result<u32> {
    value
        .parse::<u32>()
        .map_err(|error| parse_error(format!("invalid {field} `{value}`: {error}")))
}

fn parse_bool(value: &str, field: &str) -> Result<bool> {
    match value {
        "1" | "true" => Ok(true),
        "0" | "false" => Ok(false),
        _ => Err(parse_error(format!("invalid {field} `{value}`"))),
    }
}

fn strict_discovery_error(count: usize, filters: &PaneFilters) -> TerminalError {
    TerminalError::protocol(berth_term_proto::TerminalError::Server(format!(
        "strict pane discovery violation: expected 1 match, found {count}; query: {}",
        filters.describe()
    )))
}

impl PaneFilters {
    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(session) = &self.session {
            parts.push(format!("session={session}"));
        }
        if let Some(title) = &self.title {
            parts.push(format!("title={title:?}"));
        }
        if let Some(prefix) = &self.title_prefix {
            parts.push(format!("title_prefix={prefix:?}"));
        }
        if let Some(needle) = &self.command_contains {
            parts.push(format!("command_contains={needle:?}"));
        }
        if let Some(needle) = &self.cwd_contains {
            parts.push(format!("cwd_contains={needle:?}"));
        }
        if let Some(running) = self.running {
            parts.push(
                if running {
                    "running=true"
                } else {
                    "exited=true"
                }
                .to_owned(),
            );
        }
        if let Some(window_index) = self.window_index {
            parts.push(format!("window_index={window_index}"));
        }
        if parts.is_empty() {
            "<all panes>".to_owned()
        } else {
            parts.join(", ")
        }
    }
}

fn parse_error(message: impl Into<String>) -> TerminalError {
    TerminalError::protocol(berth_term_proto::TerminalError::Server(message.into()))
}

#[cfg(test)]
mod tests {
    use super::{parse_listed_pane, DiscoveredPane, PaneFinder, PaneGeometry};

    async fn discovery_probe(
        rounds: usize,
        replaced: bool,
    ) -> (crate::Result<Vec<DiscoveredPane>>, (usize, usize)) {
        use berth_term_proto::{
            encode_frame, CommandOutput, DisplayMessageResponse, FrameDecoder, HasSessionResponse,
            LayoutName, ListPanesResponse, ListSessionsResponse, ListWindowsResponse, Request,
            Response, SessionName, TerminalSize, WindowListEntry, WindowTarget,
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (stream, mut peer) = tokio::io::duplex(4096);
        let terminal = crate::Terminal::from_transport_for_test(
            crate::transport::TransportClient::spawn(stream),
            None,
        );
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut decoder = FrameDecoder::new();
            let mut buffer = [0_u8; 4096];
            let mut counts = (0, 0);
            loop {
                let request = loop {
                    if let Some(request) = decoder.next_frame::<Request>().unwrap() {
                        break request;
                    }
                    let read = tokio::select! {
                        _ = &mut stopped => return counts,
                        read = peer.read(&mut buffer) => read.unwrap(),
                    };
                    assert_ne!(read, 0, "client closed during discovery");
                    decoder.push_bytes(&buffer[..read]);
                };
                let response = match request {
                    Request::HasSession(_) => {
                        Response::HasSession(HasSessionResponse { exists: true })
                    }
                    Request::ListSessions(_) => {
                        counts.0 += 1;
                        Response::ListSessions(ListSessionsResponse {
                            output: CommandOutput::from_stdout(b"alpha\t$1\t/tmp\t0\n".to_vec()),
                        })
                    }
                    Request::ListWindows(_) => {
                        counts.1 += 1;
                        Response::ListWindows(ListWindowsResponse {
                            windows: vec![WindowListEntry {
                                target: WindowTarget::with_window(
                                    SessionName::new("alpha").unwrap(),
                                    2,
                                ),
                                window_id: "@2".to_owned(),
                                name: None,
                                pane_count: 2,
                                size: TerminalSize { cols: 80, rows: 24 },
                                layout: LayoutName::Tiled,
                                active: true,
                                last: false,
                                rendered: String::new(),
                            }],
                            output: CommandOutput::from_stdout(Vec::new()),
                        })
                    }
                    Request::ListPanes(request) => {
                        let output =
                            if request.format.as_deref() == Some(super::PANE_DISCOVERY_FORMAT) {
                                "2:3:%4:1:0:0:40:24\n2:4:%5:0:40:0:40:24\n"
                            } else {
                                "2:3:%4\n2:4:%5\n"
                            };
                        Response::ListPanes(ListPanesResponse {
                            output: CommandOutput::from_stdout(output.as_bytes().to_vec()),
                        })
                    }
                    Request::DisplayMessage(request) => {
                        let target = request.target.unwrap().to_string();
                        let pane_id = match target.as_str() {
                            "alpha:2.3" if replaced => 99,
                            "alpha:2.3" => 4,
                            "alpha:2.4" => 5,
                            _ => panic!("unexpected pane target: {target}"),
                        };
                        let output = if request.message.as_deref() == Some("#{pane_title}") {
                            "same title".to_owned()
                        } else {
                            format!("%{pane_id}\t1234\t0\t\t\t40\t24\t0\t0\t1\t0\t0\t0\tsh\t7\t2\t3\t\t\t\t\t\t\t\t/tmp")
                        };
                        Response::DisplayMessage(DisplayMessageResponse::from_output(
                            CommandOutput::from_stdout(output.into_bytes()),
                        ))
                    }
                    request => panic!("unexpected discovery request: {request:?}"),
                };
                peer.write_all(&encode_frame(&response).unwrap())
                    .await
                    .unwrap();
            }
        });
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            let mut found = Vec::new();
            for _ in 0..rounds {
                found = PaneFinder::new(&terminal).session("alpha").all().await?;
            }
            Ok(found)
        })
        .await
        .expect("in-memory discovery must finish");
        stop.send(()).unwrap();
        (result, server.await.unwrap())
    }

    #[tokio::test]
    async fn discovery_reads_parent_metadata_once_per_session() {
        let (result, counts) = discovery_probe(1, false).await;
        let panes = result.expect("live inventory");
        assert_eq!(panes.len(), 2);
        assert_eq!(panes[0].pane_id, crate::PaneId::new(4));
        assert_eq!(panes[1].pane_id, crate::PaneId::new(5));
        assert!(panes.iter().all(|pane| pane.generation == 7));
        assert_eq!(counts, (1, 1), "parent metadata is shared within discovery");
    }

    #[tokio::test]
    async fn discovery_refreshes_parent_metadata_on_each_call() {
        let (result, counts) = discovery_probe(2, false).await;
        assert_eq!(result.expect("fresh inventory").len(), 2);
        assert_eq!(counts, (2, 2), "no metadata cache may outlive one call");
    }

    #[tokio::test]
    async fn discovery_rejects_replaced_detail_identity() {
        let (result, _) = discovery_probe(1, true).await;
        assert!(matches!(
            result.expect_err("replaced pane must not enter inventory"),
            crate::TerminalError::Protocol {
                source: berth_term_proto::TerminalError::PaneBindingInvalid {
                    reason: berth_term_proto::PaneBindingFailure::StalePane,
                },
            }
        ));
    }

    #[test]
    fn parse_listed_pane_preserves_active_geometry() {
        let pane = parse_listed_pane("2:3:%17:1:10:4:80:24").expect("parses");
        assert_eq!(pane.window_index, 2);
        assert_eq!(pane.pane_index, 3);
        assert!(pane.active);
        assert_eq!(pane.pane_id.to_string(), "%17");
        assert_eq!(
            pane.geometry,
            PaneGeometry {
                left: 10,
                top: 4,
                width: 80,
                height: 24,
            }
        );
    }
}
