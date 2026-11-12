use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

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

/// 这一次 attach 的发包节奏依据：最近一次用户输入的时刻，以及页面是否正在显示这个终端。
/// 宿主据此让输入后的回显立即发给页面，可见终端按节拍合包，隐藏终端放慢；
/// 输入到达或终端变为可见时唤醒正在等节拍的发送循环。
#[derive(Debug, Clone, Default)]
pub struct AttachPace(Arc<AttachPaceInner>);

#[derive(Debug, Default)]
struct AttachPaceInner {
    /// 进程内单调毫秒 + 1；0 表示还没有输入。
    at_ms: AtomicU64,
    /// 页面报告这个终端没有显示；默认可见，没上报过的页面行为不变。
    hidden: AtomicBool,
    notify: tokio::sync::Notify,
}

fn monotonic_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

impl AttachPace {
    pub fn mark_input(&self) {
        self.0.at_ms.store(monotonic_ms(), Ordering::Relaxed);
        self.0.notify.notify_waiters();
    }

    /// `window` 内收到过输入。
    pub fn input_within(&self, window: Duration) -> bool {
        let at = self.0.at_ms.load(Ordering::Relaxed);
        at != 0 && monotonic_ms().saturating_sub(at) <= window.as_millis() as u64
    }

    pub fn set_visible(&self, visible: bool) {
        let was_hidden = self.0.hidden.swap(!visible, Ordering::Relaxed);
        // 转为可见：攒着的输出立即发，切回来就是最新画面。
        if was_hidden && visible {
            self.0.notify.notify_waiters();
        }
    }

    pub fn is_hidden(&self) -> bool {
        self.0.hidden.load(Ordering::Relaxed)
    }

    /// 等到下一次输入或转为可见。
    pub async fn changed(&self) {
        self.0.notify.notified().await
    }
}

pub struct TerminalAttachment {
    pub snapshot: TerminalSnapshot,
    pub resume: TerminalResume,
    pub data_rx: tokio::sync::mpsc::Receiver<TerminalStreamEvent>,
    pub control_rx: tokio::sync::watch::Receiver<SubscriberControl>,
    /// 这一次 attach 的身份（也是它的 worker 停止信号），见 `detach_attachment`。
    pub stop: Arc<CancellationToken>,
    pub pace: AttachPace,
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
