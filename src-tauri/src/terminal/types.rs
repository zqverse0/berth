use serde::{Deserialize, Serialize};

pub use super::protocol::{
    SubscriberControl, TerminalAttachment, TerminalResume, TerminalSnapshot, TerminalStatus,
    TerminalStreamEvent,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalEvent {
    pub terminal_id: String,
    /// Authoritative ordered sequence from the Berth-backed runtime when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}
