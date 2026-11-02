//! 节点设备上的终端：在本机作为一类终端，id 为 `<设备 id>/<对方 target_ref>`，经该设备的终端通道
//! 列出、接入、输入、改尺寸、关闭。
//!
//! - 列表：随本机终端清单一起返回上次取到的结果（离线时沿用，标签不因断网消失），过期了后台再取。
//! - 接入：对方回可视区快照，之后推送增量输出；序号与本机终端同一约定（termd 序号 + 1）。
//! - 输入：排进会话即返回，断线期间排队、续上后恰好送达一次。
//! - 终端通道重新上线后给所有接入方发重同步，前端重新接入取快照。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use berth_node::api::{Paint, Push, Request};
use berth_node::client::Status;
use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;

use super::{Node, NODES};
use crate::terminal::error::TerminalError;
use crate::terminal::manager::{TerminalDescriptor, TerminalOwnership};
use crate::terminal::protocol::{TerminalSnapshot, TerminalStatus};

/// 接入、改尺寸、关闭、列表的截止时间。
const OP_DEADLINE: Duration = Duration::from_secs(30);
/// 输入的截止时间：断网期间排队，只要在这之内续上就不丢。
const INPUT_DEADLINE: Duration = Duration::from_secs(600);
/// 列表多久后台重取一次。
const LIST_EVERY: Duration = Duration::from_secs(5);

/// 推给一个接入方的事件（由命令层编码成本机终端输出包）。
pub(crate) enum RemoteEvent {
    /// 输出。
    Output { sequence: u64, data: Vec<u8> },
    /// 需要重新接入取快照。
    Resync { sequence: u64 },
}

/// 一台设备的终端状态。
#[derive(Default)]
pub(super) struct Terminals {
    /// target → 接入方 client id → 事件去处。
    subscribers: Mutex<HashMap<String, HashMap<String, UnboundedSender<RemoteEvent>>>>,
    /// target → 最近一次输出的序号（重同步时带上）。
    sequences: Mutex<HashMap<String, u64>>,
    listed: Mutex<Listed>,
}

#[derive(Default)]
struct Listed {
    descriptors: Vec<TerminalDescriptor>,
    at: Option<Instant>,
    refreshing: bool,
}

/// 远端终端 id → (设备 id, 对方 target_ref)；本机终端返回 `None`。
pub(crate) fn parse(terminal_id: &str) -> Option<(i32, &str)> {
    let (device, target) = terminal_id.split_once('/')?;
    let device = device.parse().ok()?;
    target.starts_with("v1.").then_some((device, target))
}

fn backend(device: i32) -> String {
    format!("device:{device}")
}

fn node(device: i32) -> Result<std::sync::Arc<Node>, TerminalError> {
    NODES
        .lock()
        .expect("nodes lock")
        .get(&device)
        .cloned()
        .ok_or_else(|| {
            TerminalError::RuntimeUnavailable(format!("device {device} is not connected"))
        })
}

fn failed(error: berth_node::api::ApiError) -> TerminalError {
    match error.kind.as_str() {
        "not_found" => TerminalError::NotFound(error.message),
        _ => TerminalError::RuntimeUnavailable(error.message),
    }
}

impl Terminals {
    fn broadcast(&self, target: &str, event: impl Fn() -> RemoteEvent) {
        let mut subscribers = self.subscribers.lock().expect("subscribers lock");
        if let Some(clients) = subscribers.get_mut(target) {
            clients.retain(|_, tx| tx.send(event()).is_ok());
        }
    }

    fn sequence(&self, target: &str) -> u64 {
        self.sequences
            .lock()
            .expect("sequences lock")
            .get(target)
            .copied()
            .unwrap_or(0)
    }

    fn resync_all(&self) {
        let targets: Vec<String> = self
            .subscribers
            .lock()
            .expect("subscribers lock")
            .keys()
            .cloned()
            .collect();
        for target in targets {
            let sequence = self.sequence(&target);
            self.broadcast(&target, || RemoteEvent::Resync { sequence });
        }
    }
}

/// 把终端通道的推送分给接入方；通道重新上线时让所有接入方重同步。随连接关闭结束。
pub(super) async fn route(
    terminals: std::sync::Arc<Terminals>,
    mut pushes: UnboundedReceiver<(Push, Vec<u8>)>,
    mut status: watch::Receiver<Status>,
) {
    let mut online = false;
    loop {
        tokio::select! {
            push = pushes.recv() => {
                let Some((push, body)) = push else { return };
                match push {
                    Push::Output { target, seq } => {
                        // termd 序号从 0 起，本机终端流从 1 起（同 `terminal_sequence_from_runtime`）。
                        let sequence = seq.saturating_add(1);
                        terminals.sequences.lock().expect("sequences lock").insert(target.clone(), sequence);
                        terminals.broadcast(&target, || RemoteEvent::Output {
                            sequence,
                            data: body.clone(),
                        });
                    }
                    Push::Resync { target } | Push::Exited { target } => {
                        let sequence = terminals.sequence(&target);
                        terminals.broadcast(&target, || RemoteEvent::Resync { sequence });
                        terminals.listed.lock().expect("listed lock").at = None;
                    }
                }
            }
            changed = status.changed() => {
                if changed.is_err() {
                    return;
                }
                let now_online = *status.borrow_and_update() == Status::Online;
                if now_online && !online {
                    terminals.resync_all();
                }
                online = now_online;
            }
        }
    }
}

/// 所有已连接设备上的终端（上次取到的）；过期的后台重取。
pub(crate) fn descriptors() -> Vec<TerminalDescriptor> {
    let nodes: Vec<(i32, std::sync::Arc<Node>)> = NODES
        .lock()
        .expect("nodes lock")
        .iter()
        .map(|(id, node)| (*id, node.clone()))
        .collect();
    let mut all = Vec::new();
    for (device, node) in nodes {
        let mut listed = node.terminals.listed.lock().expect("listed lock");
        all.extend(listed.descriptors.iter().cloned());
        let stale = listed.at.is_none_or(|at| at.elapsed() >= LIST_EVERY);
        if stale && !listed.refreshing {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                listed.refreshing = true;
                handle.spawn(refresh(device, node.clone()));
            }
        }
    }
    all
}

async fn refresh(device: i32, node: std::sync::Arc<Node>) {
    let result = node
        .terminal
        .request(&Request::Terminals { project: None }, &[], OP_DEADLINE)
        .await;
    let mut listed = node.terminals.listed.lock().expect("listed lock");
    listed.refreshing = false;
    let Ok((value, _)) = result else {
        // 离线或超时：沿用上次的列表，稍后再试。
        listed.at = Some(Instant::now());
        return;
    };
    let entries = value["terminals"].as_array().cloned().unwrap_or_default();
    let previous: HashMap<String, DateTime<Utc>> = listed
        .descriptors
        .iter()
        .map(|d| (d.terminal_id.clone(), d.created_at))
        .collect();
    listed.descriptors = entries
        .iter()
        .filter_map(|entry| descriptor(device, &node.name, entry, &previous))
        .collect();
    listed.at = Some(Instant::now());
}

/// 对方 `berth terminal ls --json` 的一项 → 本机终端描述；标题前加设备名。
fn descriptor(
    device: i32,
    device_name: &str,
    entry: &Value,
    previous: &HashMap<String, DateTime<Utc>>,
) -> Option<TerminalDescriptor> {
    let target = entry["target_ref"].as_str()?;
    let terminal_id = format!("{device}/{target}");
    let title = entry["title"]
        .as_str()
        .filter(|title| !title.is_empty())
        .or_else(|| entry["agent"].as_str())
        .or_else(|| entry["project_name"].as_str())
        .unwrap_or("Terminal");
    let cwd = entry["cwd"].as_str().map(str::to_owned);
    let status = match entry["status"].as_str() {
        // 刚新建的回 `created`。
        Some("running" | "created") => TerminalStatus::Running,
        _ => TerminalStatus::Exited,
    };
    Some(TerminalDescriptor {
        created_at: previous.get(&terminal_id).copied().unwrap_or_else(Utc::now),
        terminal_id,
        backend_instance_id: backend(device),
        folder_id: None,
        ownership: TerminalOwnership::Independent,
        title: format!("{device_name} · {title}"),
        initial_cwd: cwd.clone().unwrap_or_default(),
        shell: String::new(),
        status,
        process_id: None,
        exited_at: None,
        agent_id: entry["agent"].as_str().map(str::to_owned),
        agent_signal: None,
        foreground_command: None,
        launch_inputs: None,
        cwd,
        tail: None,
        target_ref: None,
    })
}

/// 新建后立即并入列表（不等下一次重取），返回它的描述。
pub(crate) fn add_created(device: i32, entry: &Value) -> Option<TerminalDescriptor> {
    let node = node(device).ok()?;
    let descriptor = descriptor(device, &node.name, entry, &HashMap::new())?;
    let mut listed = node.terminals.listed.lock().expect("listed lock");
    listed
        .descriptors
        .retain(|d| d.terminal_id != descriptor.terminal_id);
    listed.descriptors.push(descriptor.clone());
    Some(descriptor)
}

fn snapshot(
    terminal_id: &str,
    device: i32,
    paint: &Value,
    ansi: Vec<u8>,
    visible_only: bool,
) -> Result<TerminalSnapshot, TerminalError> {
    let paint: Paint = serde_json::from_value(paint.clone())
        .map_err(|error| TerminalError::RuntimeUnavailable(error.to_string()))?;
    Ok(TerminalSnapshot {
        terminal_id: terminal_id.to_owned(),
        backend_instance_id: backend(device),
        sequence: paint.seq,
        rows: paint.rows,
        cols: paint.cols,
        ansi,
        history_truncated: visible_only,
        status: TerminalStatus::Running,
        exit_code: None,
        exited_at: None,
        last_known_cwd: None,
    })
}

/// 接入：先登记接入方（快照回来之前到的输出不丢），再取快照。
pub(crate) async fn attach(
    terminal_id: &str,
    client_id: &str,
) -> Result<(TerminalSnapshot, UnboundedReceiver<RemoteEvent>), TerminalError> {
    let (device, target) =
        parse(terminal_id).ok_or_else(|| TerminalError::NotFound(terminal_id.to_owned()))?;
    let node = node(device)?;
    let (tx, rx) = unbounded_channel();
    node.terminals
        .subscribers
        .lock()
        .expect("subscribers lock")
        .entry(target.to_owned())
        .or_default()
        .insert(client_id.to_owned(), tx);
    let attached = node
        .terminal
        .request(
            &Request::Attach {
                target: target.to_owned(),
            },
            &[],
            OP_DEADLINE,
        )
        .await;
    match attached {
        Ok((paint, ansi)) => Ok((snapshot(terminal_id, device, &paint, ansi, false)?, rx)),
        Err(error) => {
            detach(terminal_id, client_id);
            Err(failed(error))
        }
    }
}

/// 拆除一个接入方；该终端没有接入方了才让对方停止推送。
pub(crate) fn detach(terminal_id: &str, client_id: &str) {
    let Some((device, target)) = parse(terminal_id) else {
        return;
    };
    let Ok(node) = node(device) else { return };
    let last = {
        let mut subscribers = node.terminals.subscribers.lock().expect("subscribers lock");
        let Some(clients) = subscribers.get_mut(target) else {
            return;
        };
        clients.remove(client_id);
        let empty = clients.is_empty();
        if empty {
            subscribers.remove(target);
        }
        empty
    };
    if last {
        let detach = node.terminal.request(
            &Request::Detach {
                target: target.to_owned(),
            },
            &[],
            OP_DEADLINE,
        );
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(detach);
        }
    }
}

/// 输入：排进会话即返回（同一终端按调用顺序送达）；失败只记日志。
pub(crate) fn write(terminal_id: &str, data: &[u8]) -> Result<(), TerminalError> {
    let (device, target) =
        parse(terminal_id).ok_or_else(|| TerminalError::NotFound(terminal_id.to_owned()))?;
    let node = node(device)?;
    super::yield_transfers();
    let sent = node.terminal.request(
        &Request::Input {
            target: target.to_owned(),
        },
        data,
        INPUT_DEADLINE,
    );
    let id = terminal_id.to_owned();
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|error| TerminalError::WriteFailed(error.to_string()))?;
    handle.spawn(async move {
        if let Err(error) = sent.await {
            tracing::warn!("[devices] input to {id} dropped: {}", error.message);
        }
    });
    Ok(())
}

/// 改尺寸，回改后的可视区画面。
pub(crate) async fn resize(
    terminal_id: &str,
    rows: u16,
    cols: u16,
) -> Result<TerminalSnapshot, TerminalError> {
    let (device, target) =
        parse(terminal_id).ok_or_else(|| TerminalError::NotFound(terminal_id.to_owned()))?;
    let node = node(device)?;
    let request = Request::Resize {
        target: target.to_owned(),
        rows,
        cols,
    };
    let (paint, ansi) = node
        .terminal
        .request(&request, &[], OP_DEADLINE)
        .await
        .map_err(failed)?;
    snapshot(terminal_id, device, &paint, ansi, true)
}

/// 关闭对方的终端，并从列表里去掉。
pub(crate) async fn close(terminal_id: &str) -> Result<(), TerminalError> {
    let (device, target) =
        parse(terminal_id).ok_or_else(|| TerminalError::NotFound(terminal_id.to_owned()))?;
    let node = node(device)?;
    node.terminal
        .request(
            &Request::Close {
                target: target.to_owned(),
            },
            &[],
            OP_DEADLINE,
        )
        .await
        .map_err(|error| TerminalError::TerminationFailed(error.message))?;
    node.terminals
        .listed
        .lock()
        .expect("listed lock")
        .descriptors
        .retain(|d| d.terminal_id != terminal_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_ids_carry_device_and_target_ref() {
        assert_eq!(parse("3/v1.eyJ2Ijox"), Some((3, "v1.eyJ2Ijox")));
        assert_eq!(parse("0b6f2e1c-uuid"), None);
        assert_eq!(parse("x/v1.a"), None);
        assert_eq!(parse("3/other"), None);
    }
}
