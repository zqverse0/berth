//! 设备窗口的连接隧道：把对方页面的每条连接（HTTP / WebSocket）接到本机 GUI 的设备 socket
//! （`remote::DEVICE_SOCKET`），字节经节点会话传输，享有会话的优先级与基于时延的拥塞控制。
//!
//! 流控：会话里这条流所在优先级还没发出的字节超过 [`BACKLOG`] 就不再从 socket 读。读的节奏于是跟着
//! 链路走；读不动时 GUI 的写阻塞在 socket 上，它自己的分块轮转（大响应与小响应、事件交替）才起作用，
//! 而不是一口气塞进会话排队。

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use berth_node::api::{Lane, Push};
use berth_node::Priority;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::Notify;
use tokio::task::AbortHandle;

use super::Cmd;

/// 每个优先级在会话里排队未发的上限（约一块）。
const BACKLOG: usize = 16 * 1024;
/// 一次从 socket 读多少。
const CHUNK: usize = 16 * 1024;
const LANES: [Lane; 3] = [Lane::Interactive, Lane::Normal, Lane::Bulk];

/// 各优先级在会话里排队未发的字节数（由会话循环每次写出后更新）。
#[derive(Default)]
struct Backlog {
    queued: [AtomicUsize; 3],
    drained: Notify,
}

impl Backlog {
    /// 等到这条道排队的低于上限。
    async fn wait(&self, lane: Lane) {
        loop {
            let drained = self.drained.notified();
            if self.queued[lane as usize].load(Ordering::Relaxed) < BACKLOG {
                return;
            }
            drained.await;
        }
    }
}

struct Stream {
    lane: Lane,
    writes: UnboundedSender<(u64, Vec<u8>)>,
    task: AbortHandle,
}

/// 一个会话里的全部隧道流。
#[derive(Default)]
pub(super) struct Tunnels {
    streams: HashMap<u64, Stream>,
    backlog: Arc<Backlog>,
}

impl Tunnels {
    /// 流的优先级；已关闭的流按普通。
    pub(super) fn lane(&self, stream: u64) -> Lane {
        self.streams.get(&stream).map_or(Lane::Normal, |s| s.lane)
    }

    /// 会话写出后更新各道排队量，唤醒等着读的流。
    pub(super) fn backlog(&self, queued: impl Fn(Priority) -> usize) {
        for lane in LANES {
            self.backlog.queued[lane as usize].store(queued(lane.into()), Ordering::Relaxed);
        }
        self.backlog.drained.notify_waiters();
    }

    /// 打开流：连接设备 socket，读到的字节以 [`Push::Data`] 推回，结束推 [`Push::Closed`]。
    pub(super) fn connect(&mut self, stream: u64, lane: Lane, tx: UnboundedSender<Cmd>) {
        let (writes, mut queue) = unbounded_channel::<(u64, Vec<u8>)>();
        let backlog = self.backlog.clone();
        let task = tokio::spawn(async move {
            let socket = super::data_dir().join("remote.sock");
            let Some(conn) = connect_host(&socket).await else {
                let _ = tx.send(Cmd::Push(Push::Closed { stream, offset: 0 }, Vec::new()));
                return;
            };
            let (mut reader, mut writer) = conn.into_split();
            // 写：按偏移排序后依次写入（同优先级的大小消息可能交错到达）。
            tokio::spawn(async move {
                let (mut next, mut pending) = (0u64, BTreeMap::new());
                while let Some((offset, bytes)) = queue.recv().await {
                    pending.insert(offset, bytes);
                    while let Some(bytes) = pending.remove(&next) {
                        next += bytes.len() as u64;
                        if writer.write_all(&bytes).await.is_err() {
                            return;
                        }
                    }
                }
                let _ = writer.shutdown().await;
            });
            let mut offset = 0u64;
            let mut buf = vec![0; CHUNK];
            loop {
                backlog.wait(lane).await;
                let n = match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let push = Push::Data { stream, offset };
                offset += n as u64;
                // 先记上再交给会话循环：它处理完这条推送、写出后会用实际排队量覆盖并唤醒。
                // 反过来会在它覆盖之后才加上，计数卡在上限而再没有唤醒。
                backlog.queued[lane as usize].fetch_add(n, Ordering::Relaxed);
                if tx.send(Cmd::Push(push, buf[..n].to_vec())).is_err() {
                    return;
                }
            }
            let _ = tx.send(Cmd::Push(Push::Closed { stream, offset }, Vec::new()));
        });
        self.streams.insert(
            stream,
            Stream {
                lane,
                writes,
                task: task.abort_handle(),
            },
        );
    }

    pub(super) fn send(&self, stream: u64, offset: u64, bytes: Vec<u8>) {
        if let Some(s) = self.streams.get(&stream) {
            let _ = s.writes.send((offset, bytes));
        }
    }

    /// 关流：写完已收到的再关写端，停止读。
    pub(super) fn shut(&mut self, stream: u64) {
        if let Some(s) = self.streams.remove(&stream) {
            s.task.abort();
        }
    }
}

impl Drop for Tunnels {
    fn drop(&mut self) {
        for s in self.streams.values() {
            s.task.abort();
        }
    }
}

/// 连设备 socket；GUI 没在运行而这里能起无界面宿主（无显示器）时以 `berth-gui --headless` 拉起它，等它监听。
async fn connect_host(socket: &std::path::Path) -> Option<tokio::net::UnixStream> {
    if let Ok(conn) = tokio::net::UnixStream::connect(socket).await {
        return Some(conn);
    }
    if !crate::gui_launch::can_launch_host() {
        return None;
    }
    // 两条线同时到时各拉一次，多出的那个无界面宿主拿不到锁会自行退出。
    let _ = tokio::task::spawn_blocking(|| crate::gui_launch::try_launch_gui(None)).await;
    for _ in 0..50 {
        if let Ok(conn) = tokio::net::UnixStream::connect(socket).await {
            return Some(conn);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    None
}

