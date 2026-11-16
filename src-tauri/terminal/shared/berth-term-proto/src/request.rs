//! Detached request contracts.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::{
    HandshakeRequest, PaneTarget, PaneTargetRef, SdkWaitId, SdkWaitOwnerId, SessionName, Target,
};

#[path = "request/compat.rs"]
mod compat;

#[path = "request/display.rs"]
mod display;
pub use display::{DisplayMessageExtRequest, DisplayMessageRequest};

#[path = "request/show.rs"]
mod show;
pub use show::{ShowEnvironmentRequest, ShowOptionsRequest};

#[path = "request/layout.rs"]
mod layout;
pub use layout::{
    SelectCustomLayoutRequest, SelectLayoutRequest, SelectLayoutTarget, SpreadLayoutRequest,
};

#[path = "request/pane.rs"]
mod pane;
pub use pane::{
    BreakPaneRequest, JoinPaneRequest, KillPaneRequest, LastPaneRequest, MovePaneRequest,
    PaneBroadcastInputRequest, PaneInputRequest, PaneKillRequest, PaneOutputCursorRequest,
    PaneOutputCursorWaitRequest, PaneOutputSubscriptionStart, PaneResizeRequest,
    PaneRespawnRequest, PaneSelectRequest, PaneSnapshotRefRequest, PaneSnapshotRequest,
    PaneSplitSize, PipePaneRequest, ResizePaneRequest, ResizePaneTargetActionRequest,
    RespawnPaneRequest, SelectPaneAdjacentRequest, SelectPaneDirection, SelectPaneMarkRequest,
    SelectPaneRequest, SendKeysExt2Request, SendKeysExtRequest, SendKeysRequest,
    SplitWindowExtRequest, SplitWindowRequest, SplitWindowTarget, SplitWindowTargetActionRequest,
    SubscribePaneOutputRefRequest, SubscribePaneOutputRequest, UnsubscribePaneOutputRequest,
};

#[path = "request/window.rs"]
mod window;
pub use window::{
    KillWindowRequest, LinkWindowRequest, ListWindowsRequest, MoveWindowRequest, MoveWindowTarget,
    NewWindowRequest, NextWindowRequest, PaneWindowOperation, PaneWindowRequest,
    PreviousWindowRequest, RenameWindowRequest, ResizeWindowAdjustment, ResizeWindowRequest,
    RespawnWindowRequest, RotateWindowDirection, RotateWindowRequest, SelectWindowRequest,
};

#[path = "request/target.rs"]
mod target;
pub use target::{ResolveTargetRequest, ResolveTargetType};

#[path = "request/session.rs"]
mod session;
pub use session::{
    CreateSessionLeaseRequest, HasSessionRequest, KillSessionRequest, ListSessionsRequest,
    NewSessionExtRequest, NewSessionRequest, ReleaseSessionLeaseRequest, RenameSessionRequest,
    RenewSessionLeaseRequest,
};

#[path = "request/server.rs"]
mod server;
pub use server::{KillServerRequest, ServerAccessRequest};

#[path = "request/client.rs"]
mod client;
pub use client::{
    AttachSessionExt2Request, AttachSessionExt3Request, AttachSessionExtRequest,
    AttachSessionRequest, DetachClientExtRequest, DetachClientRequest, ListClientsRequest,
    RefreshClientRequest, SwitchClientExt2Request, SwitchClientExt3Request,
};

#[path = "request/keys.rs"]
mod keys;
pub use keys::CopyModeRequest;

#[path = "request/options.rs"]
mod options;
pub use options::{
    SetEnvironmentMode, SetEnvironmentRequest, SetOptionByNameRequest, SetOptionRequest,
};

#[path = "request/buffer.rs"]
mod buffer;
pub use buffer::{
    CapturePaneRefRequest, CapturePaneRequest, CapturePaneTargetActionRequest, ClearHistoryRequest,
    PasteBufferRequest, SetBufferRequest, ShowBufferRequest,
};

/// All detached public command and internal RPC requests supported by the wire
/// protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Request {
    /// `new-session`
    NewSession(NewSessionRequest),
    /// `has-session`
    HasSession(HasSessionRequest),
    /// `kill-session`
    KillSession(KillSessionRequest),
    /// `new-window`
    NewWindow(Box<NewWindowRequest>),
    /// `kill-window`
    KillWindow(KillWindowRequest),
    /// `select-window`
    SelectWindow(SelectWindowRequest),
    /// `rename-window`
    RenameWindow(RenameWindowRequest),
    /// `next-window`
    NextWindow(NextWindowRequest),
    /// `previous-window`
    PreviousWindow(PreviousWindowRequest),
    /// 已删除（原 `last-window`）。只占住 bincode 标签 9，永不复用。
    Reserved9,
    /// `list-windows`
    ListWindows(ListWindowsRequest),
    /// 已删除（原 `move-window`）。只占住 bincode 标签 11，永不复用。
    Reserved11,
    /// 已删除（原 `swap-window`）。只占住 bincode 标签 12，永不复用。
    Reserved12,
    /// 已删除（原 `rotate-window`）。只占住 bincode 标签 13，永不复用。
    Reserved13,
    /// `split-window`
    SplitWindow(SplitWindowRequest),
    /// 已删除（原 `swap-pane`）。只占住 bincode 标签 15，永不复用。
    Reserved15,
    /// 已删除（原 `last-pane`）。只占住 bincode 标签 16，永不复用。
    Reserved16,
    /// 已删除（原 `join-pane`）。只占住 bincode 标签 17，永不复用。
    Reserved17,
    /// 已删除（原 `break-pane`）。只占住 bincode 标签 18，永不复用。
    Reserved18,
    /// `kill-pane`
    KillPane(KillPaneRequest),
    /// `select-layout`
    SelectLayout(SelectLayoutRequest),
    /// `resize-pane`
    ResizePane(ResizePaneRequest),
    /// 已删除（原 `display-panes`）。只占住 bincode 标签 22，永不复用。
    Reserved22,
    /// `select-pane`
    SelectPane(Box<SelectPaneRequest>),
    /// `select-pane -U/-D/-L/-R`
    SelectPaneAdjacent(SelectPaneAdjacentRequest),
    /// `send-keys`
    SendKeys(SendKeysRequest),
    /// `attach-session`
    AttachSession(AttachSessionRequest),
    /// 已删除（原 `switch-client`）。只占住 bincode 标签 27，永不复用。
    Reserved27,
    /// `detach-client`
    DetachClient(DetachClientRequest),
    /// `set-option`
    SetOption(SetOptionRequest),
    /// 已删除（原 `set-environment`）。只占住 bincode 标签 30，永不复用。
    Reserved30,
    /// 已删除（原 `set-hook`）。只占住 bincode 标签 31，永不复用。
    Reserved31,
    /// 已删除（原 `next-layout`）。只占住 bincode 标签 32，永不复用。
    Reserved32,
    /// 已删除（原 `previous-layout`）。只占住 bincode 标签 33，永不复用。
    Reserved33,
    /// `show-options`
    ShowOptions(ShowOptionsRequest),
    /// 已删除（原 `show-environment`）。只占住 bincode 标签 35，永不复用。
    Reserved35,
    /// `set-buffer`
    SetBuffer(SetBufferRequest),
    /// `show-buffer`
    ShowBuffer(ShowBufferRequest),
    /// `paste-buffer`
    PasteBuffer(Box<PasteBufferRequest>),
    /// 已删除（原 `list-buffers`）。只占住 bincode 标签 39，永不复用。
    Reserved39,
    /// 已删除（原 `delete-buffer`）。只占住 bincode 标签 40，永不复用。
    Reserved40,
    /// 已删除（原 `load-buffer`）。只占住 bincode 标签 41，永不复用。
    Reserved41,
    /// 已删除（原 `save-buffer`）。只占住 bincode 标签 42，永不复用。
    Reserved42,
    /// `capture-pane`
    CapturePane(Box<CapturePaneRequest>),
    /// `display-message`
    DisplayMessage(DisplayMessageRequest),
    /// `run-shell`
    RunShell(Box<RunShellRequest>),
    /// `if-shell`
    IfShell(Box<IfShellRequest>),
    /// `wait-for`
    WaitFor(WaitForRequest),
    /// `rename-session`
    RenameSession(RenameSessionRequest),
    /// `list-sessions`
    ListSessions(ListSessionsRequest),
    /// `list-panes`
    ListPanes(ListPanesRequest),
    /// 已删除（原 `source-file`）。只占住 bincode 标签 51，永不复用。
    Reserved51,
    /// `set-option` using an open string-based option name.
    SetOptionByName(Box<SetOptionByNameRequest>),
    /// 已删除（原 `set-hook`）。只占住 bincode 标签 53，永不复用。
    Reserved53,
    /// 已删除（原 `show-hooks`）。只占住 bincode 标签 54，永不复用。
    Reserved54,
    /// Extended `send-keys` semantics including key-table dispatch and format expansion.
    SendKeysExt(SendKeysExtRequest),
    /// 已删除（原 `switch-client`）。只占住 bincode 标签 56，永不复用。
    Reserved56,
    /// 已删除（原 `bind-key`）。只占住 bincode 标签 57，永不复用。
    Reserved57,
    /// 已删除（原 `unbind-key`）。只占住 bincode 标签 58，永不复用。
    Reserved58,
    /// 已删除（原 `list-keys`）。只占住 bincode 标签 59，永不复用。
    Reserved59,
    /// 已删除（原 `send-prefix`）。只占住 bincode 标签 60，永不复用。
    Reserved60,
    /// `clear-history`
    ClearHistory(ClearHistoryRequest),
    /// `copy-mode`
    CopyMode(CopyModeRequest),
    /// 已删除（原 `control-mode`）。只占住 bincode 标签 63，永不复用。
    Reserved63,
    /// 已删除（原 `clock-mode`）。只占住 bincode 标签 64，永不复用。
    Reserved64,
    /// 已删除（原 `show-messages`）。只占住 bincode 标签 65，永不复用。
    Reserved65,
    /// Extended `new-session` semantics including grouped sessions and attach-if-exists.
    NewSessionExt(Box<NewSessionExtRequest>),
    /// Extended `attach-session` semantics including client flags and detach-others.
    AttachSessionExt(AttachSessionExtRequest),
    /// 已删除（原 `switch-client`）。只占住 bincode 标签 68，永不复用。
    Reserved68,
    /// 已删除（原 `select-layout`）。只占住 bincode 标签 69，永不复用。
    Reserved69,
    /// 已删除（原 `select-layout`）。只占住 bincode 标签 70，永不复用。
    Reserved70,
    /// `select-layout -E`
    SpreadLayout(SpreadLayoutRequest),
    /// `kill-server`
    KillServer(KillServerRequest),
    /// 已删除（原 `lock-server`）。只占住 bincode 标签 73，永不复用。
    Reserved73,
    /// 已删除（原 `lock-session`）。只占住 bincode 标签 74，永不复用。
    Reserved74,
    /// 已删除（原 `lock-client`）。只占住 bincode 标签 75，永不复用。
    Reserved75,
    /// 已删除（原 `server-access`）。只占住 bincode 标签 76，永不复用。
    Reserved76,
    /// 已删除（原 `refresh-client`）。只占住 bincode 标签 77，永不复用。
    Reserved77,
    /// 已删除（原 `list-clients`）。只占住 bincode 标签 78，永不复用。
    Reserved78,
    /// 已删除（原 `suspend-client`）。只占住 bincode 标签 79，永不复用。
    Reserved79,
    /// Extended `detach-client` semantics including `-a`, `-s`, `-P`, and `-E`.
    DetachClientExt(DetachClientExtRequest),
    /// Further-extended `attach-session` semantics including `-c working-directory`.
    AttachSessionExt2(Box<AttachSessionExt2Request>),
    /// 已删除（原 `switch-client`）。只占住 bincode 标签 82，永不复用。
    Reserved82,
    /// `resize-window`
    ResizeWindow(ResizeWindowRequest),
    /// `respawn-window`
    RespawnWindow(Box<RespawnWindowRequest>),
    /// 已删除（原 `move-pane`）。只占住 bincode 标签 85，永不复用。
    Reserved85,
    /// 已删除（原 `pipe-pane`）。只占住 bincode 标签 86，永不复用。
    Reserved86,
    /// `respawn-pane`
    RespawnPane(Box<RespawnPaneRequest>),
    /// 已删除（原 `link-window`）。只占住 bincode 标签 88，永不复用。
    Reserved88,
    /// 已删除（原 `unlink-window`）。只占住 bincode 标签 89，永不复用。
    Reserved89,
    /// `select-pane -m` / `select-pane -M`
    SelectPaneMark(SelectPaneMarkRequest),
    /// Internal detached target resolution for tmux-style raw target text.
    ResolveTarget(ResolveTargetRequest),
    /// Extended `split-window` semantics including an explicit shell command.
    SplitWindowExt(Box<SplitWindowExtRequest>),
    /// Internal SDK/daemon version and capability negotiation.
    Handshake(HandshakeRequest),
    /// Internal daemon-backed structured pane snapshot endpoint.
    PaneSnapshot(PaneSnapshotRequest),
    /// Internal daemon-backed pane output subscription endpoint.
    SubscribePaneOutput(SubscribePaneOutputRequest),
    /// Internal daemon-backed pane output unsubscription endpoint.
    UnsubscribePaneOutput(UnsubscribePaneOutputRequest),
    /// Internal daemon-backed pane output cursor polling endpoint.
    PaneOutputCursor(PaneOutputCursorRequest),
    /// Internal daemon-backed SDK byte wait endpoint.
    SdkWaitForOutput(SdkWaitForOutputRequest),
    /// Internal daemon-backed SDK wait cancellation endpoint.
    CancelSdkWait(CancelSdkWaitRequest),
    /// SDK pane input endpoint with stable pane-id targeting.
    PaneInput(PaneInputRequest),
    /// SDK pane resize endpoint with stable pane-id targeting.
    PaneResize(PaneResizeRequest),
    /// SDK pane kill endpoint with stable pane-id targeting.
    PaneKill(PaneKillRequest),
    /// SDK pane respawn endpoint with stable pane-id targeting.
    PaneRespawn(Box<PaneRespawnRequest>),
    /// SDK pane snapshot endpoint with stable pane-id targeting.
    PaneSnapshotRef(PaneSnapshotRefRequest),
    /// SDK pane select/title endpoint with stable pane-id targeting.
    PaneSelect(PaneSelectRequest),
    /// SDK pane input broadcast endpoint with stable pane-id targeting.
    PaneBroadcastInput(PaneBroadcastInputRequest),
    /// SDK app-owned session lease create endpoint.
    CreateSessionLease(CreateSessionLeaseRequest),
    /// SDK app-owned session lease renewal endpoint.
    RenewSessionLease(RenewSessionLeaseRequest),
    /// SDK app-owned session lease release endpoint.
    ReleaseSessionLease(ReleaseSessionLeaseRequest),
    /// Internal daemon-backed pane output subscription endpoint with stable pane-id targeting.
    SubscribePaneOutputRef(SubscribePaneOutputRefRequest),
    /// Internal daemon-backed SDK byte wait endpoint with stable pane-id targeting.
    SdkWaitForOutputRef(SdkWaitForOutputRefRequest),
    /// 已删除（原 `daemon-status`）。只占住 bincode 标签 112，永不复用。
    Reserved112,
    /// 已删除（原 `shutdown-if-idle`）。只占住 bincode 标签 113，永不复用。
    Reserved113,
    /// 已删除（原 `web-share`）。只占住 bincode 标签 114，永不复用。
    Reserved114,
    /// `display-message` extension with target-client context.
    DisplayMessageExt(Box<DisplayMessageExtRequest>),
    /// `send-keys` extension with target-client context.
    SendKeysExt2(Box<SendKeysExt2Request>),
    /// Attach-session extension with attach-stream client capabilities.
    AttachSessionExt3(Box<AttachSessionExt3Request>),
    /// `split-window` with raw target text resolved server-side.
    SplitWindowTargetAction(Box<SplitWindowTargetActionRequest>),
    /// `resize-pane` with raw target text resolved server-side.
    ResizePaneTargetAction(ResizePaneTargetActionRequest),
    /// `capture-pane` with raw target text resolved server-side.
    CapturePaneTargetAction(Box<CapturePaneTargetActionRequest>),
    /// 内部 capture 请求，携带可在 daemon 同锁校验的 pane 目标。
    CapturePaneRef(Box<CapturePaneRefRequest>),
    /// 内部窗口操作，先同锁校验 pane id/代际再操作当前所在窗口。
    PaneWindow(PaneWindowRequest),
    /// Capability-gated pane output cursor that waits daemon-side for output.
    PaneOutputCursorWait(PaneOutputCursorWaitRequest),
}

impl Request {
    /// 是否为已删除命令的占位变体（`Reserved<标签>`，只占 bincode 标签）。
    #[must_use]
    pub fn is_reserved(&self) -> bool {
        self.command_name() == "reserved"
    }

    /// Returns the stable routing name for the request variant.
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
            Self::SplitWindow(_) | Self::SplitWindowExt(_) | Self::SplitWindowTargetAction(_) => {
                "split-window"
            }
            Self::KillPane(_) => "kill-pane",
            Self::SelectLayout(_) => "select-layout",
            Self::ResizePane(_) => "resize-pane",
            Self::SelectPane(_) | Self::SelectPaneAdjacent(_) | Self::SelectPaneMark(_) => {
                "select-pane"
            }
            Self::SendKeys(_) | Self::SendKeysExt2(_) => "send-keys",
            Self::AttachSession(_) => "attach-session",
            Self::DetachClient(_) => "detach-client",
            Self::SetOption(_) => "set-option",
            Self::ShowOptions(_) => "show-options",
            Self::SetBuffer(_) => "set-buffer",
            Self::PasteBuffer(_) => "paste-buffer",
            Self::CapturePane(_) | Self::CapturePaneTargetAction(_) | Self::CapturePaneRef(_) => {
                "capture-pane"
            }
            Self::PaneWindow(request) => match request.operation {
                PaneWindowOperation::Resize { .. } => "resize-window",
                PaneWindowOperation::Close => "kill-window",
            },
            Self::PaneSnapshot(_) => "pane-snapshot",
            Self::SubscribePaneOutput(_) | Self::SubscribePaneOutputRef(_) => {
                "subscribe-pane-output"
            }
            Self::UnsubscribePaneOutput(_) => "unsubscribe-pane-output",
            Self::PaneOutputCursor(_) | Self::PaneOutputCursorWait(_) => "pane-output-cursor",
            Self::SdkWaitForOutput(_) | Self::SdkWaitForOutputRef(_) => "sdk-wait-output",
            Self::CancelSdkWait(_) => "cancel-sdk-wait",
            Self::PaneInput(_) => "send-keys",
            Self::PaneBroadcastInput(_) => "send-keys",
            Self::CreateSessionLease(_) => "create-session-lease",
            Self::RenewSessionLease(_) => "renew-session-lease",
            Self::ReleaseSessionLease(_) => "release-session-lease",
            Self::PaneResize(_) | Self::ResizePaneTargetAction(_) => "resize-pane",
            Self::PaneKill(_) => "kill-pane",
            Self::PaneRespawn(_) => "respawn-pane",
            Self::PaneSnapshotRef(_) => "pane-snapshot",
            Self::PaneSelect(_) => "select-pane",
            Self::DisplayMessage(_) | Self::DisplayMessageExt(_) => "display-message",
            Self::ResolveTarget(_) => "resolve-target",
            Self::RunShell(_) => "run-shell",
            Self::IfShell(_) => "if-shell",
            Self::WaitFor(_) => "wait-for",
            Self::RenameSession(_) => "rename-session",
            Self::ListSessions(_) => "list-sessions",
            Self::ListPanes(_) => "list-panes",
            Self::SetOptionByName(_) => "set-option",
            Self::SendKeysExt(_) => "send-keys",
            Self::ClearHistory(_) => "clear-history",
            Self::CopyMode(_) => "copy-mode",
            Self::NewSessionExt(_) => "new-session",
            Self::AttachSessionExt(_) => "attach-session",
            Self::SpreadLayout(_) => "select-layout",
            Self::ResizeWindow(_) => "resize-window",
            Self::RespawnWindow(_) => "respawn-window",
            Self::RespawnPane(_) => "respawn-pane",
            Self::KillServer(_) => "kill-server",
            Self::DetachClientExt(_) => "detach-client",
            Self::AttachSessionExt2(_) | Self::AttachSessionExt3(_) => "attach-session",
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
            | Self::Reserved27
            | Self::Reserved30
            | Self::Reserved31
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
            | Self::Reserved56
            | Self::Reserved57
            | Self::Reserved58
            | Self::Reserved59
            | Self::Reserved60
            | Self::Reserved63
            | Self::Reserved64
            | Self::Reserved65
            | Self::Reserved68
            | Self::Reserved69
            | Self::Reserved70
            | Self::Reserved73
            | Self::Reserved74
            | Self::Reserved75
            | Self::Reserved76
            | Self::Reserved77
            | Self::Reserved78
            | Self::Reserved79
            | Self::Reserved82
            | Self::Reserved85
            | Self::Reserved86
            | Self::Reserved88
            | Self::Reserved89
            | Self::Reserved112
            | Self::Reserved113
            | Self::Reserved114 => "reserved",
        }
    }
}

/// Request payload for `run-shell`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunShellRequest {
    /// The server-local shell command passed to `sh -c`.
    pub command: String,
    /// Whether the command should run fire-and-forget without output capture.
    pub background: bool,
    /// Whether the command should be executed as tmux commands instead of `sh -c`.
    #[serde(default)]
    pub as_commands: bool,
    /// Whether stderr should be captured alongside stdout.
    #[serde(default)]
    pub show_stderr: bool,
    /// Optional delay, in seconds, before the command runs.
    #[serde(default)]
    pub delay_seconds: Option<RunShellDelaySeconds>,
    /// Optional explicit working directory.
    #[serde(default)]
    pub start_directory: Option<PathBuf>,
    /// Optional explicit target pane used for format and session context.
    #[serde(default)]
    pub target: Option<PaneTarget>,
    /// Internal source-file recursion depth inherited by queued run-shell.
    #[serde(default)]
    pub source_depth: Option<usize>,
}

/// Losslessly serializable `run-shell -d` seconds value with stable `Eq`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RunShellDelaySeconds(pub f64);

impl RunShellDelaySeconds {
    /// Returns the raw seconds value.
    #[must_use]
    pub const fn as_secs_f64(self) -> f64 {
        self.0
    }
}

impl PartialEq for RunShellDelaySeconds {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits()
    }
}

impl Eq for RunShellDelaySeconds {}

/// Request payload for `if-shell`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IfShellRequest {
    /// The condition string expanded through the shared formatter before evaluation.
    pub condition: String,
    /// Whether to evaluate the expanded condition with format truthiness instead of `sh -c`.
    pub format_mode: bool,
    /// The nested Berth terminal command string dispatched when the condition is true.
    pub then_command: String,
    /// The optional nested Berth terminal command string dispatched when the condition is false.
    pub else_command: Option<String>,
    /// Optional exact target used as shared-format context.
    pub target: Option<Target>,
    /// The caller working directory used to resolve nested relative file paths.
    pub caller_cwd: Option<PathBuf>,
    /// Whether the condition should be evaluated asynchronously.
    #[serde(default)]
    pub background: bool,
}

/// The supported `wait-for` operation modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WaitForMode {
    /// Wait for the next signal on the named channel.
    Wait,
    /// Signal all current plain waiters on the named channel.
    Signal,
    /// Acquire the named server-local lock, waiting in FIFO order when held.
    Lock,
    /// Release the named server-local lock.
    Unlock,
}

/// Request payload for `wait-for`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitForRequest {
    /// The server-local wait channel name.
    pub channel: String,
    /// The selected wait operation.
    pub mode: WaitForMode,
}

/// Request payload for a daemon-backed SDK byte wait.
///
/// This is intentionally distinct from tmux-compatible [`WaitForRequest`].
/// SDK waits are pane-output waits with typed IDs used only for cancellation
/// and teardown bookkeeping; they never signal or lock tmux `wait-for`
/// channels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdkWaitForOutputRequest {
    /// Opaque SDK transport owner for this wait.
    pub owner_id: SdkWaitOwnerId,
    /// Wait ID allocated by the SDK under `owner_id`.
    pub wait_id: SdkWaitId,
    /// Pane whose raw output stream is observed.
    pub target: PaneTarget,
    /// Raw byte sequence to search for in pane output.
    pub bytes: Vec<u8>,
    /// Cursor position used when arming the wait.
    pub start: PaneOutputSubscriptionStart,
}

/// Request payload for a daemon-backed SDK byte wait by slot or stable id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SdkWaitForOutputRefRequest {
    /// Opaque SDK transport owner for this wait.
    pub owner_id: SdkWaitOwnerId,
    /// Wait ID allocated by the SDK under `owner_id`.
    pub wait_id: SdkWaitId,
    /// Pane whose raw output stream is observed.
    pub target: PaneTargetRef,
    /// Raw byte sequence to search for in pane output.
    pub bytes: Vec<u8>,
    /// Cursor position used when arming the wait.
    pub start: PaneOutputSubscriptionStart,
}

/// Request payload for best-effort cancellation of a daemon-backed SDK wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelSdkWaitRequest {
    /// Opaque SDK transport owner for the wait being cancelled.
    pub owner_id: SdkWaitOwnerId,
    /// Wait ID allocated by the SDK under `owner_id`.
    pub wait_id: SdkWaitId,
}

/// Request payload for `list-panes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListPanesRequest {
    /// The exact target session name.
    pub target: SessionName,
    /// Optional exact target window index.
    #[serde(default)]
    pub target_window_index: Option<u32>,
    /// An optional server-side format template.
    pub format: Option<String>,
}

#[cfg(test)]
#[path = "request/compat_tests.rs"]
mod compat_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        OptionScopeSelector, PaneTarget, SelectPaneDirection, SetOptionMode, SplitDirection,
    };
    use serde::Serialize;
    use std::mem::size_of;

    fn alpha() -> SessionName {
        SessionName::new("alpha").expect("valid session")
    }

    fn pane() -> PaneTarget {
        PaneTarget::new(alpha(), 0)
    }

    #[test]
    fn request_command_names_cover_extended_aliases_and_internal_tags() {
        assert_eq!(
            Request::NewSessionExt(Box::new(NewSessionExtRequest {
                session_name: None,
                working_directory: None,
                detached: true,
                size: None,
                environment: None,
                group_target: None,
                attach_if_exists: false,
                detach_other_clients: false,
                kill_other_clients: false,
                flags: None,
                window_name: None,
                print_session_info: false,
                print_format: None,
                command: None,
                process_command: None,
                client_environment: None,
                skip_environment_update: false,
            }))
            .command_name(),
            "new-session"
        );
        assert_eq!(
            Request::SplitWindowExt(Box::new(SplitWindowExtRequest {
                target: SplitWindowTarget::Pane(pane()),
                direction: SplitDirection::Vertical,
                before: false,
                environment: None,
                command: None,
                process_command: None,
                start_directory: None,
                keep_alive_on_exit: None,
                detached: false,
                size: None,
                preserve_zoom: false,
                full_size: false,
                stdin_payload: None,
            }))
            .command_name(),
            "split-window"
        );
        assert_eq!(
            Request::SelectPaneAdjacent(SelectPaneAdjacentRequest {
                target: pane(),
                direction: SelectPaneDirection::Right,
                preserve_zoom: false,
            })
            .command_name(),
            "select-pane"
        );
        assert_eq!(
            Request::SelectPaneMark(SelectPaneMarkRequest {
                target: pane(),
                clear: false,
                title: None,
            })
            .command_name(),
            "select-pane"
        );
        assert_eq!(
            Request::SetOptionByName(Box::new(SetOptionByNameRequest {
                scope: OptionScopeSelector::ServerGlobal,
                name: "status".to_owned(),
                value: Some("on".to_owned()),
                mode: SetOptionMode::Replace,
                only_if_unset: false,
                unset: false,
                unset_pane_overrides: false,
                format: false,
                format_target: None,
            }))
            .command_name(),
            "set-option"
        );
        assert_eq!(
            Request::AttachSessionExt2(Box::new(AttachSessionExt2Request {
                target: Some(alpha()),
                target_spec: None,
                detach_other_clients: false,
                kill_other_clients: false,
                read_only: false,
                skip_environment_update: false,
                flags: None,
                working_directory: None,
                client_terminal: crate::ClientTerminalContext::default(),
                client_size: None,
            }))
            .command_name(),
            "attach-session"
        );
        assert_eq!(
            Request::AttachSessionExt3(Box::new(AttachSessionExt3Request::from_ext2(
                AttachSessionExt2Request {
                    target: Some(alpha()),
                    target_spec: None,
                    detach_other_clients: false,
                    kill_other_clients: false,
                    read_only: false,
                    skip_environment_update: false,
                    flags: None,
                    working_directory: None,
                    client_terminal: crate::ClientTerminalContext::default(),
                    client_size: None,
                },
                vec![crate::CAPABILITY_ATTACH_RENDER.to_owned()],
            )))
            .command_name(),
            "attach-session"
        );
        assert_eq!(
            Request::ResolveTarget(ResolveTargetRequest {
                target: Some("alpha:0.0".to_owned()),
                target_type: ResolveTargetType::Pane,
                window_index: false,
                prefer_unattached: false,
            })
            .command_name(),
            "resolve-target"
        );
        assert_eq!(
            Request::Handshake(HandshakeRequest::current()).command_name(),
            "handshake"
        );
        assert_eq!(
            Request::SdkWaitForOutput(SdkWaitForOutputRequest {
                owner_id: SdkWaitOwnerId::new(1),
                wait_id: SdkWaitId::new(1),
                target: pane(),
                bytes: b"ready".to_vec(),
                start: PaneOutputSubscriptionStart::Now,
            })
            .command_name(),
            "sdk-wait-output"
        );
        assert_eq!(
            Request::CancelSdkWait(CancelSdkWaitRequest {
                owner_id: SdkWaitOwnerId::new(1),
                wait_id: SdkWaitId::new(1),
            })
            .command_name(),
            "cancel-sdk-wait"
        );
        assert_eq!(
            Request::WaitFor(WaitForRequest {
                channel: "ready".to_owned(),
                mode: WaitForMode::Wait,
            })
            .command_name(),
            "wait-for"
        );
    }

    #[test]
    fn pr6g_request_boxing_keeps_request_size_bounded() {
        let request_size = size_of::<Request>();
        let box_size = size_of::<Box<NewSessionExtRequest>>();

        eprintln!("PR6G size baseline: Request={request_size} Box<T>={box_size}");
        eprintln!(
            "PR6G candidate sizes: NewSessionExt={} NewWindow={} SetOptionByName={} \
             AttachSessionExt3={} SwitchClientExt3={} SendKeysExt2={}",
            size_of::<NewSessionExtRequest>(),
            size_of::<NewWindowRequest>(),
            size_of::<SetOptionByNameRequest>(),
            size_of::<AttachSessionExt3Request>(),
            size_of::<SwitchClientExt3Request>(),
            size_of::<SendKeysExt2Request>(),
        );
        let mut remaining = [
            ("AttachSessionExt2", size_of::<AttachSessionExt2Request>()),
            ("BreakPane", size_of::<BreakPaneRequest>()),
            ("CapturePane", size_of::<CapturePaneRequest>()),
            ("ClearHistory", size_of::<ClearHistoryRequest>()),
            ("CopyMode", size_of::<CopyModeRequest>()),
            ("CreateSessionLease", size_of::<CreateSessionLeaseRequest>()),
            ("DetachClientExt", size_of::<DetachClientExtRequest>()),
            ("DisplayMessage", size_of::<DisplayMessageRequest>()),
            ("DisplayMessageExt", size_of::<DisplayMessageExtRequest>()),
            ("Handshake", size_of::<HandshakeRequest>()),
            ("IfShell", size_of::<IfShellRequest>()),
            ("JoinPane", size_of::<JoinPaneRequest>()),
            ("KillPane", size_of::<KillPaneRequest>()),
            ("KillWindow", size_of::<KillWindowRequest>()),
            ("LinkWindow", size_of::<LinkWindowRequest>()),
            ("ListClients", size_of::<ListClientsRequest>()),
            ("ListPanes", size_of::<ListPanesRequest>()),
            ("ListSessions", size_of::<ListSessionsRequest>()),
            ("ListWindows", size_of::<ListWindowsRequest>()),
            ("MovePane", size_of::<MovePaneRequest>()),
            ("MoveWindow", size_of::<MoveWindowRequest>()),
            ("NewSession", size_of::<NewSessionRequest>()),
            ("PasteBuffer", size_of::<PasteBufferRequest>()),
            ("PaneInput", size_of::<PaneInputRequest>()),
            ("PaneKill", size_of::<PaneKillRequest>()),
            ("PaneResize", size_of::<PaneResizeRequest>()),
            ("PaneRespawn", size_of::<PaneRespawnRequest>()),
            ("PaneSelect", size_of::<PaneSelectRequest>()),
            ("PaneSnapshot", size_of::<PaneSnapshotRequest>()),
            ("PaneSnapshotRef", size_of::<PaneSnapshotRefRequest>()),
            ("PipePane", size_of::<PipePaneRequest>()),
            ("RefreshClient", size_of::<RefreshClientRequest>()),
            ("RespawnPane", size_of::<RespawnPaneRequest>()),
            ("RespawnWindow", size_of::<RespawnWindowRequest>()),
            ("ResizePane", size_of::<ResizePaneRequest>()),
            ("ResizeWindow", size_of::<ResizeWindowRequest>()),
            ("RotateWindow", size_of::<RotateWindowRequest>()),
            ("RunShell", size_of::<RunShellRequest>()),
            ("SelectCustomLayout", size_of::<SelectCustomLayoutRequest>()),
            ("SelectLayout", size_of::<SelectLayoutRequest>()),
            ("SelectPane", size_of::<SelectPaneRequest>()),
            ("SelectPaneAdjacent", size_of::<SelectPaneAdjacentRequest>()),
            ("SelectPaneMark", size_of::<SelectPaneMarkRequest>()),
            ("SetEnvironment", size_of::<SetEnvironmentRequest>()),
            ("SetBuffer", size_of::<SetBufferRequest>()),
            ("SetOption", size_of::<SetOptionRequest>()),
            ("ShowBuffer", size_of::<ShowBufferRequest>()),
            ("ShowEnvironment", size_of::<ShowEnvironmentRequest>()),
            ("ShowOptions", size_of::<ShowOptionsRequest>()),
            ("SplitWindow", size_of::<SplitWindowRequest>()),
            ("SplitWindowExt", size_of::<SplitWindowExtRequest>()),
            (
                "SubscribePaneOutput",
                size_of::<SubscribePaneOutputRequest>(),
            ),
            (
                "SubscribePaneOutputRef",
                size_of::<SubscribePaneOutputRefRequest>(),
            ),
            ("SwitchClientExt2", size_of::<SwitchClientExt2Request>()),
        ];
        remaining.sort_by_key(|(_, size)| std::cmp::Reverse(*size));
        eprintln!("PR6G largest remaining candidates: {remaining:?}");

        assert!(
            request_size <= 96,
            "Request grew past the PR6G boxed payload budget: {request_size}"
        );
        assert_eq!(box_size, size_of::<usize>());
    }

    #[test]
    fn pr6g_boxed_payloads_are_bincode_transparent_for_request_candidates() {
        assert_box_serializes_like_value(NewSessionExtRequest {
            session_name: Some(alpha()),
            working_directory: Some("/tmp".to_owned()),
            detached: true,
            size: Some(crate::TerminalSize {
                cols: 120,
                rows: 40,
            }),
            environment: Some(vec!["A=B".to_owned()]),
            group_target: None,
            attach_if_exists: false,
            detach_other_clients: false,
            kill_other_clients: false,
            flags: Some(vec!["read-only".to_owned()]),
            window_name: Some("main".to_owned()),
            print_session_info: true,
            print_format: Some("#{session_name}".to_owned()),
            command: Some(vec!["sh".to_owned(), "-lc".to_owned(), "true".to_owned()]),
            process_command: None,
            client_environment: Some(vec!["PATH=/bin".to_owned()]),
            skip_environment_update: false,
        });
        assert_box_serializes_like_value(SetOptionByNameRequest {
            scope: OptionScopeSelector::ServerGlobal,
            name: "@plugin".to_owned(),
            value: Some("enabled".to_owned()),
            mode: SetOptionMode::Replace,
            only_if_unset: false,
            unset: false,
            unset_pane_overrides: false,
            format: true,
            format_target: Some(crate::Target::Session(alpha())),
        });
        assert_box_serializes_like_value(AttachSessionExt3Request::from_ext2(
            AttachSessionExt2Request {
                target: Some(alpha()),
                target_spec: Some("alpha:0.0".to_owned()),
                detach_other_clients: false,
                kill_other_clients: false,
                read_only: true,
                skip_environment_update: false,
                flags: Some(vec!["active-pane".to_owned()]),
                working_directory: Some("/tmp".to_owned()),
                client_terminal: crate::ClientTerminalContext::default(),
                client_size: Some(crate::TerminalSize { cols: 80, rows: 24 }),
            },
            vec![crate::CAPABILITY_ATTACH_RENDER.to_owned()],
        ));
    }

    fn assert_box_serializes_like_value<T>(value: T)
    where
        T: Clone + Serialize,
    {
        let boxed = Box::new(value.clone());
        assert_eq!(
            bincode::serialize(&value).expect("value encodes"),
            bincode::serialize(&boxed).expect("boxed value encodes"),
            "Box<T> must be transparent before PR6G boxes enum variants"
        );
    }
}
