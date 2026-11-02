//! 按任务「在最差预算下必须成立的保证」写的模拟测试。

use std::time::{Duration, Instant};

use berth_node::frame::Frame;
use berth_node::sim::{LinkSpec, Side, Sim};
use berth_node::{Event, Message, Outgoing, Priority, ProtoError, Session, PROTOCOL_VERSION};

const SECS: fn(u64) -> Duration = Duration::from_secs;

/// 交互帧前面最多排着：拥塞窗口的排队目标 + 正在发的一块（各约 50ms、20ms），留余量。
const QUEUE_SLACK: Duration = Duration::from_millis(150);

fn data_frame_len(payload: usize) -> usize {
    4 + 1 + 2 + 8 * 3 + payload
}

/// 不可压缩的内容（传输测试不能靠压缩占便宜）。
fn noise(len: usize) -> Vec<u8> {
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

fn message(ev: &Event) -> Option<&Message> {
    match ev {
        Event::Message(m) => Some(m),
        _ => None,
    }
}

/// 保证 1：传输进行中，终端按键到回显 ≤ 1 次往返 + 本帧字节时间（+ 不可抢占的排队余量），
/// 且传输本身仍在用带宽。
#[test]
fn keystroke_echo_unaffected_by_transfer() {
    let mut sim = Sim::new(LinkSpec::worst());
    let term = sim.open();
    let xfer = sim.open();
    let size = 600 * 1024;
    sim.session(xfer, Side::Client)
        .send(Outgoing::request(1, Priority::Bulk, noise(size)));

    let mut typed: Vec<(u64, Instant)> = Vec::new();
    let mut echoes = Vec::new();
    let mut transfer_done = None;
    let mut next_key = SECS(15);
    let mut key = 0u64;
    while sim.elapsed() < SECS(60) || transfer_done.is_none() {
        assert!(sim.elapsed() < SECS(120), "transfer stalled");
        let until = if key < 10 { next_key } else { SECS(300) };
        match sim.next_event(until) {
            None => {
                // 每 3 秒敲一个键；按 GUI 的做法，敲键时让传输连接让路。
                key += 1;
                let now = sim.now();
                typed.push((key, now));
                sim.session(xfer, Side::Client)
                    .set_yield_until(now + SECS(2));
                sim.session(term, Side::Client).send(Outgoing::request(
                    key,
                    Priority::Interactive,
                    b"k".to_vec(),
                ));
                next_key += SECS(3);
            }
            Some((c, Side::Server, Event::Message(m))) if c == term => {
                sim.session(term, Side::Server).send(Outgoing::reply(
                    m.id,
                    Priority::Interactive,
                    b"k".to_vec(),
                ));
            }
            Some((c, Side::Client, Event::Message(m))) if c == term => {
                let sent = typed.iter().find(|(k, _)| *k == m.id).unwrap().1;
                echoes.push(sim.now() - sent);
            }
            Some((c, Side::Server, Event::Message(m))) if c == xfer => {
                assert_eq!(m.payload.len(), size);
                transfer_done = Some(sim.elapsed());
            }
            Some(_) => {}
        }
    }

    let spec = sim.spec();
    let bound = spec.rtt + spec.transmit_time(2 * data_frame_len(1)) + QUEUE_SLACK;
    assert_eq!(echoes.len(), 10);
    for echo in &echoes {
        assert!(*echo <= bound, "echo {echo:?} > {bound:?}, all: {echoes:?}");
    }
    // 600KB 在 30KB/s 上至少 20 秒；让路和拥塞控制的代价不超过一倍。
    let done = transfer_done.unwrap();
    assert!(done < SECS(45), "transfer took {done:?}");
}

/// 保证 5：断开 30 秒并换地址后自动续上；已确认的数据不重发；断开期间的输入恰好执行一次。
#[test]
fn resume_after_disconnect_and_address_change() {
    let mut sim = Sim::new(LinkSpec::worst());
    let conn = sim.open();
    let size = 300 * 1024;
    let mut inputs = Vec::new();
    let mut download = None;
    let mut unacked_at_cut = 0;
    let mut client_recv_at_cut = 0;

    // 先握手，再让服务端推一个大回复，客户端每秒输入一次。
    while sim.next_event(SECS(3)).is_some() {}
    sim.session(conn, Side::Server)
        .send(Outgoing::reply(99, Priority::Normal, noise(size)));
    let mut sent_inputs = 0u64;
    for second in 4..80u64 {
        if second == 10 {
            let server = sim.session(conn, Side::Server).stats();
            unacked_at_cut = server.sent_seq;
            client_recv_at_cut = sim.session(conn, Side::Client).stats().recv_seq;
            sim.disconnect(conn);
        }
        if second == 40 {
            sim.reconnect(conn);
        }
        if second < 50 {
            sent_inputs += 1;
            sim.session(conn, Side::Client).send(Outgoing::request(
                sent_inputs,
                Priority::Interactive,
                format!("input-{sent_inputs}").into_bytes(),
            ));
        }
        while let Some((_, side, ev)) = sim.next_event(SECS(second)) {
            match (side, ev) {
                (Side::Server, Event::Message(m)) => inputs.push(m.id),
                (Side::Client, Event::Message(m)) => download = Some(m.payload.len()),
                _ => {}
            }
        }
    }

    assert_eq!(inputs, (1..=sent_inputs).collect::<Vec<_>>());
    assert_eq!(download, Some(size));
    let server = sim.session(conn, Side::Server).stats();
    let client = sim.session(conn, Side::Client).stats();
    assert_eq!(server.duplicate_frames + client.duplicate_frames, 0);
    // 服务端只重发客户端断开时还没收到的那些。
    assert!(server.resent_frames <= unacked_at_cut - client_recv_at_cut);
    assert!(
        server.resent_frames > 0,
        "the cut should have caught frames in flight"
    );
}

/// 最差预算里的抖动与间歇卡顿：传输不被误判成拥塞而饿死。
#[test]
fn transfer_survives_jitter_and_stalls() {
    let mut sim = Sim::new(LinkSpec {
        jitter: Duration::from_millis(300),
        ..LinkSpec::worst()
    });
    sim.stall(SECS(10), SECS(5));
    let conn = sim.open();
    let size = 600 * 1024;
    sim.session(conn, Side::Client)
        .send(Outgoing::request(1, Priority::Bulk, noise(size)));
    let mut done = None;
    while let Some((_, side, ev)) = sim.next_event(SECS(120)) {
        if let (Side::Server, Event::Message(m)) = (side, ev) {
            assert_eq!(m.payload.len(), size);
            done = Some(sim.elapsed());
        }
    }
    // 理想约 20 秒发送 + 5 秒卡顿 + 握手；抖动下的保守估计不超过两倍。
    let done = done.expect("transfer finished");
    assert!(done < SECS(60), "transfer took {done:?}");
}

/// 保证 6：请求有截止时间，链路卡住时按时报超时，迟到的回复被丢弃，恢复后重试成功。
#[test]
fn deadline_fires_during_stall_and_late_reply_is_dropped() {
    let mut sim = Sim::new(LinkSpec::worst());
    let conn = sim.open();
    while sim.next_event(SECS(3)).is_some() {}
    sim.stall(SECS(3), SECS(20));
    let deadline = sim.now() + SECS(5);
    sim.session(conn, Side::Client)
        .send(Outgoing::request(1, Priority::Normal, b"list".to_vec()).deadline(deadline));
    let mut timed_out = None;
    let mut replies = Vec::new();
    while let Some((_, side, ev)) = sim.next_event(SECS(60)) {
        match (side, ev) {
            (Side::Server, Event::Message(m)) => {
                let reply = Outgoing::reply(m.id, Priority::Normal, b"ok".to_vec());
                sim.session(conn, Side::Server).send(reply);
            }
            (Side::Client, Event::TimedOut(id)) => {
                timed_out = Some(sim.now());
                // 重试入口：同样的请求换个 id 再发。
                let retry = Outgoing::request(id + 1, Priority::Normal, b"list".to_vec())
                    .deadline(sim.now() + SECS(30));
                sim.session(conn, Side::Client).send(retry);
            }
            (Side::Client, Event::Message(m)) => replies.push(m.id),
            _ => {}
        }
    }
    assert_eq!(timed_out, Some(deadline));
    assert_eq!(replies, vec![2]);
}

/// 保证 1（会话内）：大回复切片发送时，交互消息插队，不等大回复发完。
#[test]
fn interactive_jumps_ahead_of_large_reply() {
    let mut sim = Sim::new(LinkSpec::worst());
    let conn = sim.open();
    while sim.next_event(SECS(3)).is_some() {}
    sim.session(conn, Side::Server)
        .send(Outgoing::reply(1, Priority::Normal, noise(512 * 1024)));
    while sim.next_event(SECS(10)).is_some() {}
    let asked = sim.now();
    sim.session(conn, Side::Client).send(Outgoing::request(
        2,
        Priority::Interactive,
        b"k".to_vec(),
    ));
    let mut echo = None;
    let mut big_done = None;
    while let Some((_, side, ev)) = sim.next_event(SECS(60)) {
        match (side, &ev) {
            (Side::Server, Event::Message(m)) if m.id == 2 => {
                let reply = Outgoing::reply(2, Priority::Interactive, b"k".to_vec());
                sim.session(conn, Side::Server).send(reply);
            }
            (Side::Client, _) => match message(&ev).map(|m| m.id) {
                Some(1) => big_done = Some(sim.now()),
                Some(2) => echo = Some(sim.now() - asked),
                _ => {}
            },
            _ => {}
        }
    }
    let spec = sim.spec();
    let echo = echo.unwrap();
    assert!(echo <= spec.rtt + QUEUE_SLACK, "echo {echo:?}");
    assert!(big_done.unwrap() > asked + echo);
}

/// 保证 4：可压缩内容走 zstd，线上字节明显少于原文。
#[test]
fn compressible_payload_shrinks_on_the_wire() {
    let mut client = Session::client(berth_node::SessionId([9; 16]));
    let mut server = Session::server();
    let now = Instant::now();
    client.connect();
    let hello = client.poll_transmit(now).unwrap();
    server
        .handle(now, Frame::decode(&hello[4..]).unwrap())
        .unwrap();
    let welcome = server.poll_transmit(now).unwrap();
    client
        .handle(now, Frame::decode(&welcome[4..]).unwrap())
        .unwrap();
    let text = "fn main() { println!(\"berth\"); }\n"
        .repeat(16)
        .into_bytes();
    client.send(Outgoing::request(1, Priority::Normal, text.clone()));
    let wire = client.poll_transmit(now).unwrap();
    assert!(wire.len() < text.len() / 4, "{} bytes on wire", wire.len());
    server
        .handle(now, Frame::decode(&wire[4..]).unwrap())
        .unwrap();
    while let Some(ev) = server.poll_event() {
        if let Event::Message(m) = ev {
            assert_eq!(m.payload, text);
            return;
        }
    }
    panic!("message not delivered");
}

/// 约定 1：握手版本不一致直接拒绝。
#[test]
fn version_mismatch_is_rejected() {
    let mut server = Session::server();
    let now = Instant::now();
    let hello = Frame::Hello {
        version: PROTOCOL_VERSION + 1,
        session: berth_node::SessionId([1; 16]),
        recv_seq: 0,
    };
    assert!(matches!(
        server.handle(now, hello),
        Err(ProtoError::Version { .. })
    ));
    let reject = server.poll_transmit(now).unwrap();
    let mut client = Session::client(berth_node::SessionId([1; 16]));
    client.connect();
    let _ = client.poll_transmit(now);
    assert!(matches!(
        client.handle(now, Frame::decode(&reject[4..]).unwrap()),
        Err(ProtoError::Rejected(_))
    ));
}
