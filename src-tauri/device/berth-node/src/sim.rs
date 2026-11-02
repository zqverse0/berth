//! 最差链路模拟器：虚拟时间下，把若干条连接（每条一对客户端 / 服务端会话）跑在同一条链路上。
//!
//! 链路每个方向一个按字节串行的队列（带宽），再加单程延迟与抖动；同一连接内保序。
//! 可注入卡顿（期间不出不进）、断开（在途帧全丢）与换地址（新字节流重新握手）。
//! 发送端只要会话肯给就立刻写进链路队列——相当于系统缓冲无限大，是排队最坏的情况。

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::time::{Duration, Instant};

use crate::frame::Frame;
use crate::frame::SessionId;
use crate::session::{Event, Session};

/// 链路参数。
#[derive(Debug, Clone, Copy)]
pub struct LinkSpec {
    /// 往返时间（不含排队与发送时间）。
    pub rtt: Duration,
    /// 每个方向的带宽，字节 / 秒。
    pub bandwidth: u64,
    /// 单程附加的随机延迟上限。
    pub jitter: Duration,
    /// 随机种子。
    pub seed: u64,
}

impl LinkSpec {
    /// 最差预算：往返 2 秒、30KB/s。
    pub fn worst() -> Self {
        Self {
            rtt: Duration::from_secs(2),
            bandwidth: 30 * 1024,
            jitter: Duration::ZERO,
            seed: 1,
        }
    }

    /// `bytes` 在链路上的发送时间。
    pub fn transmit_time(&self, bytes: usize) -> Duration {
        Duration::from_secs_f64(bytes as f64 / self.bandwidth as f64)
    }
}

/// 连接的哪一端。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// 客户端。
    Client,
    /// 服务端。
    Server,
}

struct Conn {
    client: Session,
    server: Session,
    epoch: u32,
    up: bool,
    last_arrival: [Instant; 2],
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct InFlight {
    at: Instant,
    order: u64,
    conn: usize,
    to_server: bool,
    epoch: u32,
    bytes: Vec<u8>,
}

/// 模拟器。
pub struct Sim {
    spec: LinkSpec,
    start: Instant,
    now: Instant,
    conns: Vec<Conn>,
    busy_until: [Instant; 2],
    stalls: Vec<(Instant, Instant)>,
    flight: BinaryHeap<Reverse<InFlight>>,
    order: u64,
    rng: u64,
    pending: std::collections::VecDeque<(usize, Side, Event)>,
}

impl Sim {
    /// 新链路。
    pub fn new(spec: LinkSpec) -> Self {
        let now = Instant::now();
        Self {
            spec,
            start: now,
            now,
            conns: Vec::new(),
            busy_until: [now; 2],
            stalls: Vec::new(),
            flight: BinaryHeap::new(),
            order: 0,
            rng: spec.seed.max(1),
            pending: Default::default(),
        }
    }

    /// 当前虚拟时间。
    pub fn now(&self) -> Instant {
        self.now
    }

    /// 从开始到现在的虚拟时间。
    pub fn elapsed(&self) -> Duration {
        self.now - self.start
    }

    /// 链路参数。
    pub fn spec(&self) -> LinkSpec {
        self.spec
    }

    /// 新开一条连接并握手，返回连接编号。
    pub fn open(&mut self) -> usize {
        let id = SessionId([self.conns.len() as u8 + 1; 16]);
        self.conns.push(Conn {
            client: Session::client(id),
            server: Session::server(),
            epoch: 0,
            up: true,
            last_arrival: [self.now; 2],
        });
        let conn = self.conns.len() - 1;
        self.conns[conn].client.connect();
        conn
    }

    /// 某一端的会话。
    pub fn session(&mut self, conn: usize, side: Side) -> &mut Session {
        match side {
            Side::Client => &mut self.conns[conn].client,
            Side::Server => &mut self.conns[conn].server,
        }
    }

    /// 断开：在途帧全丢，两端都得知断线。
    pub fn disconnect(&mut self, conn: usize) {
        let c = &mut self.conns[conn];
        c.up = false;
        c.epoch += 1;
        c.client.disconnected();
        c.server.disconnected();
    }

    /// 换一个地址重新连上：新字节流，客户端重新握手。
    pub fn reconnect(&mut self, conn: usize) {
        let now = self.now;
        let c = &mut self.conns[conn];
        c.up = true;
        c.epoch += 1;
        c.last_arrival = [now; 2];
        c.client.connect();
    }

    /// 从 `from` 起卡住 `len`：期间链路不出不进。
    pub fn stall(&mut self, from: Duration, len: Duration) {
        let from = self.start + from;
        self.stalls.push((from, from + len));
    }

    fn unstall(&self, mut at: Instant) -> Instant {
        while let Some(&(_, end)) = self.stalls.iter().find(|(s, e)| *s <= at && at < *e) {
            at = end;
        }
        at
    }

    fn jitter(&mut self) -> Duration {
        if self.spec.jitter.is_zero() {
            return Duration::ZERO;
        }
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        self.spec.jitter.mul_f64((self.rng % 1000) as f64 / 1000.0)
    }

    fn pump(&mut self) {
        for conn in 0..self.conns.len() {
            if !self.conns[conn].up {
                continue;
            }
            for to_server in [true, false] {
                loop {
                    let now = self.now;
                    let c = &mut self.conns[conn];
                    let sender = if to_server {
                        &mut c.client
                    } else {
                        &mut c.server
                    };
                    let Some(bytes) = sender.poll_transmit(now) else {
                        break;
                    };
                    let dir = to_server as usize;
                    let start = self.unstall(self.busy_until[dir].max(now));
                    let done = start + self.spec.transmit_time(bytes.len());
                    self.busy_until[dir] = done;
                    let jitter = self.jitter();
                    let at = self.unstall(done + self.spec.rtt / 2 + jitter);
                    let c = &mut self.conns[conn];
                    let at = at.max(c.last_arrival[dir]);
                    c.last_arrival[dir] = at;
                    self.order += 1;
                    self.flight.push(Reverse(InFlight {
                        at,
                        order: self.order,
                        conn,
                        to_server,
                        epoch: c.epoch,
                        bytes,
                    }));
                }
            }
        }
    }

    fn collect_events(&mut self) {
        for (conn, c) in self.conns.iter_mut().enumerate() {
            while let Some(ev) = c.client.poll_event() {
                self.pending.push_back((conn, Side::Client, ev));
            }
            while let Some(ev) = c.server.poll_event() {
                self.pending.push_back((conn, Side::Server, ev));
            }
        }
    }

    /// 推进到下一个应用事件或 `until`（相对开始的时间）。返回 `None` 表示已到 `until`。
    /// 调用方处理事件时可以往会话里 send，下一次调用会把它们发出去。
    pub fn next_event(&mut self, until: Duration) -> Option<(usize, Side, Event)> {
        let until = self.start + until;
        loop {
            self.pump();
            self.collect_events();
            if let Some(ev) = self.pending.pop_front() {
                return Some(ev);
            }
            let timer = self
                .conns
                .iter()
                .flat_map(|c| [c.client.next_timeout(), c.server.next_timeout()])
                .flatten()
                .filter(|t| *t > self.now)
                .min();
            let arrival = self.flight.peek().map(|Reverse(f)| f.at);
            let next = [timer, arrival].into_iter().flatten().min();
            match next {
                Some(t) if t <= until => self.now = self.now.max(t),
                _ => {
                    self.now = self.now.max(until);
                    return None;
                }
            }
            while self
                .flight
                .peek()
                .is_some_and(|Reverse(f)| f.at <= self.now)
            {
                let Reverse(f) = self.flight.pop().expect("peeked");
                let c = &mut self.conns[f.conn];
                if !c.up || f.epoch != c.epoch {
                    continue;
                }
                let frame = Frame::decode(&f.bytes[4..]).expect("sim frames are well-formed");
                let receiver = if f.to_server {
                    &mut c.server
                } else {
                    &mut c.client
                };
                receiver
                    .handle(self.now, frame)
                    .expect("sim frames are accepted");
            }
            let now = self.now;
            for c in &mut self.conns {
                c.client.handle_timeout(now);
                c.server.handle_timeout(now);
            }
        }
    }
}
