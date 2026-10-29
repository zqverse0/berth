//! In-process terminal lifecycle index and subscriber cleanup.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use berth_term_sdk::berth::{RuntimeBinding, SessionName, WindowRef};

use super::binding::{bound_pane, pane_for_binding};
use super::model::{TerminalDescriptor, TerminalLimits, TerminalOwnership};
use super::remote::folder_session_name;
use super::runtime::TerminalExecutor;
use super::terminal_manager::TerminalSessionManager;
use super::validation::TerminalLaunchEnvironment;
use crate::event_bridge::EventEmitter;
use crate::terminal::error::TerminalError;
use crate::terminal::protocol::{SubscriberControl, TerminalStatus, TerminalStreamEvent};
use crate::terminal::types::TerminalEvent;

#[derive(Debug, Clone)]
pub(super) struct TerminalTarget {
    pub(super) session: SessionName,
    pub(super) window_index: u32,
    pub(super) pane_index: u32,
}

/// A terminal ready for an operation: its slot hint plus the captured inner
/// identity.
///
/// The slot fields in `target` are only a first-resolution hint. `binding` is
/// the identity every operation is addressed with after it has been re-checked
/// against the live daemon, so window/pane renumbering cannot silently redirect
/// the operation to another process.
#[derive(Debug, Clone)]
pub(super) struct ResolvedTerminal {
    /// Slot the terminal was last seen at; the informational slot of the by-id
    /// pane handle.
    pub(super) target: TerminalTarget,
    /// Inner identity captured from the live daemon when the terminal was
    /// created or last scanned.
    pub(super) binding: RuntimeBinding,
}

#[derive(Debug)]
pub(super) struct SubscriberHandle {
    pub(super) stop: Arc<AtomicBool>,
    pub(super) control_tx: tokio::sync::watch::Sender<SubscriberControl>,
}

pub(super) struct TerminalRecord {
    pub(super) descriptor: TerminalDescriptor,
    pub(super) target: TerminalTarget,
    /// Inner identity captured from the live daemon when the record was created
    /// or last reconciled. Every operation re-checks it before addressing the
    /// pane; a record is never addressed by slot alone.
    pub(super) binding: RuntimeBinding,
    pub(super) sequence: u64,
    pub(super) owner_window_label: Option<String>,
    pub(super) input_sequences: HashMap<String, u64>,
    /// Serializes input and resize operations without holding the session index
    /// mutex across a terminal request.
    pub(super) input_lock: Arc<Mutex<()>>,
    pub(super) subscribers: HashMap<String, SubscriberHandle>,
    pub(super) temp_files: Vec<PathBuf>,
    pub(super) emitter: EventEmitter,
}

pub(super) struct TerminalSessionManagerInner {
    pub(super) backend_instance_id: String,
    pub(super) endpoint: PathBuf,
    pub(super) daemon_binary: Option<PathBuf>,
    pub(super) executor: OnceLock<Arc<TerminalExecutor>>,
    /// 启动时注入的 namespace、宿主连接与环境投影；不另存 catalog 或 owner 表。
    pub(super) project_database:
        OnceLock<(String, DatabaseConnection, Result<TerminalLaunchEnvironment, String>)>,
    pub(super) sessions: Mutex<HashMap<String, TerminalRecord>>,
    pub(super) limits: TerminalLimits,
}

impl TerminalRecord {
    pub(super) fn descriptor_sequence(&self) -> u64 {
        self.sequence
    }
}

#[derive(Debug, Clone)]
pub(super) struct LiveTerminal {
    /// 启动时明确选中的 Agent 会话，仅用于重复打开时复用终端。
    pub(super) session_id: Option<String>,
    pub(super) descriptor: TerminalDescriptor,
    pub(super) target: TerminalTarget,
    /// Inner identity captured during the scan, used to bind the record to the
    /// pane process instead of the slot it happened to occupy.
    pub(super) binding: RuntimeBinding,
    pub(super) sequence: u64,
}

pub(super) fn clear_runtime_index_inner(inner: &Arc<TerminalSessionManagerInner>) {
    let mut sessions = inner.sessions.lock().expect("terminal index lock");
    let records: Vec<_> = sessions.drain().map(|(_, record)| record).collect();
    for record in records {
        stop_record_subscribers(record);
    }
}

pub(super) fn sync_runtime_index(
    inner: &Arc<TerminalSessionManagerInner>,
    live: &[LiveTerminal],
) -> Vec<LiveTerminal> {
    // 重名窗口没有唯一目标，不能按扫描顺序取第一项：整组跳过，既不建也不覆盖记录，
    // 也不当作 stale 删除。只拒绝这几项，其余终端照常同步（attach 里新建的窗口
    // 会按进程名自动命名，不能让它拖垮整个清单）。
    let mut counts = HashMap::<&str, usize>::with_capacity(live.len());
    for entry in live {
        *counts
            .entry(entry.descriptor.terminal_id.as_str())
            .or_default() += 1;
    }
    for (terminal_id, _) in counts.iter().filter(|(_, count)| **count > 1) {
        tracing::warn!(terminal_id, "terminal id is ambiguous across live windows; skipped");
    }
    let live = live
        .iter()
        .filter(|entry| counts[entry.descriptor.terminal_id.as_str()] == 1)
        .collect::<Vec<_>>();
    let mut sessions = inner.sessions.lock().expect("terminal index lock");

    for entry in &live {
        if let Some(record) = sessions.get_mut(&entry.descriptor.terminal_id) {
            record.descriptor = entry.descriptor.clone();
            // target ref 标识已捕获的 binding，随 binding 保持不变。
            record.descriptor.target_ref = super::model::encode_target_ref(&record.binding);
            record.target = entry.target.clone();
            // inventory 可能为同一窗口选出另一个 active pane（或在 daemon 重启后
            // 看到同名窗口）。这只是展示元数据刷新，不是旧 terminal id 更换运行实体的
            // 证据。除显式创建/插入记录外保持已捕获 binding 不变；操作经 SDK 复核，
            // 因此会失败而不会静默换绑。
            record.sequence = record.sequence.max(entry.sequence);
        } else {
            sessions.insert(
                entry.descriptor.terminal_id.clone(),
                TerminalRecord {
                    descriptor: entry.descriptor.clone(),
                    target: entry.target.clone(),
                    binding: entry.binding.clone(),
                    sequence: entry.sequence,
                    owner_window_label: None,
                    input_sequences: HashMap::new(),
                    input_lock: Arc::new(Mutex::new(())),
                    subscribers: HashMap::new(),
                    temp_files: Vec::new(),
                    emitter: EventEmitter::Noop,
                },
            );
        }
    }

    let stale = sessions
        .keys()
        .filter(|terminal_id| !counts.contains_key(terminal_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for terminal_id in stale {
        if let Some(record) = sessions.remove(&terminal_id) {
            stop_record_subscribers(record);
        }
    }
    live.into_iter().cloned().collect()
}

pub(super) fn update_record_sequence(
    inner: &Arc<TerminalSessionManagerInner>,
    sequence: u64,
    terminal_id: &str,
) {
    if let Ok(mut sessions) = inner.sessions.lock() {
        if let Some(record) = sessions.get_mut(terminal_id) {
            record.sequence = record.sequence.max(sequence);
        }
    }
}

/// 只移除 `stop` 所属的那一次 attach。同一 client 重新 attach 后，旧 attachment 的
/// 清理不能删掉新订阅，否则新连接收不到输出、后续输入与 resize 都被判为断开。
pub(super) fn remove_subscriber(
    inner: &Arc<TerminalSessionManagerInner>,
    terminal_id: &str,
    client_id: &str,
    stop: &Arc<AtomicBool>,
) {
    if let Ok(mut sessions) = inner.sessions.lock() {
        if let Some(record) = sessions.get_mut(terminal_id) {
            if record
                .subscribers
                .get(client_id)
                .is_some_and(|subscriber| Arc::ptr_eq(&subscriber.stop, stop))
            {
                record.subscribers.remove(client_id);
            }
        }
    }
}

pub(super) fn mark_exited(
    inner: &Arc<TerminalSessionManagerInner>,
    terminal_id: &str,
    exit_code: Option<i32>,
    sequence: u64,
    exited_at: DateTime<Utc>,
) {
    let emitter = {
        let mut sessions = match inner.sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => return,
        };
        let Some(record) = sessions.get_mut(terminal_id) else {
            return;
        };
        if record.descriptor.status == TerminalStatus::Exited {
            return;
        }
        record.descriptor.status = TerminalStatus::Exited;
        record.descriptor.process_id = None;
        record.descriptor.exited_at = Some(exited_at);
        record.sequence = record.sequence.max(sequence);
        record.emitter.clone()
    };
    emit_terminal_exit_event(&emitter, terminal_id, exit_code);
}

pub(super) fn insert_record(
    inner: &Arc<TerminalSessionManagerInner>,
    terminal_id: String,
    record: TerminalRecord,
) -> Result<(), TerminalError> {
    let mut sessions = inner.sessions.lock().expect("terminal index lock");
    let running = sessions
        .values()
        .filter(|record| record.descriptor.status == TerminalStatus::Running)
        .count();
    if running >= inner.limits.max_running {
        return Err(TerminalError::LimitReached);
    }
    while sessions.len() >= inner.limits.max_records {
        let Some(oldest) = sessions
            .iter()
            .filter(|(_, record)| record.descriptor.status != TerminalStatus::Running)
            .min_by_key(|(_, record)| record.descriptor.exited_at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        if let Some(record) = sessions.remove(&oldest) {
            stop_record_subscribers(record);
        }
    }
    sessions.insert(terminal_id, record);
    Ok(())
}

pub(super) fn stop_record_subscribers(mut record: TerminalRecord) {
    for (_, subscriber) in record.subscribers.drain() {
        subscriber.stop.store(true, Ordering::Release);
    }
    cleanup_temp_files(&mut record.temp_files);
}

impl TerminalSessionManager {
    /// Async spelling used by folder/worktree lifecycle code.
    pub async fn terminate(&self, terminal_id: &str) -> Result<(), TerminalError> {
        self.close_window(terminal_id)
    }

    fn close_window(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let resolved = self.resolve_terminal(terminal_id)?;
        self.execute(
            false,
            Some(terminal_id.to_string()),
            move |terminal| async move {
                let pane = pane_for_binding(terminal.as_ref(), &resolved).await?;
                if pane.is_generation_guarded() {
                    // 当前窗口定位、代际核验和关闭在 daemon 的同一把锁内完成。
                    pane.close_guarded_window().await
                } else {
                    // 无 epoch 的旧 daemon：保持按 pane id 定位窗口的路径。
                    let bound = bound_pane(terminal.as_ref(), &resolved).await?;
                    let session_name = bound.session.name().clone();
                    let window_index = bound.window_index();
                    let window_target = WindowRef::new(session_name.clone(), window_index);
                    match terminal.window(window_target).await?.close().await {
                        Ok(_) => Ok(()),
                        // Folder/personal sessions often have a single window. Berth terminal
                        // refuses kill-window on the last slot — destroy the whole
                        // session so GUI/CLI close stays symmetric with create.
                        Err(error) if is_only_window_kill_error(&error) => terminal
                            .session(session_name)
                            .await?
                            .kill()
                            .await
                            .map(|_| ()),
                        Err(error) => Err(error),
                    }
                }
            },
        )?;
        self.remove_runtime_record(terminal_id, true);
        Ok(())
    }

    fn remove_runtime_record(&self, terminal_id: &str, emit_removed: bool) {
        let record = self
            .inner
            .sessions
            .lock()
            .expect("terminal index lock")
            .remove(terminal_id);
        let Some(record) = record else { return };
        if emit_removed {
            let event = TerminalStreamEvent::Removed {
                terminal_id: terminal_id.to_string(),
                sequence: record.descriptor_sequence().saturating_add(1),
            };
            for subscriber in record.subscribers.values() {
                let _ = subscriber
                    .control_tx
                    .send_replace(SubscriberControl::ResyncRequired {
                        sequence: event.sequence().unwrap_or_default(),
                    });
                subscriber.stop.store(true, Ordering::Release);
            }
        }
        stop_record_subscribers(record);
    }

    /// Removes a terminal index record after its Berth terminal window has exited.
    pub fn remove_record(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self.inner.sessions.lock().expect("terminal index lock");
        let record = sessions
            .get(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        if record.descriptor.status == TerminalStatus::Running {
            return Err(TerminalError::StillRunning(terminal_id.to_string()));
        }
        let record = sessions.remove(terminal_id).expect("record still present");
        stop_record_subscribers(record);
        Ok(())
    }

    /// 只关闭当前实例与项目 UUID 对应的 session，不接管数字 legacy 或 foreign。
    pub async fn terminate_and_remove_folder(&self, folder_id: i32) -> Result<(), TerminalError> {
        let inner = self.inner.clone();
        match self.execute(false, None, move |terminal| async move {
            let target = folder_session_name(&inner, folder_id).await?;
            if terminal.has_session(target.clone()).await? {
                terminal.session(target).await?.kill().await?;
            }
            Ok(())
        }) {
            Ok(()) | Err(TerminalError::RuntimeUnavailable(_)) => {}
            Err(error) => return Err(error),
        }

        let mut sessions = self.inner.sessions.lock().expect("terminal index lock");
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, record)| {
                record.descriptor.ownership == TerminalOwnership::Project
                    && record.descriptor.folder_id == Some(folder_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(record) = sessions.remove(&id) {
                stop_record_subscribers(record);
            }
        }
        Ok(())
    }

    /// Returns terminals whose working directory is inside a worktree.
    pub fn sessions_started_under(&self, canonical_path: &Path) -> Vec<TerminalDescriptor> {
        let root =
            std::fs::canonicalize(canonical_path).unwrap_or_else(|_| canonical_path.to_path_buf());
        self.list()
            .into_iter()
            .filter(|descriptor| {
                // cwd 仅用于已知归属/独立终端的清理范围，不足以认领 legacy session。
                if descriptor.ownership == TerminalOwnership::LegacyUnresolved {
                    return false;
                }
                let cwd = std::fs::canonicalize(&descriptor.initial_cwd)
                    .unwrap_or_else(|_| PathBuf::from(&descriptor.initial_cwd));
                cwd == root || cwd.starts_with(&root)
            })
            .collect()
    }

    /// Lists terminals owned by a folder id.
    pub fn sessions_for_folder(&self, folder_id: i32) -> Vec<TerminalDescriptor> {
        self.list()
            .into_iter()
            .filter(|descriptor| {
                descriptor.ownership == TerminalOwnership::Project
                    && descriptor.folder_id == Some(folder_id)
            })
            .collect()
    }

    /// Detaches subscriptions owned by a Berth window; it never kills a
    /// project window or pane process.
    pub fn detach_by_owner_window(&self, owner_window_label: &str) -> usize {
        let mut detached = 0;
        let mut sessions = self.inner.sessions.lock().expect("terminal index lock");
        for record in sessions.values_mut() {
            if record.owner_window_label.as_deref() == Some(owner_window_label) {
                let subscribers: Vec<_> =
                    record.subscribers.drain().map(|(_, value)| value).collect();
                detached += subscribers.len();
                for subscriber in subscribers {
                    subscriber.stop.store(true, Ordering::Release);
                }
            }
        }
        detached
    }

    /// Berth process shutdown is detach-only. The daemon remains the runtime
    /// owner until an explicit CLI/daemon shutdown or host shutdown.
    pub fn detach_all(&self) -> usize {
        let mut detached = 0;
        let mut sessions = self.inner.sessions.lock().expect("terminal index lock");
        for record in sessions.values_mut() {
            let subscribers: Vec<_> = record.subscribers.drain().map(|(_, value)| value).collect();
            detached += subscribers.len();
            for subscriber in subscribers {
                subscriber.stop.store(true, Ordering::Release);
            }
        }
        detached
    }
}

fn is_only_window_kill_error(error: &berth_term_sdk::berth::TerminalError) -> bool {
    let message = error.to_string();
    message.contains("cannot kill the only window in session")
}

pub(super) fn cleanup_temp_files(files: &mut Vec<PathBuf>) {
    for path in files.drain(..) {
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                let _ = std::fs::remove_dir_all(path);
            }
            Ok(_) => {
                let _ = std::fs::remove_file(path);
            }
            Err(_) => {}
        }
    }
}

pub(super) fn emit_terminal_exit_event(
    emitter: &EventEmitter,
    terminal_id: &str,
    exit_code: Option<i32>,
) {
    let event = TerminalEvent {
        terminal_id: terminal_id.to_string(),
        sequence: None,
    };
    let _ = exit_code;
    crate::event_bridge::emit_event(emitter, &format!("terminal://exit/{terminal_id}"), event);
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use chrono::Utc;
    use berth_term_sdk::berth::{PaneId, RuntimeBinding, SessionName};

    use super::*;

    fn test_inner() -> Arc<TerminalSessionManagerInner> {
        Arc::new(TerminalSessionManagerInner {
            backend_instance_id: "test-endpoint".to_owned(),
            endpoint: PathBuf::from("/tmp/berth-lifecycle-test.sock"),
            daemon_binary: None,
            executor: OnceLock::new(),
            project_database: OnceLock::new(),
            sessions: Mutex::new(HashMap::new()),
            limits: TerminalLimits::default(),
        })
    }

    fn session(name: &str) -> SessionName {
        SessionName::new(name).expect("valid test session")
    }

    fn binding(epoch: Option<&str>, pane_id: u32, generation: u64) -> RuntimeBinding {
        RuntimeBinding::new(
            epoch.map(str::to_owned),
            session("test-session"),
            PaneId::new(pane_id),
            generation,
        )
    }

    fn live_terminal(
        title: &str,
        target_pane_index: u32,
        binding: RuntimeBinding,
        sequence: u64,
    ) -> LiveTerminal {
        LiveTerminal {
            session_id: None,
            descriptor: TerminalDescriptor {
                terminal_id: "terminal-under-test".to_owned(),
                backend_instance_id: "test-endpoint".to_owned(),
                folder_id: None,
                ownership: TerminalOwnership::Independent,
                title: title.to_owned(),
                initial_cwd: "/tmp".to_owned(),
                shell: "/bin/sh".to_owned(),
                status: TerminalStatus::Running,
                process_id: Some(42),
                created_at: Utc::now(),
                exited_at: None,
                agent_id: None,
                agent_signal: None,
                foreground_command: None,
                launch_inputs: None,
                cwd: None,
                tail: None,
                target_ref: None,
            },
            target: TerminalTarget {
                session: binding.session.clone(),
                window_index: 3,
                pane_index: target_pane_index,
            },
            binding,
            sequence,
        }
    }

    #[test]
    fn inventory_duplicate_terminal_ids_never_seed_or_overwrite_a_binding() {
        let inner = test_inner();
        let original = live_terminal("original", 0, binding(Some("epoch-a"), 7, 1), 1);
        let mut duplicate = live_terminal("duplicate", 0, binding(Some("epoch-a"), 8, 1), 2);
        duplicate.binding.session = session("another-session");
        duplicate.target.session = duplicate.binding.session.clone();

        assert!(sync_runtime_index(&inner, &[original.clone(), duplicate.clone()]).is_empty());
        assert!(inner.sessions.lock().expect("index lock").is_empty());

        sync_runtime_index(&inner, std::slice::from_ref(&original));
        // 重名只跳过这一组，其余终端照常同步。
        let mut other = live_terminal("other", 1, binding(Some("epoch-a"), 9, 1), 3);
        other.descriptor.terminal_id = "other-terminal".to_owned();
        let synced = sync_runtime_index(&inner, &[duplicate, original.clone(), other]);
        assert_eq!(synced.len(), 1);
        assert_eq!(synced[0].descriptor.terminal_id, "other-terminal");
        let sessions = inner.sessions.lock().expect("index lock");
        let record = sessions
            .get("terminal-under-test")
            .expect("original binding");
        assert_eq!(record.binding, original.binding);
        assert_eq!(record.descriptor.title, "original");
    }

    #[test]
    fn inventory_active_pane_switch_keeps_old_binding_for_the_next_operation() {
        let inner = test_inner();
        let original = binding(Some("epoch-a"), 7, 1);
        sync_runtime_index(&inner, &[live_terminal("original", 0, original.clone(), 1)]);

        // 同名窗口现在扫描到了另一个 active pane。这正是此前会把 terminal id
        // 静默换绑到 pane 8 的 inventory 形状。
        sync_runtime_index(
            &inner,
            &[live_terminal(
                "new active pane",
                1,
                binding(Some("epoch-a"), 8, 1),
                2,
            )],
        );

        let manager = TerminalSessionManager {
            inner: inner.clone(),
        };
        let resolved = manager
            .resolve_terminal("terminal-under-test")
            .expect("record remains resolvable");
        assert_eq!(resolved.binding, original);
        let record = inner
            .sessions
            .lock()
            .expect("index lock")
            .remove("terminal-under-test")
            .expect("record remains indexed");
        assert_eq!(record.descriptor.title, "new active pane");
        assert_eq!(record.target.pane_index, 1);
        // 展示元数据刷新，但 target ref 仍指向已捕获的 pane 7。
        assert_eq!(
            record.descriptor.target_ref,
            crate::terminal::manager::model::encode_target_ref(&original)
        );
    }

    #[test]
    fn inventory_slot_reuse_does_not_replace_a_missing_pane_binding() {
        let inner = test_inner();
        let original = binding(Some("epoch-a"), 7, 1);
        sync_runtime_index(&inner, &[live_terminal("original", 0, original.clone(), 1)]);

        // pane 7 消失，同一个 slot 现在报告替换后的 pane。
        sync_runtime_index(
            &inner,
            &[live_terminal(
                "replacement",
                0,
                binding(Some("epoch-a"), 9, 1),
                2,
            )],
        );

        let manager = TerminalSessionManager {
            inner: inner.clone(),
        };
        let resolved = manager
            .resolve_terminal("terminal-under-test")
            .expect("record remains resolvable for a deterministic failure");
        assert_eq!(resolved.binding, original);
    }

    #[test]
    fn inventory_same_name_after_new_epoch_remains_bound_to_the_old_epoch() {
        let inner = test_inner();
        let original = binding(Some("epoch-a"), 7, 1);
        sync_runtime_index(&inner, &[live_terminal("original", 0, original.clone(), 1)]);

        // daemon 重启后可能重建完全相同的 session/pane/generation 值。
        sync_runtime_index(
            &inner,
            &[live_terminal(
                "rebuilt",
                0,
                binding(Some("epoch-b"), 7, 1),
                1,
            )],
        );

        let manager = TerminalSessionManager {
            inner: inner.clone(),
        };
        let resolved = manager
            .resolve_terminal("terminal-under-test")
            .expect("record remains resolvable for a stale-daemon result");
        assert_eq!(resolved.binding, original);
    }

    #[test]
    fn inventory_normal_scan_refreshes_metadata_without_changing_identity() {
        let inner = test_inner();
        let original = binding(Some("epoch-a"), 7, 1);
        sync_runtime_index(&inner, &[live_terminal("original", 0, original.clone(), 4)]);
        sync_runtime_index(
            &inner,
            &[live_terminal("same pane refreshed", 0, original.clone(), 5)],
        );

        let manager = TerminalSessionManager {
            inner: inner.clone(),
        };
        let resolved = manager
            .resolve_terminal("terminal-under-test")
            .expect("record remains resolvable");
        assert_eq!(resolved.binding, original);
        let record = inner
            .sessions
            .lock()
            .expect("index lock")
            .get("terminal-under-test")
            .expect("record remains indexed")
            .descriptor
            .clone();
        assert_eq!(record.title, "same pane refreshed");
    }

    #[test]
    fn inventory_without_epoch_keeps_old_daemon_binding_unverifiable() {
        let inner = test_inner();
        let original = binding(None, 7, 0);
        sync_runtime_index(
            &inner,
            &[live_terminal("old daemon", 0, original.clone(), 1)],
        );
        sync_runtime_index(
            &inner,
            &[live_terminal(
                "old daemon refreshed",
                1,
                binding(None, 8, 0),
                2,
            )],
        );

        let manager = TerminalSessionManager {
            inner: inner.clone(),
        };
        let resolved = manager
            .resolve_terminal("terminal-under-test")
            .expect("old-daemon record remains resolvable");
        assert_eq!(resolved.binding, original);
        assert!(resolved.binding.daemon_instance.is_none());
    }
}
