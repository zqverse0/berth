//! Daemon-backed window handle.

use std::fmt;
use std::time::Duration;

use crate::handles::session::unexpected_response;
use crate::transport::TransportClient;
use crate::{
    InfoSnapshot, PaneId, PaneInfo, PaneProcessState, PaneRef, Result, SessionId, SessionInfo,
    TerminalEndpoint, TerminalError, TerminalSizeSpec, WindowId, WindowInfo, WindowRef,
};
use berth_term_proto::{
    KillWindowRequest, ListPanesRequest, ListSessionsRequest, ListWindowsRequest, Request,
    ResizeWindowRequest, Response,
};
#[cfg(feature = "available")]
use berth_term_proto::{
    LayoutName, RenameWindowRequest, SelectLayoutRequest, SelectLayoutTarget, SelectWindowRequest,
};

#[path = "window/new_builder.rs"]
mod new_builder;

pub use new_builder::NewWindowBuilder;

const SESSION_INFO_FORMAT: &str =
    "#{session_name}\t#{session_id}\t#{session_path}\t#{session_attached}";
const PANE_INFO_FORMAT: &str = "#{window_index}:#{pane_index}:#{pane_id}:#{pane_active}";

/// One pane listed inside a [`Window`] handle.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WindowPane {
    /// Exact pane selector inside the window's session and index.
    pub target: PaneRef,
    /// Stable tmux-style pane identity, rendered as `%N` by formats.
    pub id: PaneId,
    /// Whether this pane is the active pane for its window.
    pub active: bool,
}

/// Result of consuming a [`Window`] handle with [`Window::close`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum WindowCloseOutcome {
    /// The daemon killed the addressed window and selected another window.
    Closed {
        /// The surviving active window reported by the daemon.
        active: WindowRef,
    },
    /// The addressed window was already absent by the time close ran.
    AlreadyClosed {
        /// The stale target consumed by the close call.
        target: WindowRef,
    },
}

/// Opaque handle for one daemon window slot.
///
/// A window handle addresses a session/index pair rather than caching a
/// `WindowId`. Every operation resolves that slot against the daemon's current
/// state, so linked windows and grouped sessions follow tmux visibility rules:
/// closing one visible link removes the underlying window and panes from every
/// linked or grouped listing, while stale handles for any affected slot return
/// typed empty/already-closed results where the operation supports them.
#[derive(Clone)]
pub struct Window {
    target: WindowRef,
    endpoint: TerminalEndpoint,
    default_timeout: Option<Duration>,
    transport: TransportClient,
    created_pane: Option<berth_term_proto::CreatedPane>,
}

impl Window {
    pub(crate) fn new(
        target: WindowRef,
        endpoint: TerminalEndpoint,
        default_timeout: Option<Duration>,
        transport: TransportClient,
    ) -> Self {
        Self {
            target,
            endpoint,
            default_timeout,
            transport,
            created_pane: None,
        }
    }

    pub(crate) fn with_created_pane(
        mut self,
        created_pane: Option<berth_term_proto::CreatedPane>,
    ) -> Self {
        self.created_pane = created_pane;
        self
    }

    /// 本次 new-window 的原子初始 pane 回执；惰性句柄或旧 daemon 时为空。
    #[must_use]
    pub const fn created_pane(&self) -> Option<&berth_term_proto::CreatedPane> {
        self.created_pane.as_ref()
    }

    /// Returns the exact protocol-owned window target addressed by this handle.
    #[must_use]
    pub const fn target(&self) -> &WindowRef {
        &self.target
    }

    /// Returns the endpoint that was resolved when this handle was created.
    #[must_use]
    pub const fn endpoint(&self) -> &TerminalEndpoint {
        &self.endpoint
    }

    /// Returns the default timeout configured on the parent facade.
    #[must_use]
    pub const fn configured_default_timeout(&self) -> Option<Duration> {
        self.default_timeout
    }

    /// Returns the stable daemon window identity for this slot, when it is
    /// currently listed.
    pub async fn id(&self) -> Result<Option<WindowId>> {
        Ok(current_window_entry(&self.transport, &self.target)
            .await?
            .map(|entry| entry.id))
    }

    /// Checks whether this exact window slot is currently listed by the daemon.
    pub async fn exists(&self) -> Result<bool> {
        Ok(self.id().await?.is_some())
    }

    /// Lists panes currently visible through this window slot.
    pub async fn panes(&self) -> Result<Vec<WindowPane>> {
        list_window_panes_or_empty(&self.transport, &self.target).await
    }

    /// Returns a sticky info snapshot for this window and its listed panes.
    ///
    /// The snapshot is assembled from live daemon `list-sessions`,
    /// `list-windows`, and `list-panes` responses. If the target has already
    /// been closed, the returned snapshot contains only the still-observable
    /// session metadata, or is empty when the session is gone.
    pub async fn info(&self) -> Result<InfoSnapshot> {
        window_info_snapshot(&self.transport, &self.target).await
    }

    /// Selects this window in its session.
    #[cfg(feature = "available")]
    pub async fn select(&self) -> Result<()> {
        select_window(&self.transport, &self.target).await
    }

    /// Renames this window.
    #[cfg(feature = "available")]
    pub async fn rename(&self, name: impl Into<String>) -> Result<()> {
        rename_window(&self.transport, &self.target, name.into()).await
    }

    /// Requests an absolute size for this window.
    ///
    /// Passing `None` for one dimension leaves that dimension to the daemon.
    pub async fn resize(&self, width: Option<u16>, height: Option<u16>) -> Result<()> {
        resize_window(&self.transport, &self.target, width, height).await
    }

    /// Applies a named layout to this window.
    #[cfg(feature = "available")]
    pub async fn select_layout(&self, layout: LayoutName) -> Result<()> {
        select_window_layout(&self.transport, &self.target, layout).await
    }

    /// Consumes this handle and kills the addressed window through the daemon.
    ///
    /// A stale handle is treated as an idempotent no-op and returns
    /// [`WindowCloseOutcome::AlreadyClosed`]. Linked or grouped views of the
    /// same underlying window are removed together by the daemon. Other daemon
    /// errors, such as attempting to kill the only window in a session, are
    /// returned.
    pub async fn close(self) -> Result<WindowCloseOutcome> {
        close_window(&self.transport, self.target).await
    }
}

impl fmt::Debug for Window {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Window")
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "available")]
async fn select_window(client: &TransportClient, target: &WindowRef) -> Result<()> {
    match client
        .request(Request::SelectWindow(SelectWindowRequest {
            target: target.to_proto(),
        }))
        .await?
    {
        Response::SelectWindow(_) => Ok(()),
        response => Err(unexpected_response("select-window", response)),
    }
}

#[cfg(feature = "available")]
async fn rename_window(client: &TransportClient, target: &WindowRef, name: String) -> Result<()> {
    match client
        .request(Request::RenameWindow(RenameWindowRequest {
            target: target.to_proto(),
            name,
        }))
        .await?
    {
        Response::RenameWindow(_) => Ok(()),
        response => Err(unexpected_response("rename-window", response)),
    }
}

async fn resize_window(
    client: &TransportClient,
    target: &WindowRef,
    width: Option<u16>,
    height: Option<u16>,
) -> Result<()> {
    match client
        .request(Request::ResizeWindow(ResizeWindowRequest {
            target: target.to_proto(),
            width,
            height,
            adjustment: None,
        }))
        .await?
    {
        Response::ResizeWindow(_) => Ok(()),
        response => Err(unexpected_response("resize-window", response)),
    }
}

#[cfg(feature = "available")]
async fn select_window_layout(
    client: &TransportClient,
    target: &WindowRef,
    layout: LayoutName,
) -> Result<()> {
    match client
        .request(Request::SelectLayout(SelectLayoutRequest {
            target: SelectLayoutTarget::Window(target.to_proto()),
            layout,
        }))
        .await?
    {
        Response::SelectLayout(_) => Ok(()),
        response => Err(unexpected_response("select-layout", response)),
    }
}

async fn close_window(client: &TransportClient, target: WindowRef) -> Result<WindowCloseOutcome> {
    let response = client
        .request(Request::KillWindow(KillWindowRequest {
            target: (&target).into(),
            kill_all_others: false,
        }))
        .await;

    match response {
        Ok(Response::KillWindow(response)) => Ok(WindowCloseOutcome::Closed {
            active: response.target.into(),
        }),
        Ok(response) => Err(unexpected_response("kill-window", response)),
        Err(error) if is_already_closed_error(&error, &target) => {
            Ok(WindowCloseOutcome::AlreadyClosed { target })
        }
        Err(error) => Err(error),
    }
}

async fn current_window_entry(
    client: &TransportClient,
    target: &WindowRef,
) -> Result<Option<ListedWindow>> {
    match list_window_entries(client, &target.session_name).await {
        Ok(entries) => Ok(entries
            .into_iter()
            .find(|entry| entry.index == target.window_index)),
        Err(error) if is_already_closed_error(&error, target) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn window_info_snapshot(
    client: &TransportClient,
    target: &WindowRef,
) -> Result<InfoSnapshot> {
    let session = current_session_info(client, &target.session_name).await?;
    let Some(session) = session else {
        return Ok(InfoSnapshot::default());
    };

    let Some(window) = current_window_entry(client, target).await? else {
        return Ok(InfoSnapshot::new(vec![session], Vec::new(), Vec::new()));
    };

    let panes = list_window_panes_or_empty(client, target).await?;
    let session_id = session.id;
    let pane_infos = panes
        .into_iter()
        .map(|pane| {
            let mut info = PaneInfo::new(pane.id, window.id, session_id);
            info.index = pane.target.pane_index;
            info.size = window.size;
            info.process = PaneProcessState::Unknown;
            info
        })
        .collect();

    Ok(InfoSnapshot::new(
        vec![session],
        vec![window.into_info(session_id)],
        pane_infos,
    ))
}

async fn current_session_info(
    client: &TransportClient,
    session_name: &berth_term_proto::SessionName,
) -> Result<Option<SessionInfo>> {
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
        let info = parse_session_info_line(line)?;
        if &info.name == session_name {
            return Ok(Some(info));
        }
    }

    Ok(None)
}

/// One entry of a session's live window list (`list-windows` projection).
///
/// Public summary of a daemon-reported window: slot index plus stable id,
/// name, and geometry. `Session::windows` returns these so callers iterate
/// the real list instead of probing fixed slot indices.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ListedWindowEntry {
    /// Window index inside its session (the `window(index)` slot).
    pub index: u32,
    /// Stable per-server window identity (`@N`).
    pub id: WindowId,
    /// Window name, when the user or a `rename-window` invocation set one.
    pub name: Option<String>,
    /// Window geometry as last reported by the daemon.
    pub size: TerminalSizeSpec,
}

impl From<ListedWindow> for ListedWindowEntry {
    fn from(window: ListedWindow) -> Self {
        Self {
            index: window.index,
            id: window.id,
            name: window.name,
            size: window.size,
        }
    }
}

/// Session-facing helper behind `Session::windows`: one `list-windows`
/// round trip mapped to the public entry projection.
pub(crate) async fn list_window_entries_for_session(
    client: &TransportClient,
    session_name: &berth_term_proto::SessionName,
) -> Result<Vec<ListedWindowEntry>> {
    let entries = list_window_entries(client, session_name).await?;
    Ok(entries.into_iter().map(ListedWindowEntry::from).collect())
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
            .map(ListedWindow::try_from)
            .collect(),
        response => Err(unexpected_response("list-windows", response)),
    }
}

async fn list_window_panes_or_empty(
    client: &TransportClient,
    target: &WindowRef,
) -> Result<Vec<WindowPane>> {
    match list_window_panes(client, target).await {
        Ok(panes) => Ok(panes),
        Err(error) if is_already_closed_error(&error, target) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

async fn list_window_panes(
    client: &TransportClient,
    target: &WindowRef,
) -> Result<Vec<WindowPane>> {
    let response = client
        .request(Request::ListPanes(ListPanesRequest {
            target: target.session_name.clone(),
            target_window_index: Some(target.window_index),
            format: Some(PANE_INFO_FORMAT.to_owned()),
        }))
        .await?;

    let output = match response {
        Response::ListPanes(response) => response.output.stdout,
        response => return Err(unexpected_response("list-panes", response)),
    };

    String::from_utf8_lossy(&output)
        .lines()
        .map(|line| parse_pane_info_line(target, line))
        .collect()
}

#[derive(Debug, Clone)]
struct ListedWindow {
    index: u32,
    id: WindowId,
    name: Option<String>,
    size: TerminalSizeSpec,
}

impl ListedWindow {
    fn into_info(self, session_id: SessionId) -> WindowInfo {
        let mut info = WindowInfo::new(self.id, session_id);
        info.index = self.index;
        info.name = self.name;
        info.size = self.size;
        info
    }
}

impl TryFrom<berth_term_proto::WindowListEntry> for ListedWindow {
    type Error = TerminalError;

    fn try_from(entry: berth_term_proto::WindowListEntry) -> Result<Self> {
        Ok(Self {
            index: entry.target.window_index(),
            id: parse_window_id(&entry.window_id)?,
            name: entry.name,
            size: entry.size.into(),
        })
    }
}

fn parse_session_info_line(line: &str) -> Result<SessionInfo> {
    let mut fields = line.split('\t');
    let name = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted session name"))?;
    let id = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted session id"))?;
    let path = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted session path"))?;
    let attached = fields
        .next()
        .ok_or_else(|| parse_error("session info line omitted attached count"))?;
    if fields.next().is_some() {
        return Err(parse_error("session info line had trailing fields"));
    }

    let mut info = SessionInfo::new(
        parse_session_id(id)?,
        berth_term_proto::SessionName::new(name)?,
    );
    info.working_directory = if path.is_empty() {
        None
    } else {
        Some(path.to_owned())
    };
    info.attached_clients = attached.parse::<u32>().map_err(|error| {
        parse_error(format!(
            "invalid session attached count `{attached}`: {error}"
        ))
    })?;
    Ok(info)
}

fn parse_pane_info_line(target: &WindowRef, line: &str) -> Result<WindowPane> {
    let mut fields = line.split(':');
    let window_index = fields
        .next()
        .ok_or_else(|| parse_error("pane info line omitted window index"))?;
    let pane_index = fields
        .next()
        .ok_or_else(|| parse_error("pane info line omitted pane index"))?;
    let pane_id = fields
        .next()
        .ok_or_else(|| parse_error("pane info line omitted pane id"))?;
    let active = fields
        .next()
        .ok_or_else(|| parse_error("pane info line omitted active flag"))?;
    if fields.next().is_some() {
        return Err(parse_error("pane info line had trailing fields"));
    }

    let window_index = parse_u32(window_index, "pane window index")?;
    if window_index != target.window_index {
        return Err(parse_error(format!(
            "list-panes returned window index {window_index} for target {}",
            target.to_proto()
        )));
    }

    Ok(WindowPane {
        target: PaneRef::new(
            target.session_name.clone(),
            window_index,
            parse_u32(pane_index, "pane index")?,
        ),
        id: parse_pane_id(pane_id)?,
        active: parse_bool_flag(active, "pane active flag")?,
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

fn parse_bool_flag(value: &str, field: &str) -> Result<bool> {
    match value {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(parse_error(format!("invalid {field} `{value}`"))),
    }
}

fn parse_error(message: impl Into<String>) -> TerminalError {
    TerminalError::protocol(berth_term_proto::TerminalError::Server(message.into()))
}

fn is_already_closed_error(error: &TerminalError, target: &WindowRef) -> bool {
    match error {
        TerminalError::Protocol {
            source: berth_term_proto::TerminalError::SessionNotFound(session),
        } => session == target.session_name.as_str(),
        TerminalError::Protocol {
            source: berth_term_proto::TerminalError::InvalidTarget { value, reason },
        } => {
            value == &target.to_proto().to_string()
                && reason == "window index does not exist in session"
        }
        _ => false,
    }
}

#[cfg(all(test, feature = "available"))]
#[path = "window/tests.rs"]
mod tests;
