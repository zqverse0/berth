#[cfg(any(test, feature = "test-utils"))]
use std::sync::Arc;

use serde::Serialize;
#[cfg(any(test, feature = "test-utils"))]
use serde::{ser::SerializeStruct, Serializer};
#[cfg(any(test, feature = "test-utils"))]
use tokio::sync::broadcast;

/// Test-only broadcast event used by core tests that need to inspect emitted
/// payloads without starting a Tauri application.
#[cfg(any(test, feature = "test-utils"))]
#[derive(Clone, Debug)]
pub struct TestEvent {
    pub channel: String,
    pub payload: Arc<serde_json::Value>,
}

#[cfg(any(test, feature = "test-utils"))]
impl Serialize for TestEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("TestEvent", 2)?;
        state.serialize_field("channel", &self.channel)?;
        state.serialize_field("payload", self.payload.as_ref())?;
        state.end()
    }
}

#[cfg(any(test, feature = "test-utils"))]
pub struct TestEventBus {
    sender: broadcast::Sender<TestEvent>,
}

#[cfg(any(test, feature = "test-utils"))]
impl Default for TestEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(any(test, feature = "test-utils"))]
impl TestEventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(4096);
        Self { sender }
    }

    /// Serialize `payload` once and broadcast. Returns the serialized
    /// `Value` so Tauri callers can reuse it without serializing twice.
    pub fn send(&self, channel: &str, payload: &impl Serialize) -> Option<Arc<serde_json::Value>> {
        let value = Arc::new(serde_json::to_value(payload).ok()?);
        if self.sender.receiver_count() > 0 {
            let _ = self.sender.send(TestEvent {
                channel: channel.to_string(),
                payload: value.clone(),
            });
        }
        Some(value)
    }

    /// Broadcast a pre-serialized `Value` without re-serialization.
    pub fn send_value(&self, channel: &str, payload: Arc<serde_json::Value>) {
        if self.sender.receiver_count() == 0 {
            return;
        }
        let _ = self.sender.send(TestEvent {
            channel: channel.to_string(),
            payload,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TestEvent> {
        self.sender.subscribe()
    }
}

/// Abstraction over event emission targets.
///
/// - **Tauri webview** (`Tauri`): desktop `app.emit`。
/// - **Noop**: 不需要流式进度的路径与部分测试。
/// - **Test**（仅测试 / `test-utils`）：给单测一个带 bus 的发射器。生产不再有
///   独立 HTTP/WS server。
#[derive(Clone)]
pub enum EventEmitter {
    #[cfg(feature = "tauri-runtime")]
    Tauri(tauri::AppHandle),
    /// 测试用：直接持有 broadcaster + bus。
    #[cfg(any(test, feature = "test-utils"))]
    Test { broadcaster: Arc<TestEventBus> },
    /// Silent no-op emitter — drops all events. Used when streaming progress
    /// is not needed (e.g. legacy non-streaming call paths).
    Noop,
}

impl EventEmitter {
    /// Test helper: build a `Test` emitter. Production has no WS server.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn test_with_bus(broadcaster: Arc<TestEventBus>) -> Self {
        EventEmitter::Test { broadcaster }
    }
}

/// Global side-channel for cross-client conversation list/status sync.
pub const CONVERSATION_CHANGED_EVENT: &str = "conversation://changed";

/// Global side-channel announcing a live-feedback enable/disable. Settings
/// normally lives in the main workspace, but the conversation feedback bar
/// still relies on this backend broadcast to converge across auxiliary windows
/// and clients, exactly like [`CONVERSATION_CHANGED_EVENT`]. Payload: `FeedbackSettings`
/// (`{ "enabled": bool }`).
pub const FEEDBACK_SETTINGS_CHANGED_EVENT: &str = "feedback-settings://changed";

/// Global side-channel announcing an ask-user-question enable/disable. Same
/// cross-window rationale as [`FEEDBACK_SETTINGS_CHANGED_EVENT`]: the settings UI
/// runs in a separate window, so a conversation view learns the flag flipped
/// only via this backend broadcast. Payload: `QuestionSettings` (`{ "enabled":
/// bool }`).
pub const QUESTION_SETTINGS_CHANGED_EVENT: &str = "question-settings://changed";

/// Global side-channel announcing a `get_session_info` enable/disable. Same
/// cross-window rationale as [`QUESTION_SETTINGS_CHANGED_EVENT`]: the settings UI
/// runs in a separate window, so other views learn the flag flipped only via this
/// backend broadcast. Payload: `SessionInfoSettings` (`{ "enabled": bool }`).
pub const SESSION_INFO_SETTINGS_CHANGED_EVENT: &str = "session-info-settings://changed";

/// Payload for the global [`CONVERSATION_CHANGED_EVENT`] side-channel. Drives
/// cross-client sidebar sync (membership + status) independent of the
/// per-connection ACP attach protocol, so clients that are NOT attached to a
/// conversation's connection still see it appear / update / disappear / change
/// state.
///
/// Delivered via [`emit_event`]：桌面只 `app.emit` 到 webview。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationChange {
    /// Insert-or-replace by id. Covers create and field updates (e.g. title).
    /// Carries the full summary so the frontend renders without a re-fetch.
    /// Root conversations omit `parent_id` (serde skips `None`); delegation
    /// children carry it and the frontend filters them out of the sidebar.
    ///
    /// Boxed so this variant doesn't bloat the whole enum (the summary is by far
    /// the largest payload); serde serializes `Box<T>` transparently, so the wire
    /// shape — `{ "kind": "upsert", "summary": { … } }` — is unchanged.
    Upsert {
        summary: Box<crate::models::DbConversationSummary>,
    },
    /// Remove by id (soft delete).
    Deleted { id: i32 },
}

/// Global side-channel for cross-client folder list sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview. A folder created by a headless operation is otherwise invisible to
/// the client until the next full `fetchFolders` — so without this broadcast a
/// conversation produced in that folder cannot be placed in the sidebar
/// (grouping renders rows only under known/open folders).
///
/// Distinct from [`"folder://open-in-workspace"`] (the project launcher's
/// hand-off, whose listener also opens + focuses a new conversation tab): this
/// channel ONLY upserts the folder into the workspace list, so a background
/// emitter never steals the user's focus.
pub const FOLDER_CHANGED_EVENT: &str = "folder://changed";

/// Payload for [`FOLDER_CHANGED_EVENT`]. The full [`FolderDetail`] rides on the
/// event so clients apply it without a re-fetch (matching
/// [`ConversationChange::Upsert`]). `folder` is boxed to keep the enum small and
/// to leave room for a future `Deleted { id }` variant.
///
/// [`FolderDetail`]: crate::models::FolderDetail
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderChange {
    /// Insert-or-replace by id (create / reopen / field update).
    Upsert {
        folder: Box<crate::models::FolderDetail>,
    },
}

/// Per-agent progress of the import picker's local-session scan. Emitted by
/// `scan_importable_sessions` once per parser so the picker window can render
/// a live checklist while the (potentially seconds-long) filesystem walk runs.
/// Broadcast like every other side-channel — windows not in the `scanning`
/// phase simply ignore it.
pub const IMPORT_SCAN_PROGRESS_EVENT: &str = "import-scan://progress";

/// Payload for [`IMPORT_SCAN_PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ImportScanProgress {
    pub agent_type: crate::models::AgentType,
    /// Parsers completed so far (1-based, monotonic).
    pub done: u32,
    pub total: u32,
    /// Importable root sessions this parser contributed.
    pub session_count: u32,
}

/// One-shot "a batch import finished" nudge. Deliberately a NEW channel rather
/// than a [`ConversationChange`] variant: the frontend's `conversation://changed`
/// handler routes any unknown `kind` into its status branch (clobbering state
/// with `undefined`s on stale clients), whereas an unknown channel simply has no
/// subscriber. Carries the touched folder ids — clients respond with one
/// folder-scoped refetch, which also covers the per-row title refreshes, so a
/// large batch never floods the bus with thousands of upserts (created folders
/// still broadcast individually on [`FOLDER_CHANGED_EVENT`]).
pub const CONVERSATIONS_BULK_CHANGED_EVENT: &str = "conversations://bulk-changed";

/// Payload for [`CONVERSATIONS_BULK_CHANGED_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ConversationsBulkChanged {
    pub imported: u32,
    pub updated: u32,
    pub folder_ids: Vec<i32>,
}

/// Global side-channel for cross-client open-tab sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview and every WebSocket client.
pub const TABS_CHANGED_EVENT: &str = "tabs://changed";

/// Payload for the [`TABS_CHANGED_EVENT`] side-channel. Carries the full
/// conversation-bound tab set (a snapshot, not a delta) so every client
/// converges idempotently — matching the full-replacement save semantics.
///
/// - `version` — workspace-global logical clock; clients drop events at or
///   below their last-applied version (except `origin == "server"`).
/// - `origin` — the originating client's id, echoed back so the originator can
///   ignore its own broadcast; the sentinel `"server"` marks cascade-originated
///   changes (folder removal, conversation deletion) that every client applies.
/// - `tabs` — the canonical persisted set; `is_active` marks the focused tab,
///   which is mirrored across clients.
#[derive(Debug, Clone, Serialize)]
pub struct TabsChanged {
    pub version: i64,
    pub origin: String,
    pub tabs: Vec<crate::models::OpenedTab>,
}

pub const PRIMARY_TABS_CHANGED_EVENT: &str = "primary-tabs://changed";

#[derive(Debug, Clone, Serialize)]
pub struct PrimaryTabsChanged {
    pub version: i64,
    pub origin: String,
    pub tabs: Vec<crate::models::PrimaryTab>,
}

/// Unified event emission: serialize once and send to the desktop webview.
pub fn emit_event(emitter: &EventEmitter, event: &str, payload: impl Serialize) {
    match emitter {
        #[cfg(feature = "tauri-runtime")]
        EventEmitter::Tauri(app) => {
            use tauri::Emitter;
            let Ok(value) = serde_json::to_value(&payload) else {
                return;
            };
            let _ = app.emit(event, &value);
        }
        #[cfg(any(test, feature = "test-utils"))]
        EventEmitter::Test { broadcaster, .. } => {
            let _ = broadcaster.send(event, &payload);
        }
        EventEmitter::Noop => {}
    }
}
