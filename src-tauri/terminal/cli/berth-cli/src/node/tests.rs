//! 节点服务端到端：真实 Unix socket 上握手、请求回复、断线续传、版本不一致拒绝。

use std::time::Duration;

use berth_node::api::{self, Reply, Request};
use berth_node::{Decoder, Event, Frame, Outgoing, Priority, Session, SessionId, PROTOCOL_VERSION};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::{serve_at, Ctx};

/// 节点会读（必要时升级）数据库：测试一律指向进程内唯一的空数据目录，绝不碰本机真实的库
/// （Agent 终端里 `BERTH_DATA_DIR` 常指向正式版数据）。
fn isolate_data() {
    static DATA: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let dir = DATA.get_or_init(|| tempfile::tempdir().unwrap());
    std::env::set_var(berth_project_core::instance::DATA_DIR_ENV, dir.path());
    std::env::remove_var(berth_project_core::instance::DATA_FILE_ENV);
}

async fn start() -> (tempfile::TempDir, std::path::PathBuf) {
    isolate_data();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("node.sock");
    let ctx = Ctx;
    let serve_path = path.clone();
    tokio::spawn(async move { serve_at(&serve_path, ctx, Duration::from_secs(60)).await });
    for _ in 0..100 {
        if UnixStream::connect(&path).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (dir, path)
}

struct Conn {
    stream: UnixStream,
    decoder: Decoder,
}

async fn open(path: &std::path::Path) -> Conn {
    Conn {
        stream: UnixStream::connect(path).await.unwrap(),
        decoder: Decoder::awaiting_handshake(),
    }
}

/// 把会话要发的帧写出，读到 `want` 个事件为止。
async fn exchange(conn: &mut Conn, session: &mut Session, want: usize) -> Vec<Event> {
    let Conn { stream, decoder } = conn;
    let mut events = Vec::new();
    let mut buf = vec![0; 64 * 1024];
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            while let Some(bytes) = session.poll_transmit(std::time::Instant::now()) {
                stream.write_all(&bytes).await.unwrap();
            }
            while let Some(event) = session.poll_event() {
                events.push(event);
            }
            if events.len() >= want {
                return;
            }
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0, "node closed the stream");
            decoder.push(&buf[..n]);
            while let Some(frame) = decoder.next_frame().unwrap() {
                session.handle(std::time::Instant::now(), frame).unwrap();
            }
        }
    })
    .await
    .expect("node answered in time");
    events
}

fn dirs_request(id: u64) -> Outgoing {
    Outgoing::request(id, Priority::Normal, api::encode(&Request::Dirs { path: None }, &[]))
}

fn reply_of(event: &Event) -> Option<(u64, Reply)> {
    match event {
        Event::Message(message) if message.reply => {
            Some((message.id, api::decode::<Reply>(&message.payload).unwrap().0))
        }
        _ => None,
    }
}

#[tokio::test]
async fn node_answers_and_resumes_after_the_connection_drops() {
    let (_dir, path) = start().await;
    let mut session = Session::client(SessionId([7; 16]));

    let mut conn = open(&path).await;
    session.connect();
    session.send(dirs_request(1));
    let events = exchange(&mut conn, &mut session, 2).await;
    assert_eq!(events[0], Event::Connected { resumed: false });
    let (id, reply) = reply_of(&events[1]).unwrap();
    assert_eq!(id, 1);
    let Reply::Ok(value) = reply else {
        panic!("dirs failed: {reply:?}")
    };
    assert!(value["dirs"].is_array());

    // 请求发出后连接立刻断掉：回复留在节点的会话里，换一条连接续上后恰好收到一次。
    session.send(dirs_request(2));
    while let Some(bytes) = session.poll_transmit(std::time::Instant::now()) {
        conn.stream.write_all(&bytes).await.unwrap();
    }
    drop(conn);
    session.disconnected();
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut conn = open(&path).await;
    session.connect();
    let events = exchange(&mut conn, &mut session, 2).await;
    assert_eq!(events[0], Event::Connected { resumed: true });
    assert_eq!(reply_of(&events[1]).map(|(id, _)| id), Some(2));
    // 没有多余的重复回复。
    tokio::time::sleep(Duration::from_millis(200)).await;
    session.send(dirs_request(3));
    let events = exchange(&mut conn, &mut session, 1).await;
    assert_eq!(reply_of(&events[0]).map(|(id, _)| id), Some(3));
    assert_eq!(session.stats().duplicate_frames, 0);
}

#[tokio::test]
async fn node_reports_errors_and_rejects_other_protocol_versions() {
    let (_dir, path) = start().await;
    let mut session = Session::client(SessionId([8; 16]));
    let mut conn = open(&path).await;
    session.connect();
    // 项目外的路径不给读。
    let read = Request::PutBegin {
        path: "/etc/passwd".into(),
        size: 1,
        sha256: "0".repeat(64),
    };
    session.send(Outgoing::request(1, Priority::Normal, api::encode(&read, &[])));
    let events = exchange(&mut conn, &mut session, 2).await;
    let (_, reply) = reply_of(&events[1]).unwrap();
    assert!(
        matches!(&reply, Reply::Err(error) if error.kind == "forbidden"),
        "{reply:?}"
    );

    let mut stream = UnixStream::connect(&path).await.unwrap();
    let hello = Frame::Hello {
        version: PROTOCOL_VERSION + 1,
        session: SessionId([9; 16]),
        recv_seq: 0,
    };
    stream.write_all(&hello.encode()).await.unwrap();
    let mut decoder = Decoder::awaiting_handshake();
    let mut buf = vec![0; 4096];
    let frame = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(frame) = decoder.next_frame().unwrap() {
                return frame;
            }
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0, "closed without a reject");
            decoder.push(&buf[..n]);
        }
    })
    .await
    .unwrap();
    assert!(matches!(frame, Frame::Reject { .. }));
}
