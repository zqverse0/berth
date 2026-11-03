//! 可续传会话：不做 IO 的状态机。调用方负责字节流：
//!
//! 1. 新字节流：客户端 [`Session::connect`]；服务端把读到的 Hello 交给 [`Session::handle`]。
//! 2. 收到帧 → [`Session::handle`]；之后循环 [`Session::poll_transmit`] 写出、[`Session::poll_event`] 取事件。
//! 3. 到 [`Session::next_timeout`] 时调 [`Session::handle_timeout`]。
//! 4. 字节流断了 → [`Session::disconnected`]；会话状态保留，换一条字节流从第 1 步续上。

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::time::Instant;

use crate::frame::{
    compress, decompress, flags, DataFrame, Frame, Priority, ProtoError, SessionId, MAX_FRAME_LEN,
    PROTOCOL_VERSION,
};
use crate::sched::{Scheduler, Stamp, Window};

/// 单条消息上限（重组后）。
const MAX_MESSAGE: usize = 64 * 1024 * 1024;
/// Data 帧头（含长度前缀与 kind），计入拥塞窗口。
const DATA_OVERHEAD: usize = 4 + 1 + 2 + 8 * 3;

/// 会话角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// 发起连接的一端（GUI）。
    Client,
    /// `berth node stdio`。
    Server,
}

/// 要发出的消息。
#[derive(Debug, Clone)]
pub struct Outgoing {
    /// 消息 id：请求由发起方分配，回复沿用请求的 id。
    pub id: u64,
    /// 优先级。
    pub priority: Priority,
    /// 内容（任意长度，调度时切片）。
    pub payload: Vec<u8>,
    /// 是否是回复。
    pub reply: bool,
    /// 请求的截止时间：到点没收到回复就产生 [`Event::TimedOut`]。
    pub deadline: Option<Instant>,
}

impl Outgoing {
    /// 请求。
    pub fn request(id: u64, priority: Priority, payload: Vec<u8>) -> Self {
        Self {
            id,
            priority,
            payload,
            reply: false,
            deadline: None,
        }
    }

    /// 回复。
    pub fn reply(id: u64, priority: Priority, payload: Vec<u8>) -> Self {
        Self {
            reply: true,
            ..Self::request(id, priority, payload)
        }
    }

    /// 设截止时间。
    pub fn deadline(mut self, at: Instant) -> Self {
        self.deadline = Some(at);
        self
    }
}

/// 收到的完整消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// 消息 id。
    pub id: u64,
    /// 是否是回复。
    pub reply: bool,
    /// 优先级。
    pub priority: Priority,
    /// 内容（已解压、已重组）。
    pub payload: Vec<u8>,
}

/// 会话事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// 握手完成；`resumed=false` 表示对方没有旧会话，未完成的请求要重发（会以超时的形式通知）。
    Connected {
        /// 是否续上。
        resumed: bool,
    },
    /// 一条完整消息。
    Message(Message),
    /// 对方撤销了消息：`reply=false` 是撤销它的请求（本端排队中的回复已丢弃）。
    Cancelled {
        /// 消息 id。
        id: u64,
        /// 撤销的是否是回复。
        reply: bool,
    },
    /// 请求到截止时间仍没有回复（迟到的回复会被丢弃）。
    TimedOut(u64),
}

/// 计数，供测试与状态显示。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    /// 已编号的 Data 帧数。
    pub sent_seq: u64,
    /// 已连续收到的最大 seq。
    pub recv_seq: u64,
    /// 断线后重发的帧数。
    pub resent_frames: u64,
    /// 收到的重复帧数。
    pub duplicate_frames: u64,
    /// 待确认的帧数。
    pub unacked_frames: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Handshaking,
    Open,
    Closed,
}

struct Sent {
    frame: DataFrame,
    /// 当前字节流上的发出时间；`None` 表示待重发。
    sent_at: Option<Instant>,
    resent: bool,
    stamp: Option<Stamp>,
}

impl Sent {
    fn wire_len(&self) -> usize {
        DATA_OVERHEAD + self.frame.payload.len()
    }
}

/// 一端的会话状态。
pub struct Session {
    role: Role,
    id: SessionId,
    state: State,
    next_seq: u64,
    recv_seq: u64,
    /// 续传后高优先级的新帧可能先于低优先级的重发帧到达：记下跳过的 seq。
    above: BTreeSet<u64>,
    unacked: VecDeque<Sent>,
    sched: Scheduler,
    window: Window,
    partial: HashMap<(u64, bool), Vec<u8>>,
    deadlines: HashMap<u64, Instant>,
    expired: HashSet<u64>,
    events: VecDeque<Event>,
    control: VecDeque<Frame>,
    ack_pending: bool,
    last_heard: Option<Instant>,
    /// 最近一次调用方给的时间：算下次唤醒时过滤掉已过去的时刻。
    clock: Option<Instant>,
    stats: Stats,
}

impl Session {
    /// 客户端会话；`id` 由调用方随机生成，重连时用同一个。
    pub fn client(id: SessionId) -> Self {
        Self::new(Role::Client, id)
    }

    /// 服务端会话：等客户端 Hello 决定续上还是新建。
    pub fn server() -> Self {
        Self::new(Role::Server, SessionId::default())
    }

    fn new(role: Role, id: SessionId) -> Self {
        Self {
            role,
            id,
            state: State::Idle,
            next_seq: 1,
            recv_seq: 0,
            above: BTreeSet::new(),
            unacked: VecDeque::new(),
            sched: Scheduler::default(),
            window: Window::new(),
            partial: HashMap::new(),
            deadlines: HashMap::new(),
            expired: HashSet::new(),
            events: VecDeque::new(),
            control: VecDeque::new(),
            ack_pending: false,
            last_heard: None,
            clock: None,
            stats: Stats::default(),
        }
    }

    /// 会话 id。
    pub fn id(&self) -> SessionId {
        self.id
    }

    /// 握手已完成且字节流在。
    pub fn is_open(&self) -> bool {
        self.state == State::Open
    }

    /// 最近一次收到任何帧的时间（心跳判活用）。
    pub fn last_heard(&self) -> Option<Instant> {
        self.last_heard
    }

    /// 计数。
    pub fn stats(&self) -> Stats {
        Stats {
            sent_seq: self.next_seq - 1,
            recv_seq: self.recv_seq,
            unacked_frames: self.unacked.len(),
            ..self.stats
        }
    }

    /// 某优先级排队未发的字节数（隧道按它决定是否继续读 socket）。
    pub fn queued_bytes(&self, priority: Priority) -> usize {
        self.sched.queued_bytes(priority)
    }

    /// 客户端：新字节流已建立，发 Hello。
    pub fn connect(&mut self) {
        debug_assert_eq!(self.role, Role::Client);
        self.on_new_transport();
        self.control.push_back(Frame::Hello {
            version: PROTOCOL_VERSION,
            session: self.id,
            recv_seq: self.recv_seq,
        });
        self.state = State::Handshaking;
    }

    /// 字节流断了：保留会话，等下一条字节流续上。
    pub fn disconnected(&mut self) {
        if self.state != State::Closed {
            self.on_new_transport();
            self.state = State::Idle;
        }
    }

    fn on_new_transport(&mut self) {
        self.window.reset();
        self.control.clear();
        self.ack_pending = false;
        for sent in &mut self.unacked {
            sent.sent_at = None;
        }
    }

    /// 排队一条消息；断线期间也可以排，续上后发出。
    pub fn send(&mut self, msg: Outgoing) {
        if let (false, Some(at)) = (msg.reply, msg.deadline) {
            self.deadlines.insert(msg.id, at);
        }
        let f = if msg.reply { flags::REPLY } else { 0 };
        self.sched.push(msg.id, f, msg.priority, msg.payload);
    }

    /// 撤销本端的请求：丢掉未发的部分，通知对方停止处理，迟到的回复丢弃。
    pub fn cancel(&mut self, id: u64) {
        self.deadlines.remove(&id);
        self.withdraw(id);
    }

    fn withdraw(&mut self, id: u64) {
        self.expired.insert(id);
        self.partial.remove(&(id, true));
        // 一块都没发出去就不必通知对方。
        if self.sched.cancel(id, false) != Some(false) {
            self.sched
                .push(id, flags::CANCEL, Priority::Interactive, Vec::new());
        }
    }

    /// 发心跳。
    pub fn ping(&mut self, token: u64) {
        if self.state == State::Open {
            self.control.push_back(Frame::Ping { token });
        }
    }

    /// 有交互时调用（可以是另一条连接上的交互）：到 `until` 之前非交互流量半速、不探测，给交互让路。
    pub fn set_yield_until(&mut self, until: Instant) {
        self.window.set_yield_until(until);
    }

    /// 下一个需要 [`Session::handle_timeout`] 的时间。
    pub fn next_timeout(&self) -> Option<Instant> {
        let backlog = self.sched.has(Priority::Normal)
            || self.sched.has(Priority::Bulk)
            || self.unacked.iter().any(|s| s.sent_at.is_none());
        let wake = self
            .clock
            .and_then(|now| self.window.wake_at(now))
            .filter(|_| backlog);
        self.deadlines.values().copied().chain(wake).min()
    }

    /// 处理到期的截止时间。
    pub fn handle_timeout(&mut self, now: Instant) {
        self.clock = Some(now);
        let due: Vec<u64> = self
            .deadlines
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in due {
            self.deadlines.remove(&id);
            self.withdraw(id);
            self.events.push_back(Event::TimedOut(id));
        }
    }

    /// 取下一个事件。
    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    /// 取下一帧要写出的字节；`None` 表示现在没有可发的。
    pub fn poll_transmit(&mut self, now: Instant) -> Option<Vec<u8>> {
        self.clock = Some(now);
        if let Some(frame) = self.control.pop_front() {
            return Some(frame.encode());
        }
        if self.state != State::Open {
            return None;
        }
        for priority in Priority::ALL {
            if !self.window.can_send(priority, now) {
                continue;
            }
            // 同一优先级先补发断线前没确认的，再发新的，保证同一消息的块按序。
            if let Some(sent) = self
                .unacked
                .iter_mut()
                .find(|s| s.sent_at.is_none() && s.frame.priority == priority)
            {
                sent.sent_at = Some(now);
                sent.resent = true;
                sent.frame.ack = self.recv_seq;
                let (frame, len) = (sent.frame.clone(), sent.wire_len());
                self.stats.resent_frames += 1;
                self.emit(now, &frame, len);
                return Some(Frame::Data(frame).encode());
            }
            if self.sched.has(priority) {
                let chunk = self
                    .sched
                    .next_chunk(priority, self.window.chunk_size())
                    .expect("queue not empty");
                let (payload, zstd) = match compress(&chunk.payload) {
                    Some(packed) => (packed, flags::ZSTD),
                    None => (chunk.payload, 0),
                };
                let frame = DataFrame {
                    flags: chunk.flags | zstd,
                    priority,
                    seq: self.next_seq,
                    ack: self.recv_seq,
                    id: chunk.id,
                    payload,
                };
                self.next_seq += 1;
                let len = DATA_OVERHEAD + frame.payload.len();
                let stamp = self.emit(now, &frame, len);
                let bytes = Frame::Data(frame.clone()).encode();
                self.unacked.push_back(Sent {
                    frame,
                    sent_at: Some(now),
                    resent: false,
                    stamp,
                });
                return Some(bytes);
            }
        }
        if self.ack_pending {
            self.ack_pending = false;
            return Some(Frame::Ack { ack: self.recv_seq }.encode());
        }
        None
    }

    /// 记账：确认已捎带；非交互帧计入窗口，返回送达速率取样用的记录。
    fn emit(&mut self, now: Instant, frame: &DataFrame, len: usize) -> Option<Stamp> {
        self.ack_pending = false;
        if frame.priority == Priority::Interactive {
            return None;
        }
        let app_limited = !self.sched.has(Priority::Normal) && !self.sched.has(Priority::Bulk);
        Some(self.window.on_sent(now, len, app_limited))
    }

    /// 处理收到的一帧。返回错误时字节流应关闭；`Version` / `Rejected` 表示会话不可再用。
    pub fn handle(&mut self, now: Instant, frame: Frame) -> Result<(), ProtoError> {
        self.last_heard = Some(now);
        match frame {
            Frame::Hello {
                version,
                session,
                recv_seq,
            } => {
                if self.role != Role::Server {
                    return Err(ProtoError::Unexpected("hello"));
                }
                if version != PROTOCOL_VERSION {
                    self.control.push_back(Frame::Reject {
                        version: PROTOCOL_VERSION,
                        reason: format!(
                            "protocol version mismatch: node {PROTOCOL_VERSION}, client {version}"
                        ),
                    });
                    return Err(ProtoError::Version {
                        ours: PROTOCOL_VERSION,
                        theirs: version,
                    });
                }
                let resumed = session == self.id && session != SessionId::default();
                if resumed {
                    self.on_new_transport();
                    self.peer_received(recv_seq);
                } else {
                    *self = Self::new(Role::Server, session);
                }
                self.control.push_back(Frame::Welcome {
                    version: PROTOCOL_VERSION,
                    session: self.id,
                    recv_seq: self.recv_seq,
                    resumed,
                });
                self.state = State::Open;
                self.events.push_back(Event::Connected { resumed });
            }
            Frame::Welcome {
                version,
                session,
                recv_seq,
                resumed,
            } => {
                if self.state != State::Handshaking {
                    return Err(ProtoError::Unexpected("welcome"));
                }
                if version != PROTOCOL_VERSION {
                    self.state = State::Closed;
                    return Err(ProtoError::Version {
                        ours: PROTOCOL_VERSION,
                        theirs: version,
                    });
                }
                if session != self.id {
                    return Err(ProtoError::Unexpected("welcome for another session"));
                }
                if resumed {
                    self.peer_received(recv_seq);
                } else {
                    // 对方没有旧会话（节点重启过）：编号从头来，发了一半的消息从头发；
                    // 已发完等回复的请求靠截止时间通知调用方重试。
                    self.next_seq = 1;
                    self.recv_seq = 0;
                    self.above.clear();
                    self.unacked.clear();
                    self.partial.clear();
                    self.sched.restart_all();
                }
                self.state = State::Open;
                self.events.push_back(Event::Connected { resumed });
            }
            Frame::Reject { reason, .. } => {
                self.state = State::Closed;
                return Err(ProtoError::Rejected(reason));
            }
            Frame::Data(data) => {
                if self.state != State::Open {
                    return Err(ProtoError::Unexpected("data before handshake"));
                }
                self.on_ack(now, data.ack);
                self.ack_pending = true;
                if data.seq <= self.recv_seq || !self.above.insert(data.seq) {
                    self.stats.duplicate_frames += 1;
                    return Ok(());
                }
                while self.above.remove(&(self.recv_seq + 1)) {
                    self.recv_seq += 1;
                }
                self.deliver(data)?;
            }
            Frame::Ack { ack } => self.on_ack(now, ack),
            Frame::Ping { token } => self.control.push_back(Frame::Pong { token }),
            Frame::Pong { .. } => {}
        }
        Ok(())
    }

    /// 握手得知对方已收到的位置：之前的不再重发。
    fn peer_received(&mut self, recv_seq: u64) {
        while self
            .unacked
            .front()
            .is_some_and(|s| s.frame.seq <= recv_seq)
        {
            self.unacked.pop_front();
        }
    }

    fn on_ack(&mut self, now: Instant, ack: u64) {
        let (mut bytes, mut sample) = (0, None);
        while let Some(sent) = self.unacked.front() {
            if sent.frame.seq > ack {
                break;
            }
            let sent = self.unacked.pop_front().expect("front exists");
            // 只算当前字节流上发出的；重发帧的往返不可靠，不取样。
            if let Some(at) = sent.sent_at {
                if let Some(stamp) = sent.stamp {
                    bytes += sent.wire_len();
                    if !sent.resent {
                        sample = Some((stamp, now.duration_since(at)));
                    }
                }
            }
        }
        if bytes > 0 {
            self.window.on_acked(now, bytes, sample);
        }
    }

    fn deliver(&mut self, data: DataFrame) -> Result<(), ProtoError> {
        let reply = data.flags & flags::REPLY != 0;
        let key = (data.id, reply);
        if data.flags & flags::CANCEL != 0 {
            self.partial.remove(&key);
            if !reply {
                // 对方撤回请求：排队中的回复不再发。
                self.sched.cancel(data.id, true);
            }
            self.events
                .push_back(Event::Cancelled { id: data.id, reply });
            return Ok(());
        }
        let fin = data.flags & flags::FIN != 0;
        if reply && self.expired.contains(&data.id) {
            if fin {
                self.expired.remove(&data.id);
            }
            return Ok(());
        }
        if reply {
            // 回复开始到达就算对方有响应；长回复靠心跳判活，不按截止时间砍掉。
            self.deadlines.remove(&data.id);
        }
        let payload = if data.flags & flags::ZSTD != 0 {
            decompress(&data.payload, MAX_FRAME_LEN)?
        } else {
            data.payload
        };
        let payload = match self.partial.remove(&key) {
            Some(mut buf) => {
                buf.extend_from_slice(&payload);
                buf
            }
            None => payload,
        };
        if payload.len() > MAX_MESSAGE {
            return Err(ProtoError::TooLarge(payload.len()));
        }
        if fin {
            self.events.push_back(Event::Message(Message {
                id: data.id,
                reply,
                priority: data.priority,
                payload,
            }));
        } else {
            self.partial.insert(key, payload);
        }
        Ok(())
    }
}
