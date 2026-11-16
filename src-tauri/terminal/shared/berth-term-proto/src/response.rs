//! Detached response contracts.

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::{HandshakeResponse, LayoutName, SdkWaitId, TerminalError};

#[path = "response/session.rs"]
mod session;
pub use session::{
    CreateSessionLeaseResponse, HasSessionResponse, KillSessionResponse, ListSessionsResponse,
    NewSessionResponse, ReleaseSessionLeaseResponse, RenameSessionResponse,
    RenewSessionLeaseResponse,
};

#[path = "response/server.rs"]
mod server;
pub use server::KillServerResponse;

#[path = "response/target.rs"]
mod target;
pub use target::ResolveTargetResponse;

#[path = "response/window.rs"]
mod window;
pub use window::{
    KillWindowResponse, ListWindowsResponse, NewWindowResponse, NextWindowResponse,
    PreviousWindowResponse, RenameWindowResponse, ResizeWindowResponse, RespawnWindowResponse,
    SelectWindowResponse, WindowListEntry,
};

#[path = "response/pane.rs"]
mod pane;
pub use pane::{
    KillPaneResponse, ListPanesResponse, PaneBroadcastInputFailure, PaneBroadcastInputResponse,
    PaneBroadcastInputSuccess, PaneOutputCursor, PaneOutputCursorResponse, PaneOutputEvent,
    PaneOutputLagNotice, PaneOutputLagResponse, PaneRecentOutput, PaneSnapshotCell,
    PaneSnapshotCursor, PaneSnapshotResponse, ResizePaneResponse, RespawnPaneResponse,
    SelectPaneResponse, SendKeysResponse, SplitWindowResponse, SubscribePaneOutputResponse,
    UnsubscribePaneOutputResponse,
};

#[path = "response/client.rs"]
mod client;
pub use client::{AttachSessionResponse, DetachClientResponse, SwitchClientResponse};

#[path = "response/keys.rs"]
mod keys;
pub use keys::CopyModeResponse;

#[path = "response/options.rs"]
mod options;
pub use options::{SetOptionByNameResponse, SetOptionResponse, ShowOptionsResponse};

/// 在创建所持 state 锁内捕获的本次新 pane 身份，不从后续活动槽位推断。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedPane {
    /// 新分配的稳定 pane id。
    pub pane_id: crate::PaneId,
    /// 创建时的进程代际；后续 respawn 不得覆盖此值。
    pub generation: u64,
    /// 创建时所在的窗口槽位，仅用作初始位置提示。
    pub window_index: u32,
    /// 创建时所在的 pane 槽位，仅用作初始位置提示。
    pub pane_index: u32,
}

/// All detached responses supported by the wire protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Response {
    /// Success payload for `new-session`.
    NewSession(NewSessionResponse),
    /// Success payload for `has-session`.
    HasSession(HasSessionResponse),
    /// Success payload for `kill-session`.
    KillSession(KillSessionResponse),
    /// Success payload for `new-window`.
    NewWindow(NewWindowResponse),
    /// Success payload for `kill-window`.
    KillWindow(KillWindowResponse),
    /// Success payload for `select-window`.
    SelectWindow(SelectWindowResponse),
    /// Success payload for `rename-window`.
    RenameWindow(RenameWindowResponse),
    /// Success payload for `next-window`.
    NextWindow(NextWindowResponse),
    /// Success payload for `previous-window`.
    PreviousWindow(PreviousWindowResponse),
    /// 已删除（原 `last-window`）。只占住 bincode 标签 9，永不复用。
    Reserved9,
    /// Success payload for `list-windows`.
    ListWindows(ListWindowsResponse),
    /// 已删除（原 `move-window`）。只占住 bincode 标签 11，永不复用。
    Reserved11,
    /// 已删除（原 `swap-window`）。只占住 bincode 标签 12，永不复用。
    Reserved12,
    /// 已删除（原 `rotate-window`）。只占住 bincode 标签 13，永不复用。
    Reserved13,
    /// Success payload for `split-window`.
    SplitWindow(SplitWindowResponse),
    /// 已删除（原 `swap-pane`）。只占住 bincode 标签 15，永不复用。
    Reserved15,
    /// 已删除（原 `last-pane`）。只占住 bincode 标签 16，永不复用。
    Reserved16,
    /// 已删除（原 `join-pane`）。只占住 bincode 标签 17，永不复用。
    Reserved17,
    /// 已删除（原 `break-pane`）。只占住 bincode 标签 18，永不复用。
    Reserved18,
    /// Success payload for `kill-pane`.
    KillPane(KillPaneResponse),
    /// Success payload for `select-layout`.
    SelectLayout(SelectLayoutResponse),
    /// Success payload for `resize-pane`.
    ResizePane(ResizePaneResponse),
    /// 已删除（原 `display-panes`）。只占住 bincode 标签 22，永不复用。
    Reserved22,
    /// Success payload for `select-pane`.
    SelectPane(SelectPaneResponse),
    /// Success payload for `send-keys`.
    SendKeys(SendKeysResponse),
    /// Success payload for `attach-session`.
    AttachSession(AttachSessionResponse),
    /// Success payload for `switch-client`.
    SwitchClient(SwitchClientResponse),
    /// Success payload for `detach-client`.
    DetachClient(DetachClientResponse),
    /// Success payload for `set-option`.
    SetOption(SetOptionResponse),
    /// 已删除（原 `set-environment`）。只占住 bincode 标签 29，永不复用。
    Reserved29,
    /// 已删除（原 `set-hook`）。只占住 bincode 标签 30，永不复用。
    Reserved30,
    /// Error payload surfaced as exit code `1` and stderr by clients.
    Error(ErrorResponse),
    /// 已删除（原 `next-layout`）。只占住 bincode 标签 32，永不复用。
    Reserved32,
    /// 已删除（原 `previous-layout`）。只占住 bincode 标签 33，永不复用。
    Reserved33,
    /// Success payload for `show-options`.
    ShowOptions(ShowOptionsResponse),
    /// 已删除（原 `show-environment`）。只占住 bincode 标签 35，永不复用。
    Reserved35,
    /// Success payload for `set-buffer`.
    SetBuffer(SetBufferResponse),
    /// Success payload for `show-buffer`.
    ShowBuffer(ShowBufferResponse),
    /// Success payload for `paste-buffer`.
    PasteBuffer(PasteBufferResponse),
    /// 已删除（原 `list-buffers`）。只占住 bincode 标签 39，永不复用。
    Reserved39,
    /// 已删除（原 `delete-buffer`）。只占住 bincode 标签 40，永不复用。
    Reserved40,
    /// 已删除（原 `load-buffer`）。只占住 bincode 标签 41，永不复用。
    Reserved41,
    /// 已删除（原 `save-buffer`）。只占住 bincode 标签 42，永不复用。
    Reserved42,
    /// Success payload for `capture-pane`.
    CapturePane(CapturePaneResponse),
    /// Success payload for `display-message`.
    DisplayMessage(DisplayMessageResponse),
    /// Success payload for `run-shell`.
    RunShell(RunShellResponse),
    /// Success payload for `if-shell`.
    IfShell(IfShellResponse),
    /// Success payload for `wait-for`.
    WaitFor(WaitForResponse),
    /// Success payload for `rename-session`.
    RenameSession(RenameSessionResponse),
    /// Success payload for `list-sessions`.
    ListSessions(ListSessionsResponse),
    /// Success payload for `list-panes`.
    ListPanes(ListPanesResponse),
    /// 已删除（原 `source-file`）。只占住 bincode 标签 51，永不复用。
    Reserved51,
    /// Success payload for string-based `set-option`.
    SetOptionByName(SetOptionByNameResponse),
    /// 已删除（原 `show-hooks`）。只占住 bincode 标签 53，永不复用。
    Reserved53,
    /// 已删除（原 `bind-key`）。只占住 bincode 标签 54，永不复用。
    Reserved54,
    /// 已删除（原 `unbind-key`）。只占住 bincode 标签 55，永不复用。
    Reserved55,
    /// 已删除（原 `list-keys`）。只占住 bincode 标签 56，永不复用。
    Reserved56,
    /// 已删除（原 `send-prefix`）。只占住 bincode 标签 57，永不复用。
    Reserved57,
    /// Success payload for `clear-history`.
    ClearHistory(ClearHistoryResponse),
    /// Success payload for `copy-mode`.
    CopyMode(CopyModeResponse),
    /// 已删除（原 `control-mode`）。只占住 bincode 标签 60，永不复用。
    Reserved60,
    /// 已删除（原 `clock-mode`）。只占住 bincode 标签 61，永不复用。
    Reserved61,
    /// 已删除（原 `show-messages`）。只占住 bincode 标签 62，永不复用。
    Reserved62,
    /// Success payload for `kill-server`.
    KillServer(KillServerResponse),
    /// 已删除（原 `lock-server`）。只占住 bincode 标签 64，永不复用。
    Reserved64,
    /// 已删除（原 `lock-session`）。只占住 bincode 标签 65，永不复用。
    Reserved65,
    /// 已删除（原 `lock-client`）。只占住 bincode 标签 66，永不复用。
    Reserved66,
    /// 已删除（原 `server-access`）。只占住 bincode 标签 67，永不复用。
    Reserved67,
    /// 已删除（原 `refresh-client`）。只占住 bincode 标签 68，永不复用。
    Reserved68,
    /// 已删除（原 `list-clients`）。只占住 bincode 标签 69，永不复用。
    Reserved69,
    /// 已删除（原 `suspend-client`）。只占住 bincode 标签 70，永不复用。
    Reserved70,
    /// Success payload for `resize-window`.
    ResizeWindow(ResizeWindowResponse),
    /// Success payload for `respawn-window`.
    RespawnWindow(RespawnWindowResponse),
    /// 已删除（原 `move-pane`）。只占住 bincode 标签 73，永不复用。
    Reserved73,
    /// 已删除（原 `pipe-pane`）。只占住 bincode 标签 74，永不复用。
    Reserved74,
    /// Success payload for `respawn-pane`.
    RespawnPane(RespawnPaneResponse),
    /// 已删除（原 `link-window`）。只占住 bincode 标签 76，永不复用。
    Reserved76,
    /// 已删除（原 `unlink-window`）。只占住 bincode 标签 77，永不复用。
    Reserved77,
    /// Success payload for internal detached target resolution.
    ResolveTarget(ResolveTargetResponse),
    /// Success payload for SDK/daemon version and capability negotiation.
    Handshake(HandshakeResponse),
    /// Success payload for the daemon-backed pane snapshot endpoint.
    PaneSnapshot(PaneSnapshotResponse),
    /// Success payload for the daemon-backed pane output subscription endpoint.
    SubscribePaneOutput(SubscribePaneOutputResponse),
    /// Success payload for the daemon-backed pane output unsubscription endpoint.
    UnsubscribePaneOutput(UnsubscribePaneOutputResponse),
    /// Success payload for daemon-backed pane output cursor polling.
    PaneOutputCursor(PaneOutputCursorResponse),
    /// Lag notice for daemon-backed pane output cursor polling.
    PaneOutputLag(Box<PaneOutputLagResponse>),
    /// Success payload for a daemon-backed SDK byte wait.
    SdkWaitForOutput(SdkWaitForOutputResponse),
    /// Success payload for daemon-backed SDK wait cancellation.
    CancelSdkWait(CancelSdkWaitResponse),
    /// Success payload for daemon-side SDK pane-input broadcast.
    PaneBroadcastInput(PaneBroadcastInputResponse),
    /// Success payload for creating an app-owned session lease.
    CreateSessionLease(CreateSessionLeaseResponse),
    /// Success payload for renewing an app-owned session lease.
    RenewSessionLease(RenewSessionLeaseResponse),
    /// Success payload for releasing an app-owned session lease.
    ReleaseSessionLease(ReleaseSessionLeaseResponse),
    /// 已删除（原 `daemon-status`）。只占住 bincode 标签 91，永不复用。
    Reserved91,
    /// 已删除（原 `shutdown-if-idle`）。只占住 bincode 标签 92，永不复用。
    Reserved92,
}

impl Response {
    /// Returns the stable routing name for the response variant.
    ///
    /// `Error` is not tied to one command on the current wire and therefore
    /// reports the generic `error` tag.
    #[must_use]
    pub const fn command_name(&self) -> &'static str {
        match self {
            Self::NewSession(_) => "new-session",
            Self::HasSession(_) => "has-session",
            Self::KillSession(_) => "kill-session",
            Self::NewWindow(_) => "new-window",
            Self::KillWindow(_) => "kill-window",
            Self::SelectWindow(_) => "select-window",
            Self::RenameWindow(_) => "rename-window",
            Self::NextWindow(_) => "next-window",
            Self::PreviousWindow(_) => "previous-window",
            Self::ListWindows(_) => "list-windows",
            Self::SplitWindow(_) => "split-window",
            Self::KillPane(_) => "kill-pane",
            Self::SelectLayout(_) => "select-layout",
            Self::ResizePane(_) => "resize-pane",
            Self::SelectPane(_) => "select-pane",
            Self::SendKeys(_) => "send-keys",
            Self::AttachSession(_) => "attach-session",
            Self::SwitchClient(_) => "switch-client",
            Self::DetachClient(_) => "detach-client",
            Self::SetOption(_) | Self::SetOptionByName(_) => "set-option",
            Self::Error(_) => "error",
            Self::ShowOptions(_) => "show-options",
            Self::SetBuffer(_) => "set-buffer",
            Self::PasteBuffer(_) => "paste-buffer",
            Self::CapturePane(_) => "capture-pane",
            Self::DisplayMessage(_) => "display-message",
            Self::RunShell(_) => "run-shell",
            Self::IfShell(_) => "if-shell",
            Self::WaitFor(_) => "wait-for",
            Self::RenameSession(_) => "rename-session",
            Self::ListSessions(_) => "list-sessions",
            Self::ListPanes(_) => "list-panes",
            Self::ClearHistory(_) => "clear-history",
            Self::CopyMode(_) => "copy-mode",
            Self::KillServer(_) => "kill-server",
            Self::ResizeWindow(_) => "resize-window",
            Self::RespawnWindow(_) => "respawn-window",
            Self::RespawnPane(_) => "respawn-pane",
            Self::PaneSnapshot(_) => "pane-snapshot",
            Self::SubscribePaneOutput(_) => "subscribe-pane-output",
            Self::UnsubscribePaneOutput(_) => "unsubscribe-pane-output",
            Self::PaneOutputCursor(_) => "pane-output-cursor",
            Self::PaneOutputLag(_) => "pane-output-lag",
            Self::SdkWaitForOutput(_) => "sdk-wait-output",
            Self::CancelSdkWait(_) => "cancel-sdk-wait",
            Self::PaneBroadcastInput(_) => "send-keys",
            Self::CreateSessionLease(_) => "create-session-lease",
            Self::RenewSessionLease(_) => "renew-session-lease",
            Self::ReleaseSessionLease(_) => "release-session-lease",
            Self::ResolveTarget(_) => "resolve-target",
            Self::Handshake(_) => "handshake",
            Self::ShowBuffer(_) => "show-buffer",
            Self::Reserved9
            | Self::Reserved11
            | Self::Reserved12
            | Self::Reserved13
            | Self::Reserved15
            | Self::Reserved16
            | Self::Reserved17
            | Self::Reserved18
            | Self::Reserved22
            | Self::Reserved29
            | Self::Reserved30
            | Self::Reserved32
            | Self::Reserved33
            | Self::Reserved35
            | Self::Reserved39
            | Self::Reserved40
            | Self::Reserved41
            | Self::Reserved42
            | Self::Reserved51
            | Self::Reserved53
            | Self::Reserved54
            | Self::Reserved55
            | Self::Reserved56
            | Self::Reserved57
            | Self::Reserved60
            | Self::Reserved61
            | Self::Reserved62
            | Self::Reserved64
            | Self::Reserved65
            | Self::Reserved66
            | Self::Reserved67
            | Self::Reserved68
            | Self::Reserved69
            | Self::Reserved70
            | Self::Reserved73
            | Self::Reserved74
            | Self::Reserved76
            | Self::Reserved77
            | Self::Reserved91
            | Self::Reserved92 => "reserved",
        }
    }

    /// Returns `true` when this response carries an error payload.
    #[must_use]
    pub const fn is_error(&self) -> bool {
        matches!(self, Self::Error(_))
    }

    /// Returns the shared stdout contract when this response carries printable output.
    #[must_use]
    pub fn command_output(&self) -> Option<&CommandOutput> {
        match self {
            Self::NewSession(response) => response.command_output(),
            Self::ListWindows(response) => Some(response.command_output()),
            Self::ShowOptions(response) => Some(response.command_output()),
            Self::ShowBuffer(response) => Some(response.command_output()),
            Self::CapturePane(response) => response.command_output(),
            Self::DisplayMessage(response) => response.command_output(),
            Self::ResolveTarget(_) => None,
            Self::RunShell(response) => response.command_output(),
            Self::IfShell(response) => response.command_output(),
            Self::ListSessions(response) => Some(response.command_output()),
            Self::ListPanes(response) => Some(response.command_output()),
            Self::SetOptionByName(_) => None,
            Self::Handshake(_) => None,
            Self::SubscribePaneOutput(_)
            | Self::UnsubscribePaneOutput(_)
            | Self::PaneOutputCursor(_)
            | Self::PaneOutputLag(_)
            | Self::SdkWaitForOutput(_)
            | Self::CancelSdkWait(_)
            | Self::PaneBroadcastInput(_)
            | Self::CreateSessionLease(_)
            | Self::RenewSessionLease(_)
            | Self::ReleaseSessionLease(_) => None,
            _ => None,
        }
    }
}

/// Reusable stdout payload for commands that produce printable output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandOutput {
    /// The exact bytes the client should write to stdout.
    pub stdout: Vec<u8>,
}

impl CommandOutput {
    /// Creates a stdout payload from raw bytes.
    #[must_use]
    pub fn from_stdout(stdout: impl Into<Vec<u8>>) -> Self {
        Self {
            stdout: stdout.into(),
        }
    }

    /// Returns the raw stdout bytes.
    #[must_use]
    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }
}

/// Response payload for `select-layout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectLayoutResponse {
    /// The applied layout.
    pub layout: LayoutName,
}

/// Response payload for `set-buffer`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetBufferResponse {
    /// The name of the created or replaced buffer.
    pub buffer_name: String,
}

/// Response payload for `show-buffer`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShowBufferResponse {
    /// The pre-rendered stdout bytes for the CLI.
    pub output: CommandOutput,
}

impl ShowBufferResponse {
    /// Returns the reusable stdout payload.
    #[must_use]
    pub fn command_output(&self) -> &CommandOutput {
        &self.output
    }
}

/// Response payload for `paste-buffer`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasteBufferResponse {
    /// The buffer name that was pasted.
    pub buffer_name: String,
}

/// Response payload for `capture-pane`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapturePaneResponse {
    /// The created/replaced buffer name for non-printing captures.
    pub buffer_name: Option<String>,
    /// Captured stdout for `capture-pane -p`.
    pub output: Option<CommandOutput>,
    /// Output-ring watermark captured atomically with the pane contents.
    ///
    /// The value is the next Berth terminal output sequence at capture time.  Clients
    /// that pair a capture with a live output subscription can use it as the
    /// exact snapshot boundary instead of racing a separate pane-info call.
    #[serde(default)]
    pub output_sequence: u64,
}

impl CapturePaneResponse {
    /// Builds a non-printing capture response.
    #[must_use]
    pub fn from_buffer(buffer_name: String) -> Self {
        Self {
            buffer_name: Some(buffer_name),
            output: None,
            output_sequence: 0,
        }
    }

    /// Builds a printing capture response.
    #[must_use]
    pub fn from_output(output: CommandOutput) -> Self {
        Self {
            buffer_name: None,
            output: Some(output),
            output_sequence: 0,
        }
    }

    /// Attaches an output-ring watermark captured with the pane contents.
    #[must_use]
    pub const fn with_output_sequence(mut self, output_sequence: u64) -> Self {
        self.output_sequence = output_sequence;
        self
    }

    /// Returns the reusable stdout payload when this was a printing capture.
    #[must_use]
    pub fn command_output(&self) -> Option<&CommandOutput> {
        self.output.as_ref()
    }
}

/// Response payload for `clear-history`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClearHistoryResponse;

/// Response payload for `display-message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayMessageResponse {
    /// Expanded stdout for `display-message -p`.
    pub output: Option<CommandOutput>,
}

impl DisplayMessageResponse {
    /// Builds a non-printing display response.
    #[must_use]
    pub const fn no_output() -> Self {
        Self { output: None }
    }

    /// Builds a printing display response.
    #[must_use]
    pub fn from_output(output: CommandOutput) -> Self {
        Self {
            output: Some(output),
        }
    }

    /// Returns the reusable stdout payload when this was a printing display.
    #[must_use]
    pub fn command_output(&self) -> Option<&CommandOutput> {
        self.output.as_ref()
    }
}

/// Response payload for `run-shell`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunShellResponse {
    /// Captured stdout for foreground `run-shell`.
    pub output: Option<CommandOutput>,
    /// Exit status returned by a foreground shell command.
    pub exit_status: Option<i32>,
}

impl RunShellResponse {
    /// Builds a background `run-shell` response.
    #[must_use]
    pub const fn background() -> Self {
        Self {
            output: None,
            exit_status: None,
        }
    }

    /// Builds a response with no command output.
    #[must_use]
    pub const fn no_output() -> Self {
        Self::background()
    }

    /// Builds a foreground `run-shell` response.
    #[must_use]
    pub fn from_output(output: CommandOutput) -> Self {
        Self {
            output: Some(output),
            exit_status: Some(0),
        }
    }

    /// Builds a foreground shell response with an exact exit status.
    #[must_use]
    pub const fn from_exit_status(exit_status: i32) -> Self {
        Self {
            output: None,
            exit_status: Some(exit_status),
        }
    }

    /// Builds a foreground shell response with output and an exact exit status.
    #[must_use]
    pub fn from_output_and_exit_status(output: CommandOutput, exit_status: i32) -> Self {
        Self {
            output: Some(output),
            exit_status: Some(exit_status),
        }
    }

    /// Returns the reusable stdout payload for foreground `run-shell`.
    #[must_use]
    pub fn command_output(&self) -> Option<&CommandOutput> {
        self.output.as_ref()
    }

    /// Returns the shell exit status when the response came from a foreground shell.
    #[must_use]
    pub const fn exit_status(&self) -> Option<i32> {
        self.exit_status
    }
}

impl<'de> Deserialize<'de> for RunShellResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_struct(
            "RunShellResponse",
            &["output", "exit_status"],
            RunShellResponseVisitor,
        )
    }
}

struct RunShellResponseVisitor;

impl<'de> Visitor<'de> for RunShellResponseVisitor {
    type Value = RunShellResponse;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a run-shell response")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let output = seq
            .next_element()?
            .ok_or_else(|| de::Error::invalid_length(0, &self))?;
        let exit_status = compat_next_response_element(&mut seq)?;
        Ok(RunShellResponse {
            output,
            exit_status,
        })
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut output = None;
        let mut exit_status = None;

        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "output" => output = Some(map.next_value()?),
                "exit_status" => exit_status = Some(map.next_value()?),
                _ => {
                    let _: de::IgnoredAny = map.next_value()?;
                }
            }
        }

        Ok(RunShellResponse {
            output: output.ok_or_else(|| de::Error::missing_field("output"))?,
            exit_status: exit_status.unwrap_or_default(),
        })
    }
}

fn compat_next_response_element<'de, A, T>(seq: &mut A) -> Result<T, A::Error>
where
    A: SeqAccess<'de>,
    T: Deserialize<'de> + Default,
{
    match seq.next_element::<T>() {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Ok(T::default()),
        Err(error) if is_truncated_compat_sequence(&error) => Ok(T::default()),
        Err(error) => Err(error),
    }
}

fn is_truncated_compat_sequence(error: &impl std::fmt::Display) -> bool {
    let message = error.to_string();
    message.contains("UnexpectedEof") || message.contains("unexpected end of file")
}

/// Response payload for `if-shell`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IfShellResponse {
    /// Captured stdout from the selected nested command when it produced output.
    pub output: Option<CommandOutput>,
}

impl IfShellResponse {
    /// Builds a response with no nested command output.
    #[must_use]
    pub const fn no_output() -> Self {
        Self { output: None }
    }

    /// Builds a response with nested command output.
    #[must_use]
    pub fn from_output(output: CommandOutput) -> Self {
        Self {
            output: Some(output),
        }
    }

    /// Returns the reusable stdout payload when the selected nested command printed output.
    #[must_use]
    pub fn command_output(&self) -> Option<&CommandOutput> {
        self.output.as_ref()
    }
}

/// Response payload for `wait-for`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitForResponse;

/// Terminal state for a daemon-backed SDK byte wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SdkWaitOutcome {
    /// The requested byte sequence was observed.
    Matched,
    /// The wait was cancelled by a best-effort SDK cancel request or
    /// connection cleanup.
    Cancelled,
}

/// Response payload for a daemon-backed SDK byte wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdkWaitForOutputResponse {
    /// Wait ID that completed.
    pub wait_id: SdkWaitId,
    /// Terminal wait outcome.
    pub outcome: SdkWaitOutcome,
}

/// Response payload for best-effort daemon-backed SDK wait cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelSdkWaitResponse {
    /// Wait ID named by the cancellation request.
    pub wait_id: SdkWaitId,
    /// Whether a live wait was removed by this request.
    pub removed: bool,
}

/// Error response payload for detached RPC failures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// The shared wire-safe error value.
    pub error: TerminalError,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OptionScopeSelector, PaneOutputSubscriptionId, SetOptionMode};
    use serde::Serialize;
    use std::mem::size_of;

    #[derive(Serialize)]
    struct OldRunShellResponse {
        output: Option<CommandOutput>,
    }

    #[test]
    fn run_shell_response_deserializes_old_payloads_with_no_exit_status() {
        let bytes = bincode::serialize(&OldRunShellResponse { output: None })
            .expect("old run-shell response serializes");

        let decoded: RunShellResponse =
            bincode::deserialize(&bytes).expect("new run-shell response decodes old payload");

        assert_eq!(decoded.command_output(), None);
        assert_eq!(decoded.exit_status(), None);
    }

    #[test]
    fn response_command_names_cover_base_aliases_and_error_tag() {
        assert_eq!(
            Response::HasSession(HasSessionResponse { exists: true }).command_name(),
            "has-session"
        );
        assert_eq!(
            Response::SetOptionByName(SetOptionByNameResponse {
                scope: OptionScopeSelector::ServerGlobal,
                name: "status".to_owned(),
                mode: SetOptionMode::Replace,
            })
            .command_name(),
            "set-option"
        );
        assert_eq!(
            Response::KillServer(KillServerResponse).command_name(),
            "kill-server"
        );
        assert_eq!(
            Response::Error(ErrorResponse {
                error: TerminalError::Server("failed".to_owned()),
            })
            .command_name(),
            "error"
        );
        assert_eq!(
            Response::Handshake(HandshakeResponse::current()).command_name(),
            "handshake"
        );
        assert_eq!(
            Response::SdkWaitForOutput(SdkWaitForOutputResponse {
                wait_id: SdkWaitId::new(1),
                outcome: SdkWaitOutcome::Matched,
            })
            .command_name(),
            "sdk-wait-output"
        );
        assert_eq!(
            Response::CancelSdkWait(CancelSdkWaitResponse {
                wait_id: SdkWaitId::new(1),
                removed: false,
            })
            .command_name(),
            "cancel-sdk-wait"
        );
        assert_eq!(
            Response::WaitFor(WaitForResponse).command_name(),
            "wait-for"
        );
    }

    #[test]
    fn pr6g_response_boxing_keeps_response_size_bounded() {
        assert_eq!(size_of::<Box<PaneOutputLagResponse>>(), 8);
        assert_eq!(
            size_of::<Response>(),
            72,
            "Response should stay compact after boxing the two largest payload variants"
        );
        assert!(
            size_of::<PaneOutputLagResponse>() > size_of::<Response>(),
            "PaneOutputLagResponse must remain boxed while it is larger than Response"
        );
    }

    #[test]
    fn pr6g_boxed_response_payloads_are_bincode_transparent() {
        fn assert_transparent<T>(response: Response, payload: &T)
        where
            T: Serialize,
        {
            let mut expected = crate::frame_kind_for_response(&response)
                .bincode_tag()
                .to_le_bytes()
                .to_vec();
            expected.extend(bincode::serialize(payload).expect("payload encodes"));
            assert_eq!(
                bincode::serialize(&response).expect("response encodes"),
                expected
            );
        }

        let lag = PaneOutputLagResponse {
            subscription_id: PaneOutputSubscriptionId::new(7),
            cursor: PaneOutputCursor {
                next_sequence: 10,
                missed_events: 4,
            },
            lag: PaneOutputLagNotice {
                expected_sequence: 6,
                resume_sequence: 10,
                missed_events: 4,
                newest_sequence: 12,
                recent: PaneRecentOutput {
                    bytes: b"recent".to_vec(),
                    oldest_sequence: Some(10),
                    newest_sequence: Some(12),
                },
            },
        };
        assert_transparent(Response::PaneOutputLag(Box::new(lag.clone())), &lag);
    }
}
