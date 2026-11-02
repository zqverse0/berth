//! 发送调度：按优先级挑下一块、大消息切片轮转；非交互流量受基于延迟的拥塞窗口约束。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::frame::{flags, Priority};

/// 排队时延目标：非交互流量把链路队列压在这之内，交互帧最多多等这么久。
pub(crate) const QUEUE_TARGET: Duration = Duration::from_millis(50);
/// 一块的发送时间目标：交互帧最多等完正在发的一块。
const CHUNK_TIME: Duration = Duration::from_millis(20);
pub(crate) const MIN_CHUNK: usize = 512;
const MAX_CHUNK: usize = 64 * 1024;
const MIN_CWND: usize = 4 * 1024;
const INITIAL_CWND: usize = 8 * 1024;
const MAX_CWND: usize = 16 * 1024 * 1024;
/// 基准往返取最近几分钟的最小值：换路由后旧的最小值会过期。
const BASE_RTT_SLOT: Duration = Duration::from_secs(60);
const BASE_RTT_SLOTS: usize = 5;
const JITTER_WINDOW: Duration = Duration::from_millis(500);
/// 排队超过这个值才算链路忙；按忙时的连续确认测带宽，至少测这么久以平滑确认成批到达。
const TRAIN_QUEUE: Duration = Duration::from_millis(10);
const TRAIN_MIN: Duration = Duration::from_millis(200);

struct OutMsg {
    id: u64,
    flags: u8,
    payload: Vec<u8>,
    offset: usize,
}

/// 取出的一块。
pub(crate) struct Chunk {
    pub id: u64,
    pub flags: u8,
    pub payload: Vec<u8>,
}

/// 每个优先级一个队列；同一优先级内按消息轮转，一次一块，短消息不必等长消息发完。
#[derive(Default)]
pub(crate) struct Scheduler {
    queues: [VecDeque<OutMsg>; 3],
}

impl Scheduler {
    /// `flags` 只取 REPLY / CANCEL，FIN 由切片决定。
    pub fn push(&mut self, id: u64, flags: u8, priority: Priority, payload: Vec<u8>) {
        self.queues[priority as usize].push_back(OutMsg {
            id,
            flags,
            payload,
            offset: 0,
        });
    }

    pub fn has(&self, priority: Priority) -> bool {
        !self.queues[priority as usize].is_empty()
    }

    pub fn next_chunk(&mut self, priority: Priority, chunk: usize) -> Option<Chunk> {
        let queue = &mut self.queues[priority as usize];
        let mut msg = queue.pop_front()?;
        let end = (msg.offset + chunk).min(msg.payload.len());
        let payload = msg.payload[msg.offset..end].to_vec();
        msg.offset = end;
        let mut f = msg.flags;
        let (id, done) = (msg.id, end == msg.payload.len());
        if done {
            f |= flags::FIN;
        } else {
            queue.push_back(msg);
        }
        Some(Chunk {
            id,
            flags: f,
            payload,
        })
    }

    /// 某优先级排队未发的字节数。
    pub fn queued_bytes(&self, priority: Priority) -> usize {
        self.queues[priority as usize]
            .iter()
            .map(|m| m.payload.len() - m.offset)
            .sum()
    }

    /// 撤掉尚未发完的消息；返回它是否已发出过一部分（对方需要撤销通知）。
    pub fn cancel(&mut self, id: u64, reply: bool) -> Option<bool> {
        for queue in &mut self.queues {
            if let Some(at) = queue.iter().position(|m| {
                m.id == id && m.flags & flags::CANCEL == 0 && (m.flags & flags::REPLY != 0) == reply
            }) {
                return queue.remove(at).map(|m| m.offset > 0);
            }
        }
        None
    }

    /// 对方丢了会话：已发出一部分的消息从头再发。
    pub fn restart_all(&mut self) {
        self.queues.iter_mut().flatten().for_each(|m| m.offset = 0);
    }
}

/// 发送时刻的送达进度，确认时据此算送达速率。
#[derive(Clone, Copy)]
pub(crate) struct Stamp {
    delivered: u64,
    delivered_at: Instant,
    app_limited: bool,
    /// 按节拍发出的（建立后头一窗是突发，它造成的排队不说明带宽到顶）。
    paced: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// 刚建立：每往返翻倍探测带宽，直到排队超过目标。
    Startup,
    /// 以实测送达速率为节拍：每 8 个往返探测 1 个（×1.05），其余略低于带宽让队列排空。
    Steady,
}

/// 非交互流量的节拍发送（BBR 思路的精简版）。
///
/// 往返 2 秒时延迟反馈慢一个往返，按窗口加减必然过冲；这里直接测送达速率（最近 10 个往返的最大值）
/// 当作带宽，按 `带宽 × 增益` 的节拍发，在途字节不超过两倍带宽时延积。排队时延超过 [`QUEUE_TARGET`]
/// 时以 0.9 排空，所以链路队列稳定在目标附近，交互帧前面最多排着约一个目标时延的字节。
pub(crate) struct Window {
    mode: Mode,
    inflight: usize,
    delivered: u64,
    delivered_at: Option<Instant>,
    bw: VecDeque<(Instant, f64)>,
    min_rtt: VecDeque<(Instant, Duration)>,
    queued: Duration,
    /// 最近的往返样本：取窗口内最小值算排队，滤掉抖动尖峰（真排队会持续整个窗口）。
    recent_rtt: VecDeque<(Instant, Duration)>,
    /// 链路持续有排队时的起点（时间、已送达字节）：这段时间的送达速率就是瓶颈带宽。
    train: Option<(Instant, u64)>,
    steady_since: Option<Instant>,
    next_send: Option<Instant>,
    yield_until: Option<Instant>,
}

impl Window {
    pub fn new() -> Self {
        Self {
            mode: Mode::Startup,
            inflight: 0,
            delivered: 0,
            delivered_at: None,
            bw: VecDeque::new(),
            min_rtt: VecDeque::new(),
            queued: Duration::ZERO,
            recent_rtt: VecDeque::new(),
            train: None,
            steady_since: None,
            next_send: None,
            yield_until: None,
        }
    }

    fn base_rtt(&self) -> Option<Duration> {
        self.min_rtt.iter().map(|(_, rtt)| *rtt).min()
    }

    /// 估计带宽（字节 / 秒）。
    fn bandwidth(&self) -> Option<f64> {
        self.bw.iter().map(|(_, b)| *b).reduce(f64::max)
    }

    fn gain(&self, now: Instant) -> f64 {
        if self.yielding(now) {
            // 有交互：半速排空队列，不探测。
            return 0.5;
        }
        match self.mode {
            Mode::Startup => 2.0,
            Mode::Steady => {
                // 每 8 个往返：1 个探测、其余巡航；排队超目标时巡航降到 0.9 排空。
                // 不按排队时延一路降速：抖动大的链路上往返常年偏高，那不是排队，一路降会饿死。
                let rtt = self
                    .base_rtt()
                    .unwrap_or(Duration::from_secs(1))
                    .max(CHUNK_TIME);
                let since = self.steady_since.map_or(Duration::ZERO, |t| now - t);
                let phase = (since.as_secs_f64() / rtt.as_secs_f64()) as u64 % 8;
                match (phase, self.queued > QUEUE_TARGET) {
                    (0, false) => 1.05,
                    (_, true) => 0.9,
                    _ => 0.97,
                }
            }
        }
    }

    fn cwnd(&self) -> usize {
        match (self.bandwidth(), self.base_rtt()) {
            (Some(bw), Some(rtt)) => {
                // 启动期按 2 倍节拍发，在途要放得下 2 倍带宽时延积再多一些。
                let gain = if self.mode == Mode::Startup { 3.0 } else { 2.0 };
                ((gain * bw * rtt.as_secs_f64()) as usize).clamp(MIN_CWND, MAX_CWND)
            }
            _ => INITIAL_CWND,
        }
    }

    /// 一块的大小：按估计带宽发 [`CHUNK_TIME`] 的量。
    pub fn chunk_size(&self) -> usize {
        match self.bandwidth() {
            Some(bw) => ((bw * CHUNK_TIME.as_secs_f64()) as usize).clamp(MIN_CHUNK, MAX_CHUNK),
            None => MIN_CHUNK * 2,
        }
    }

    pub fn can_send(&self, priority: Priority, now: Instant) -> bool {
        let limit = match priority {
            Priority::Interactive => return true,
            Priority::Normal | Priority::Bulk => self.cwnd(),
        };
        self.inflight < limit && self.next_send.is_none_or(|t| t <= now)
    }

    pub fn yielding(&self, now: Instant) -> bool {
        self.yield_until.is_some_and(|t| now < t)
    }

    /// 非交互流量下一次可以按节拍发的时间。
    pub fn wake_at(&self, now: Instant) -> Option<Instant> {
        self.next_send.filter(|t| *t > now)
    }

    pub fn set_yield_until(&mut self, until: Instant) {
        self.yield_until = Some(self.yield_until.map_or(until, |t| t.max(until)));
    }

    /// `app_limited`：发完这块就没有后续可发（或正在让路），这段时间测到的速率不代表带宽。
    pub fn on_sent(&mut self, now: Instant, bytes: usize, app_limited: bool) -> Stamp {
        self.inflight += bytes;
        if let Some(bw) = self.bandwidth() {
            let start = self.next_send.map_or(now, |t| t.max(now));
            let gap = bytes as f64 / (bw * self.gain(now));
            self.next_send = Some(start + Duration::from_secs_f64(gap));
        }
        Stamp {
            delivered: self.delivered,
            delivered_at: self.delivered_at.unwrap_or(now),
            app_limited: app_limited || self.yielding(now),
            paced: self.bandwidth().is_some(),
        }
    }

    /// `sample`：最新确认的那一帧的发送记录与往返（重发帧不取样）。
    pub fn on_acked(&mut self, now: Instant, bytes: usize, sample: Option<(Stamp, Duration)>) {
        self.inflight = self.inflight.saturating_sub(bytes);
        self.delivered += bytes as u64;
        self.delivered_at = Some(now);
        let Some((stamp, rtt)) = sample else { return };
        push_slot(&mut self.min_rtt, now, rtt, |old, new| new < old);
        let base = self.base_rtt().expect("just recorded");
        self.recent_rtt.push_back((now, rtt));
        while self
            .recent_rtt
            .front()
            .is_some_and(|(t, _)| now - *t > JITTER_WINDOW)
        {
            self.recent_rtt.pop_front();
        }
        let recent = self
            .recent_rtt
            .iter()
            .map(|(_, r)| *r)
            .min()
            .expect("just pushed");
        self.queued = recent.saturating_sub(base);

        let interval = now.duration_since(stamp.delivered_at).max(rtt);
        let rate = (self.delivered - stamp.delivered) as f64 / interval.as_secs_f64();
        if !stamp.app_limited || self.bandwidth().is_none_or(|bw| rate > bw) {
            self.bw.push_back((now, rate));
        }
        // 有排队说明链路忙，连续确认的到达速率就是瓶颈带宽：不必等启动期一轮轮翻倍。
        if rtt.saturating_sub(base) >= TRAIN_QUEUE {
            let (t0, d0) = *self.train.get_or_insert((now, self.delivered));
            if now - t0 >= TRAIN_MIN {
                let rate = (self.delivered - d0) as f64 / (now - t0).as_secs_f64();
                self.bw.push_back((now, rate));
                let pace = self.bandwidth().map(|bw| bw * self.gain(now));
                // 送达明显慢于发送：已到瓶颈（只是抖动时送达速率跟得上发送速率）。
                if self.mode == Mode::Startup && pace.is_none_or(|p| rate < 0.8 * p) {
                    self.enter_steady(now);
                }
            }
        } else {
            self.train = None;
        }
        let keep = (base * 10).max(Duration::from_secs(1));
        while self.bw.len() > 1 && self.bw.front().is_some_and(|(t, _)| now - *t > keep) {
            self.bw.pop_front();
        }
        if self.mode == Mode::Startup && stamp.paced && self.queued > QUEUE_TARGET {
            self.enter_steady(now);
        }
    }

    fn enter_steady(&mut self, now: Instant) {
        self.mode = Mode::Steady;
        self.steady_since = Some(now);
    }

    /// 换了一条字节流（可能换了地址）：在途清零，重新测带宽与基准往返。
    pub fn reset(&mut self) {
        *self = Self {
            yield_until: self.yield_until,
            ..Self::new()
        };
    }
}

/// 按分钟分槽记极值，保留最近几槽：换路由后旧的极值会过期。
fn push_slot(
    slots: &mut VecDeque<(Instant, Duration)>,
    now: Instant,
    value: Duration,
    better: impl Fn(Duration, Duration) -> bool,
) {
    match slots.back_mut() {
        Some((start, v)) if now.duration_since(*start) < BASE_RTT_SLOT => {
            if better(*v, value) {
                *v = value;
            }
        }
        _ => {
            slots.push_back((now, value));
            if slots.len() > BASE_RTT_SLOTS {
                slots.pop_front();
            }
        }
    }
}
