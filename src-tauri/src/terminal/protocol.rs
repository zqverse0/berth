use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Running,
    Exited,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub terminal_id: String,
    pub backend_instance_id: String,
    pub sequence: u64,
    pub rows: u16,
    pub cols: u16,
    #[serde(rename = "ansiBase64", with = "base64_bytes")]
    pub ansi: Vec<u8>,
    pub history_truncated: bool,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
    pub exited_at: Option<DateTime<Utc>>,
    pub last_known_cwd: Option<String>,
}

mod base64_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        STANDARD.decode(encoded).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalStreamEvent {
    Output {
        terminal_id: String,
        sequence: u64,
        data: Vec<u8>,
    },
    StatusChanged {
        terminal_id: String,
        sequence: u64,
        status: TerminalStatus,
        exit_code: Option<i32>,
        exited_at: Option<DateTime<Utc>>,
    },
    HistoryTruncated {
        terminal_id: String,
        sequence: u64,
    },
    Removed {
        terminal_id: String,
        sequence: u64,
    },
}

impl TerminalStreamEvent {
    pub fn sequence(&self) -> Option<u64> {
        match self {
            Self::Output { sequence, .. }
            | Self::StatusChanged { sequence, .. }
            | Self::HistoryTruncated { sequence, .. }
            | Self::Removed { sequence, .. } => Some(*sequence),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubscriberControl {
    Attached { sequence: u64 },
    ResyncRequired { sequence: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalResume {
    Snapshot,
    Replay {
        events: Vec<TerminalStreamEvent>,
        through_sequence: u64,
    },
}

pub struct TerminalAttachment {
    pub snapshot: TerminalSnapshot,
    pub resume: TerminalResume,
    pub data_rx: tokio::sync::mpsc::Receiver<TerminalStreamEvent>,
    pub control_rx: tokio::sync::watch::Receiver<SubscriberControl>,
    /// 这一次 attach 的身份（也是它的 worker 停止信号），见 `detach_attachment`。
    pub stop: Arc<AtomicBool>,
}

#[cfg(test)]
mod tests {
    use super::{TerminalSnapshot, TerminalStatus};

    #[test]
    fn snapshot_keeps_raw_bytes_but_serializes_base64_at_json_boundary() {
        let snapshot = TerminalSnapshot {
            terminal_id: "terminal-1".into(),
            backend_instance_id: "backend-1".into(),
            sequence: 7,
            rows: 24,
            cols: 80,
            ansi: vec![0, 0x1b, 0xff],
            history_truncated: false,
            status: TerminalStatus::Running,
            exit_code: None,
            exited_at: None,
            last_known_cwd: Some("/tmp".into()),
        };

        let value = serde_json::to_value(&snapshot).expect("serialize snapshot");
        assert_eq!(value["ansiBase64"], "ABv/");
        assert!(value.get("ansi").is_none());

        let decoded: TerminalSnapshot =
            serde_json::from_value(value).expect("deserialize snapshot");
        assert_eq!(decoded.ansi, snapshot.ansi);
    }
}
