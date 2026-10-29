#![deny(missing_docs)]
#![deny(rustdoc::broken_intra_doc_links)]
#![deny(rustdoc::invalid_codeblock_attributes)]
#![forbid(unsafe_code)]

//! Public daemon-backed Berth terminal SDK.
//!
//! v1 exposes live facade handles, session builders, waits, pane streams,
//! snapshots, and command escape hatches over the terminal daemon.
//!
//! `berth-term-sdk` is a public integration peer of `berth-cli` and must not
//! depend on `berth-cli`, `berth-term-engine`, `berth-term-server`, or `berth-term-pty` as
//! normal dependencies. The authoritative identity newtypes
//! ([`SessionName`], [`SessionId`], [`WindowId`], [`PaneId`]) live in
//! `berth-term-proto` and are re-exported here so SDK users import them through
//! `berth_term_sdk` without ever depending on those internal crates.
//!
//! # Quickstart
//!
//! The shortest daemon-backed SDK program connects to a daemon, starting one
//! through the platform hidden-daemon path if needed, then ensures a session:
//!
//! ```no_run
//! use std::time::Duration;
//!
//! use berth_term_sdk::{
//!     EnsureSession, EnsureSessionPolicy, ProcessSpec, Terminal, TerminalEndpoint, SessionName,
//!     TerminalSizeSpec,
//! };
//!
//! # async fn run() -> berth_term_sdk::Result<()> {
//! let terminal = Terminal::builder()
//!     .default_timeout(Duration::from_secs(5))
//!     .connect_or_start()
//!     .await?;
//! assert!(!matches!(terminal.endpoint(), TerminalEndpoint::Default));
//!
//! let session = SessionName::new("quickstart").expect("valid session name");
//! let session = terminal
//!     .ensure_session(
//!         EnsureSession::named(session)
//!             .policy(EnsureSessionPolicy::CreateOrReuse)
//!             .detached(true)
//!             .size(TerminalSizeSpec::new(120, 32))
//!             .process(ProcessSpec::default()),
//!     )
//!     .await?;
//! assert!(session.exists().await?);
//! # Ok(())
//! # }
//! ```
//!
#[cfg(feature = "available")]
#[path = "available/actions.rs"]
pub mod actions;
pub mod binding;

pub mod bootstrap;
#[cfg(feature = "available")]
pub mod broadcast;
pub(crate) mod capabilities;
#[cfg(feature = "available")]
#[path = "available/capture.rs"]
pub mod capture;
#[cfg(feature = "available")]
#[path = "available/command.rs"]
pub mod command;
pub mod create;
pub mod diagnostics;
#[cfg(feature = "available")]
#[path = "available/discovery.rs"]
pub mod discovery;
pub mod ensure;
pub mod error;
pub mod events;
#[cfg(feature = "available")]
pub mod extract;
pub mod handles;
pub mod info;
#[cfg(feature = "available")]
#[path = "available/input.rs"]
pub mod input;
pub mod launch_environment;
#[cfg(feature = "available")]
#[path = "available/layout.rs"]
pub mod layout;
#[cfg(feature = "available")]
#[path = "available/load_state.rs"]
pub mod load_state;
#[cfg(feature = "available")]
#[path = "available/locator.rs"]
pub mod locator;
#[cfg(feature = "available")]
#[path = "available/pane_set.rs"]
pub mod pane_set;
pub mod snapshot;
pub mod spec;
/// Berth's supported terminal-client capability boundary.
pub mod berth;
#[cfg(feature = "available")]
#[path = "available/trace.rs"]
pub mod trace;
pub mod types;
#[cfg(feature = "available")]
pub mod wait;
#[cfg(all(feature = "available", feature = "web"))]
#[path = "available/web_share.rs"]
pub mod web_share;

#[allow(dead_code)]
pub(crate) mod transport;

#[cfg(feature = "available")]
pub use actions::{FillStrategy, PaneKeyboard, PaneMouse, PaneScrollDirection, PaneSetKeyboard};
#[cfg(feature = "available")]
pub use broadcast::{
    BroadcastPaneFailure, BroadcastPaneSuccess, BroadcastResult, Input, PartialBroadcastFailure,
};
#[cfg(feature = "available")]
pub use capture::{CaptureBuilder, CapturedRegion, Rect};
#[cfg(feature = "available")]
pub use command::{CommandRun, TerminalCommand, TerminalCommandKind};
pub use create::{CreateTerminal, CreatedTerminal};
pub use diagnostics::{
    command_feature_id, protocol_diagnostic, unsupported_feature_id, Diagnostic,
    DiagnosticSeverity, FEATURE_DAEMON_SHUTDOWN, FEATURE_PROTOCOL_CAPABILITIES,
    FEATURE_PROTOCOL_WIRE_VERSION, FEATURE_TRANSPORT_UNIX_SOCKET, FEATURE_TRANSPORT_WINDOWS_PIPE,
};
#[cfg(feature = "available")]
pub use discovery::{DiscoveredPane, DiscoveredSession, PaneFinder, PaneGeometry, SessionFinder};
pub use ensure::{EnsureSession, EnsureSessionPolicy};
pub use error::{CollectError, Result, TerminalError};
pub use events::{
    PaneCommandStatus, PaneCommandSummary, PaneDisconnectReason, PaneEvent, PaneExitReason,
    PaneLagNotice, PaneNotification, PaneOutputChunk, PaneOutputStart, PaneOutputStream,
    PanePermissionScope, PaneRecentOutput,
};
#[cfg(feature = "available")]
pub use events::{PaneLineItem, PaneLineStream, PaneRenderStream, RenderUpdate};
#[cfg(feature = "available")]
pub use extract::{CollectedPaneOutput, PaneTextMatch};
#[cfg(feature = "available")]
pub use handles::{
    CleanupPolicy, LeaseState, OwnedSession, OwnedSessionBuilder, OwnedSessionSignalHandlers,
    PaneRespawnOptions, PaneSpawnBuilder, PaneSplitBuilder, SplitDirection,
};
pub use handles::{
    ListedWindowEntry, NewWindowBuilder, Pane, PaneCapture, PaneCaptureBuilder, PaneCloseOutcome,
    Session, Terminal, TerminalClientBuilder, Window, WindowCloseOutcome, WindowPane,
};
pub use info::{
    InfoSnapshot, PaneAgentSignal, PaneExitState, PaneInfo, PaneProcessState, SessionInfo,
    WindowInfo,
};
#[cfg(feature = "available")]
pub use input::{
    DetachChord, DetachDetector, DetachOutcome, KeyCode, KeyConversionError, KeyEvent, KeyModifiers,
};
#[cfg(feature = "available")]
pub use layout::{GridLayoutBuilder, LayoutPaneBuilder, SessionLayoutBuilder};
#[cfg(feature = "available")]
pub use load_state::{TerminalLoadState, TerminalLoadStateWait};
#[cfg(feature = "available")]
pub use locator::{
    Locator, LocatorAssertion, LocatorExpectation, LocatorFilter, LocatorMatch, LocatorState,
    LocatorText, LocatorWait,
};
#[cfg(feature = "available")]
pub use pane_set::{
    PaneSet, PaneSetAny, PaneSetBatch, PaneSetExpectation, PaneSetFailure, PaneSetSuccess,
    PaneSetVisibleTextOutcome, PaneSetVisibleTextWait,
};
pub use snapshot::{
    PaneAttributes, PaneCell, PaneColor, PaneCursor, PaneGlyph, PaneSnapshot,
    PaneSnapshotShapeError,
};
#[cfg(feature = "available")]
pub use spec::{
    AttachSessionReuse, AttachSessionSpec, ClientTerminalSpec, NewSessionReuse, NewSessionSpec,
    RefreshClientSpec, SplitDirectionSpec, SplitSpec, SplitTargetSpec, SubscriptionSpec,
};
pub use spec::{ProcessCommandSpec, ProcessSpec};
pub use berth_term_proto::LayoutName;
#[cfg(all(feature = "available", feature = "web"))]
pub use berth_term_proto::{WebTerminalPalette, WebTerminalTheme};
#[cfg(feature = "available")]
pub use trace::{TerminalTraceBuilder, TraceSession};
pub use types::{
    PaneId, PaneRef, SessionId, SessionName, TargetRef, TerminalEndpoint, TerminalSizeSpec,
    WindowId, WindowRef,
};
#[cfg(feature = "available")]
pub use wait::{ArmedWait, VisibleTextExpectation, VisibleTextWait, WaitTimeoutError};
#[cfg(all(feature = "available", feature = "web"))]
pub use web_share::{
    WebConfigInfo, WebShareBuilder, WebShareHandle, WebShareLookup, WebShareSummary,
};
