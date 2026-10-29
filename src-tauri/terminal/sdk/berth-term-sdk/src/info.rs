//! Inert session/window/pane info-snapshot DTOs for SDK consumers.
//!
//! The types in this module describe the *sticky* v1 metadata and process
//! state the daemon retains for every session, window, and pane. They are
//! pure DTOs: the SDK does not call into `berth-term-engine`, `berth-term-server`, or
//! `berth-term-pty` from this module, and it does not poll, subscribe, or
//! reconcile state. Consumers receive an [`InfoSnapshot`] from a
//! daemon-backed handle and read it as captured.
//!
//! Identity newtypes (`SessionName`, `SessionId`, `WindowId`, `PaneId`) are
//! re-exported from `berth-term-proto` via [`crate::types`] so SDK users never
//! depend on `berth-term-engine`, `berth-term-server`, `berth-cli`, or `berth-term-pty` to
//! describe an info snapshot.
//!
//! Pane metadata in this module deliberately omits any `env` /
//! `environment` field: per-pane process environment is not part of the
//! sticky info surface and is never exposed to public SDK consumers. The
//! [`PaneInfo`] vocabulary therefore covers `command`, `working_directory`,
//! `tags`, `size`, `process` state, `generation`, `revision`,
//! `output_sequence`, and `exit_state` — but not `env`.
//!
//! ## Lag recovery via `info()`
//!
//! The daemon-backed SDK handle exposes a synchronous `info()` accessor (or
//! its async equivalent on the asynchronous handle) that re-reads the
//! sticky metadata and returns a fresh [`InfoSnapshot`]. This call is the
//! canonical *lag-recovery* path after one of the following:
//!
//! * a [`PaneEvent::Lag`](crate::PaneEvent::Lag) signal indicating the
//!   per-pane broadcast channel skipped frames; or
//! * a [`PaneEvent::Disconnect`](crate::PaneEvent::Disconnect) carrying
//!   [`PaneDisconnectReason::TooFarBehind`](crate::PaneDisconnectReason::TooFarBehind); or
//! * any other transport recovery that re-establishes a control-mode
//!   subscription after frames were dropped.
//!
//! `info()` refreshes:
//!
//! * the sticky session/window/pane metadata (names, working directory,
//!   tags, dimensions, generations, and revisions);
//! * the sticky pane process state, including the recorded
//!   [`PaneProcessState`] and any captured [`PaneExitState`] for panes that
//!   have already exited;
//! * the latest output-sequence cursor the daemon has assigned to each
//!   pane, so a subscriber can re-anchor to the live stream.
//!
//! `info()` does **not** reconstruct raw pane output bytes. Pane output is
//! retained only inside the daemon's bounded scrollback ring; bytes that
//! were dropped past the retained ring before `info()` was called are gone
//! from the daemon's perspective and cannot be recovered. Consumers that
//! must observe an exact byte-for-byte transcript should treat `info()` as
//! a re-anchor for *future* output rather than a backfill of dropped bytes.
//!
//! ## Sparse / default decoding
//!
//! Every metadata or state field on these DTOs uses `#[serde(default)]`,
//! and [`InfoSnapshot`] itself defaults to an empty bundle. This makes the
//! DTOs forward-compatible: a producer that elides optional fields, or a
//! consumer that decodes a snapshot written by a newer daemon, still
//! produces a usable value with deterministic zero-valued defaults rather
//! than a hard parse error. The required fields are limited to the
//! identity newtypes (`id`, `name`, `session_id`, `window_id`), which carry
//! no sensible default and must be supplied by every producer.

use serde::{Deserialize, Serialize};

use crate::types::{PaneId, SessionId, SessionName, TerminalSizeSpec, WindowId};

/// Sticky metadata and counters captured for one daemon session.
///
/// `attached_clients` is the count of currently attached detached-RPC
/// clients at the moment the snapshot was assembled — it is *not* a
/// monotonic counter and may decrease as clients disconnect.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionInfo {
    /// Stable per-server session identity (`$N`).
    pub id: SessionId,
    /// Validated session name in canonical sanitized form.
    pub name: SessionName,
    /// Tmux format-expanded working directory at session-start time, when
    /// the daemon recorded one.
    #[serde(default)]
    pub working_directory: Option<String>,
    /// Smallest attached-client geometry the session has agreed on.
    #[serde(default)]
    pub size: TerminalSizeSpec,
    /// Sticky session-scoped tag labels.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Monotonic session-state generation counter incremented on every
    /// observed mutation.
    #[serde(default)]
    pub generation: u64,
    /// Coarser revision counter incremented on layout-affecting mutations
    /// such as window list or active-window changes.
    #[serde(default)]
    pub revision: u64,
    /// Number of currently attached detached-RPC clients.
    #[serde(default)]
    pub attached_clients: u32,
}

impl SessionInfo {
    /// Creates a sticky session info snapshot with default optional fields.
    #[must_use]
    pub fn new(id: SessionId, name: SessionName) -> Self {
        Self {
            id,
            name,
            working_directory: None,
            size: TerminalSizeSpec::default(),
            tags: Vec::new(),
            generation: 0,
            revision: 0,
            attached_clients: 0,
        }
    }
}

/// Sticky metadata and counters captured for one daemon window.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WindowInfo {
    /// Stable per-server window identity (`@N`).
    pub id: WindowId,
    /// Owning session identity (`$N`).
    pub session_id: SessionId,
    /// Window index inside its session.
    #[serde(default)]
    pub index: u32,
    /// Window name, when the user or a `rename-window` invocation set one.
    #[serde(default)]
    pub name: Option<String>,
    /// Window geometry as last reported by the daemon.
    #[serde(default)]
    pub size: TerminalSizeSpec,
    /// Sticky window-scoped tag labels.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Monotonic window-state generation counter.
    #[serde(default)]
    pub generation: u64,
    /// Coarser revision counter incremented on layout-affecting mutations
    /// such as pane list or active-pane changes.
    #[serde(default)]
    pub revision: u64,
}

impl WindowInfo {
    /// Creates a sticky window info snapshot with default optional fields.
    #[must_use]
    pub fn new(id: WindowId, session_id: SessionId) -> Self {
        Self {
            id,
            session_id,
            index: 0,
            name: None,
            size: TerminalSizeSpec::default(),
            tags: Vec::new(),
            generation: 0,
            revision: 0,
        }
    }
}

/// Sticky metadata, process state, and counters captured for one pane.
///
/// `PaneInfo` deliberately has no `env` or `environment` field. The
/// daemon-backed SDK never exposes the spawned process environment via
/// info snapshots; the omission is part of the public SDK contract.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneInfo {
    /// Stable per-server pane identity (`%N`).
    pub id: PaneId,
    /// Owning window identity (`@N`).
    pub window_id: WindowId,
    /// Owning session identity (`$N`).
    pub session_id: SessionId,
    /// Pane index inside its window.
    #[serde(default)]
    pub index: u32,
    /// Spawned process argv, when the daemon recorded it. Stored exactly as
    /// supplied at spawn time — the SDK does not split shell text or
    /// rewrite argv on its way through the wire.
    #[serde(default)]
    pub command: Option<Vec<String>>,
    /// Process working directory at the moment of the snapshot, when the
    /// daemon could resolve one.
    #[serde(default)]
    pub working_directory: Option<String>,
    /// Sticky pane-scoped tag labels.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Pane geometry as last reported by the daemon.
    #[serde(default)]
    pub size: TerminalSizeSpec,
    /// Sticky pane process state.
    #[serde(default)]
    pub process: PaneProcessState,
    /// Monotonic pane-state generation counter.
    #[serde(default)]
    pub generation: u64,
    /// Coarser revision counter incremented on visible-state mutations such
    /// as resizes or grid clears.
    #[serde(default)]
    pub revision: u64,
    /// Latest pane-output sequence number assigned by the daemon. Consumers
    /// re-anchor to this value when subscribing again after a lag recovery.
    #[serde(default)]
    pub output_sequence: u64,
    /// Captured exit details for panes whose process has already exited.
    #[serde(default)]
    pub exit_state: Option<PaneExitState>,
    /// Agent 协议状态（termd 格式变量 `pane_agent_*` / `pane_pb_*`）。
    #[serde(default)]
    pub agent: PaneAgentSignal,
    /// 前台进程名（`pane_current_command`），用于识别手动启动的 Agent。
    #[serde(default)]
    pub foreground_command: Option<String>,
    /// 前台进程当前目录（`pane_current_path`），用于把终端归到所在 worktree。
    #[serde(default)]
    pub foreground_path: Option<String>,
}

/// pane 的 Agent 协议状态；不认识这些格式变量的旧 daemon 返回空值。
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneAgentSignal {
    /// 汇总状态：`attention` / `working` / `idle`；旧 daemon 为空串。
    #[serde(default)]
    pub state: String,
    /// 协议层状态最近一次变化的 Unix 秒；从未收到信号为 `None`。
    #[serde(default)]
    pub changed_at: Option<i64>,
    /// OSC 9;4 进度条状态名，取值同 tmux `pane_pb_state`。
    #[serde(default)]
    pub progress_state: String,
    /// OSC 9;4 最近一次给出的进度百分比。
    #[serde(default)]
    pub progress: u8,
    /// 最近一条 OSC 9 / OSC 777 通知文本。
    #[serde(default)]
    pub notification: String,
}

impl PaneInfo {
    /// Creates a sticky pane info snapshot with default optional fields.
    #[must_use]
    pub fn new(id: PaneId, window_id: WindowId, session_id: SessionId) -> Self {
        Self {
            id,
            window_id,
            session_id,
            index: 0,
            command: None,
            working_directory: None,
            tags: Vec::new(),
            size: TerminalSizeSpec::default(),
            process: PaneProcessState::default(),
            generation: 0,
            revision: 0,
            output_sequence: 0,
            exit_state: None,
            agent: PaneAgentSignal::default(),
            foreground_command: None,
            foreground_path: None,
        }
    }
}

/// Sticky process-state vocabulary for a captured pane.
///
/// Marked `#[non_exhaustive]` because more granular states (such as a
/// dedicated *paused* or *zombie* indicator) may be added without breaking
/// downstream pattern matches. Externally tagged for serde, so the encoded
/// form round-trips through both `serde_json` and `bincode`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum PaneProcessState {
    /// State has not yet been observed for this pane (mid-recovery
    /// snapshots default to this value).
    #[default]
    Unknown,
    /// PTY child is still running. `pid` is set when the daemon could
    /// surface the OS process identifier for the child; for platforms or
    /// configurations where the pid is unavailable the field stays `None`
    /// rather than an arbitrary sentinel.
    Running {
        /// OS process identifier for the running child, when known.
        #[serde(default)]
        pid: Option<u32>,
    },
    /// PTY child has exited. Detailed exit information is recorded in
    /// [`PaneInfo::exit_state`].
    Exited,
}

/// Captured exit details for an already-terminated pane process.
///
/// All fields are optional: a clean exit reports `code` only, a
/// signal-driven exit reports `signal`, and a daemon-supplied human
/// message can be carried in `message` for surfaces such as
/// `remain-on-exit` overlays.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneExitState {
    /// Numeric exit code, when the process exited normally.
    #[serde(default)]
    pub code: Option<i32>,
    /// Numeric signal value, when the process was terminated by a signal.
    #[serde(default)]
    pub signal: Option<i32>,
    /// Optional daemon-supplied human-readable exit message.
    #[serde(default)]
    pub message: Option<String>,
}

impl PaneExitState {
    /// Creates an exit state describing a clean normal exit.
    #[must_use]
    pub fn from_code(code: i32) -> Self {
        Self {
            code: Some(code),
            signal: None,
            message: None,
        }
    }

    /// 退出码按 shell 约定折算：被信号终止记为 `128 + signal`。
    #[must_use]
    pub fn shell_code(&self) -> Option<i32> {
        self.code.or(self.signal.map(|signal| 128 + signal))
    }

    /// Creates an exit state describing a signal-driven termination.
    #[must_use]
    pub fn from_signal(signal: i32) -> Self {
        Self {
            code: None,
            signal: Some(signal),
            message: None,
        }
    }
}

/// Aggregate sticky info snapshot returned by the daemon-backed handle's
/// `info()` accessor.
///
/// Producers populate the three vectors with the daemon's currently
/// retained sessions, windows, and panes. The vectors are not
/// guaranteed to be sorted by identity, but they preserve the daemon's
/// insertion order so consumers that compare consecutive snapshots see a
/// stable ordering for unchanged entries.
///
/// Consumers should treat [`InfoSnapshot`] as the *re-anchor point* after
/// lag recovery: refresh local sticky caches, re-bind subscriptions on the
/// returned `output_sequence` cursors, and accept that any pane bytes
/// dropped from the retained ring before this snapshot was taken cannot be
/// reconstructed.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct InfoSnapshot {
    /// Sticky sessions known to the daemon at snapshot time.
    #[serde(default)]
    pub sessions: Vec<SessionInfo>,
    /// Sticky windows known to the daemon at snapshot time.
    #[serde(default)]
    pub windows: Vec<WindowInfo>,
    /// Sticky panes known to the daemon at snapshot time.
    #[serde(default)]
    pub panes: Vec<PaneInfo>,
}

impl InfoSnapshot {
    /// Creates an info snapshot from explicit session, window, and pane
    /// vectors.
    #[must_use]
    pub fn new(sessions: Vec<SessionInfo>, windows: Vec<WindowInfo>, panes: Vec<PaneInfo>) -> Self {
        Self {
            sessions,
            windows,
            panes,
        }
    }

    /// Returns the recorded info entry for `session_id`, when present.
    #[must_use]
    pub fn session(&self, session_id: SessionId) -> Option<&SessionInfo> {
        self.sessions.iter().find(|info| info.id == session_id)
    }

    /// Returns the recorded info entry for `window_id`, when present.
    #[must_use]
    pub fn window(&self, window_id: WindowId) -> Option<&WindowInfo> {
        self.windows.iter().find(|info| info.id == window_id)
    }

    /// Returns the recorded info entry for `pane_id`, when present.
    #[must_use]
    pub fn pane(&self, pane_id: PaneId) -> Option<&PaneInfo> {
        self.panes.iter().find(|info| info.id == pane_id)
    }
}
