//! `file.open` 请求的有界 pending 注册表。
//!
//! CLI 的 `berth open --wait` 在发出唤醒事件前登记请求；主窗口通过
//! Tauri command 领取（claim）未完成请求并在实际完成后回执（complete）。
//! 仅内存态，不落数据库（父契约 §4.2）：过期条目由领取/登记时顺带清扫，
//! 迟到的回执对已超时的等待方无害。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

/// pending 上限；满了新请求返回 busy（ErrorKind::Rejected）。
const MAX_PENDING: usize = 32;

/// 主窗口回执的终态。
#[derive(Debug, Clone)]
pub(crate) enum OpenFileOutcome {
    /// 文件已加载、激活，支持的行定位已执行；`line` 为实际定位行或 None。
    Opened { path: String, line: Option<u32> },
    /// 工作区无法打开或定位该文件。
    Failed { message: String },
}

/// 登记结果：`receiver` 仅在调用方等待回执时存在。
#[derive(Debug)]
pub(crate) struct RegisteredOpen {
    /// 跨窗口关联 ID（RPC request id 之外的独立序列）。
    pub(crate) id: u64,
    /// 等待回执的接收端；无等待请求为 `None`。
    pub(crate) receiver: Option<oneshot::Receiver<OpenFileOutcome>>,
}

/// 领取结果（给主窗口的 DTO）。
#[derive(Debug, serde::Serialize)]
pub(crate) struct ClaimedOpenFile {
    /// 跨窗口关联 ID，回执时原样带回。
    pub(crate) request_id: u64,
    /// 绝对路径。
    pub(crate) path: String,
    /// 请求定位的行（1-based，可能为 None）。
    pub(crate) line: Option<u32>,
    /// 距离过期还有多少毫秒；主窗口据此安排本地超时。
    pub(crate) remaining_ms: u64,
}

struct PendingEntry {
    path: String,
    line: Option<u32>,
    deadline: Instant,
    waiter: Option<oneshot::Sender<OpenFileOutcome>>,
}

struct Registry {
    next_id: u64,
    entries: HashMap<u64, PendingEntry>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            next_id: 0,
            entries: HashMap::new(),
        })
    })
}

/// 移除所有已过期的条目。持有锁时调用。
fn sweep_expired(entries: &mut HashMap<u64, PendingEntry>) {
    let now = Instant::now();
    entries.retain(|_, entry| entry.deadline > now);
}

/// 登记一条待领取的文件打开请求。
///
/// 返回 `Err(())` 表示 pending 已满（调用方映射为 busy / rejected）。
pub(crate) fn register(
    path: &str,
    line: Option<u32>,
    timeout: Duration,
    want_receipt: bool,
) -> Result<RegisteredOpen, ()> {
    let mut registry = registry().lock().expect("pending registry lock");
    sweep_expired(&mut registry.entries);
    if registry.entries.len() >= MAX_PENDING {
        return Err(());
    }
    registry.next_id += 1;
    let id = registry.next_id;
    let (waiter, receiver) = if want_receipt {
        let (sender, receiver) = oneshot::channel();
        (Some(sender), Some(receiver))
    } else {
        (None, None)
    };
    registry.entries.insert(
        id,
        PendingEntry {
            path: path.to_owned(),
            line,
            deadline: Instant::now() + timeout,
            waiter,
        },
    );
    Ok(RegisteredOpen { id, receiver })
}

/// 主窗口领取所有未过期、未回执的请求。
///
/// 文件打开是幂等操作，重复领取（例如主窗口重载后）只允许重复执行、
/// 不允许重复结算；首次 `complete` 生效。
pub(crate) fn claim() -> Vec<ClaimedOpenFile> {
    let mut registry = registry().lock().expect("pending registry lock");
    sweep_expired(&mut registry.entries);
    let now = Instant::now();
    registry
        .entries
        .iter()
        .map(|(id, entry)| ClaimedOpenFile {
            request_id: *id,
            path: entry.path.clone(),
            line: entry.line,
            remaining_ms: entry.deadline.saturating_duration_since(now).as_millis() as u64,
        })
        .collect()
}

/// 主窗口回执：首次回执唤醒等待方并删除条目，后续回执幂等忽略。
///
/// 返回 `true` 表示该条目存在且本次回执被采纳。
pub(crate) fn complete(id: u64, outcome: OpenFileOutcome) -> bool {
    let entry = registry()
        .lock()
        .expect("pending registry lock")
        .entries
        .remove(&id);
    match entry {
        Some(entry) => {
            if entry.deadline <= Instant::now() {
                return false;
            }
            let outcome = match outcome {
                OpenFileOutcome::Opened { path, line } => {
                    let same_path = path.len() <= 4096
                        && !path.contains('\0')
                        && std::path::Path::new(&path).is_absolute()
                        && (path == entry.path
                            || matches!(
                                (std::fs::canonicalize(&path), std::fs::canonicalize(&entry.path)),
                                (Ok(actual), Ok(requested)) if actual == requested
                            ));
                    if !same_path {
                        OpenFileOutcome::Failed {
                            message: "opened path does not match the requested file".into(),
                        }
                    } else if line == Some(0) || (entry.line.is_some() && line.is_none()) {
                        OpenFileOutcome::Failed {
                            message: "file line reveal was not confirmed".into(),
                        }
                    } else {
                        OpenFileOutcome::Opened { path, line }
                    }
                }
                failed => failed,
            };
            if let Some(waiter) = entry.waiter {
                // 等待方已超时断开时 send 失败，回执到此为止。
                let _ = waiter.send(outcome);
            }
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全局注册表是单例：测试串行执行，各自从空表开始。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn isolated() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().expect("test lock");
        registry()
            .lock()
            .expect("pending registry lock")
            .entries
            .clear();
        guard
    }

    fn register_or_panic(path: &str, line: Option<u32>, want_receipt: bool) -> RegisteredOpen {
        register(path, line, Duration::from_secs(30), want_receipt).expect("register")
    }

    #[test]
    fn claim_returns_unexpired_entries_with_remaining_budget() {
        let _guard = isolated();
        let first = register_or_panic("/tmp/a.rs", Some(1), true);
        let second = register_or_panic("/tmp/b.rs", None, false);

        let claimed = claim();
        let ids: Vec<u64> = claimed.iter().map(|c| c.request_id).collect();
        assert_eq!(ids.len(), 2, "only the two fresh entries: {claimed:?}");
        assert!(ids.contains(&first.id));
        assert!(ids.contains(&second.id));
        let a = claimed
            .iter()
            .find(|c| c.request_id == first.id)
            .expect("a");
        assert_eq!(a.path, "/tmp/a.rs");
        assert_eq!(a.line, Some(1));
        assert!(a.remaining_ms > 0 && a.remaining_ms <= 30_000);
    }

    #[test]
    fn first_complete_settles_and_late_completes_are_ignored() {
        let _guard = isolated();
        let registered = register_or_panic("/tmp/a.rs", None, true);
        let mut receiver = registered.receiver.expect("receipt channel");
        assert!(complete(
            registered.id,
            OpenFileOutcome::Opened {
                path: "/tmp/a.rs".into(),
                line: None
            }
        ));
        let outcome = receiver.try_recv().expect("settled outcome");
        assert!(matches!(
            outcome,
            OpenFileOutcome::Opened { line: None, .. }
        ));

        // 重复回执与未知 ID 均幂等忽略。
        assert!(!complete(
            registered.id,
            OpenFileOutcome::Failed {
                message: "late".into()
            }
        ));
        assert!(!complete(
            u64::MAX,
            OpenFileOutcome::Opened {
                path: "/tmp/a.rs".into(),
                line: None
            }
        ));
        // 已结算的请求不再出现在领取列表里。
        assert!(!claim().iter().any(|c| c.request_id == registered.id));
    }

    #[test]
    fn no_receipt_requests_have_no_waiter_and_settle_without_a_listener() {
        let _guard = isolated();
        let registered = register_or_panic("/tmp/a.rs", None, false);
        assert!(registered.receiver.is_none());
        assert!(complete(
            registered.id,
            OpenFileOutcome::Opened {
                path: "/tmp/a.rs".into(),
                line: None
            }
        ));
    }

    #[test]
    fn receipt_preserves_actual_path_and_clamped_line() {
        let _guard = isolated();
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("alias")).unwrap();
        let actual = root.path().join("file.rs").to_string_lossy().into_owned();
        std::fs::write(&actual, "first\nsecond\nthird").unwrap();
        let requested = root
            .path()
            .join("alias/../file.rs")
            .to_string_lossy()
            .into_owned();
        assert_ne!(requested, actual);
        let registered = register_or_panic(&requested, Some(99), true);
        let mut receiver = registered.receiver.unwrap();
        assert!(complete(
            registered.id,
            OpenFileOutcome::Opened {
                path: actual.clone(),
                line: Some(3),
            }
        ));
        assert!(
            matches!(receiver.try_recv().unwrap(), OpenFileOutcome::Opened { path, line: Some(3) } if path == actual)
        );
    }

    #[test]
    fn receipt_rejects_a_different_path_or_unconfirmed_line() {
        let _guard = isolated();
        for (path, line) in [
            ("/synthetic/other.rs", Some(3)),
            ("/synthetic/file.rs", None),
            ("/synthetic/file.rs", Some(0)),
        ] {
            let registered = register_or_panic("/synthetic/file.rs", Some(3), true);
            let mut receiver = registered.receiver.unwrap();
            assert!(complete(
                registered.id,
                OpenFileOutcome::Opened {
                    path: path.into(),
                    line
                }
            ));
            assert!(matches!(
                receiver.try_recv().unwrap(),
                OpenFileOutcome::Failed { .. }
            ));
        }
    }

    #[test]
    fn expired_receipt_cannot_be_reported_as_opened() {
        let _guard = isolated();
        let registered = register("/synthetic/file.rs", None, Duration::ZERO, true).unwrap();
        let mut receiver = registered.receiver.unwrap();
        assert!(!complete(
            registered.id,
            OpenFileOutcome::Opened {
                path: "/synthetic/file.rs".into(),
                line: None,
            }
        ));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn cancelled_receipt_does_not_accept_a_late_opened_outcome() {
        let _guard = isolated();
        let registered = register_or_panic("/synthetic/file.rs", Some(3), true);
        let mut receiver = registered.receiver.unwrap();
        assert!(complete(
            registered.id,
            OpenFileOutcome::Failed {
                message: "cancelled".into()
            }
        ));
        assert!(!complete(
            registered.id,
            OpenFileOutcome::Opened {
                path: "/synthetic/file.rs".into(),
                line: Some(3)
            }
        ));
        assert!(matches!(
            receiver.try_recv().unwrap(),
            OpenFileOutcome::Failed { message } if message == "cancelled"
        ));
    }

    #[test]
    fn expired_entries_are_swept_and_capacity_is_bounded() {
        let _guard = isolated();
        // 用零超时让条目立即过期。
        let expired = register("/tmp/old.rs", None, Duration::ZERO, false).expect("register");
        assert!(claim().iter().all(|c| c.request_id != expired.id));

        // 重新灌满到上限：过期清扫后应能继续登记。
        for index in 0..MAX_PENDING {
            let path = format!("/tmp/fill-{index}.rs");
            register(&path, None, Duration::from_secs(30), false).expect("register");
        }
        assert!(register("/tmp/overflow.rs", None, Duration::from_secs(30), false).is_err());
    }
}
