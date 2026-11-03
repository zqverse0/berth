//! 客户端连接的保证：请求有回复、断线自动续上且回复恰好一次、15 秒内发现失联、截止时间、拒绝后不重连。
//! 时间用 tokio 的暂停时钟，退避与心跳不真等。

use std::sync::atomic::AtomicUsize;

use serde_json::json;
use tokio::io::DuplexStream;

use super::*;
use crate::Frame;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// 照常回复。
    Normal,
    /// 收到请求后、回复写出前断开字节流（回复留在会话里等续传）。
    DropBeforeReply,
    /// 不读不写，字节流保持打开（对方卡死 / 休眠）。
    Stall,
    /// 只确认、不回复。
    Silent,
}

#[derive(Default)]
struct Seen {
    /// 节点处理过的请求 id（验证恰好一次）。
    requests: Vec<u64>,
    links: usize,
}

/// 测试节点：跨字节流保留同一个服务端会话。
fn node(mode: Arc<Mutex<Mode>>, seen: Arc<Mutex<Seen>>) -> Connector {
    let (links, mut incoming) = unbounded_channel::<DuplexStream>();
    let task_seen = seen.clone();
    tokio::spawn(async move {
        let seen = task_seen;
        let mut session = Session::server();
        let mut link: Option<DuplexStream> = None;
        let mut decoder = Decoder::synced();
        let mut buf = vec![0; 64 * 1024];
        loop {
            let current = *mode.lock().unwrap();
            if current != Mode::Stall {
                while let Some(event) = session.poll_event() {
                    let Event::Message(message) = event else {
                        continue;
                    };
                    if message.reply {
                        continue;
                    }
                    seen.lock().unwrap().requests.push(message.id);
                    if current == Mode::Silent {
                        continue;
                    }
                    let payload = api::encode(&Reply::Ok(json!({ "id": message.id })), b"body");
                    session.send(Outgoing::reply(message.id, message.priority, payload));
                    if current == Mode::DropBeforeReply {
                        link = None;
                        session.disconnected();
                        *mode.lock().unwrap() = Mode::Normal;
                    }
                }
                if let Some(stream) = link.as_mut() {
                    while let Some(bytes) = session.poll_transmit(now()) {
                        if stream.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let reading = async {
                match link.as_mut() {
                    Some(stream) if current != Mode::Stall => stream.read(&mut buf).await,
                    _ => std::future::pending().await,
                }
            };
            tokio::select! {
                stream = incoming.recv() => {
                    let Some(stream) = stream else { return };
                    *mode.lock().unwrap() = match current { Mode::Stall => Mode::Normal, other => other };
                    seen.lock().unwrap().links += 1;
                    session.disconnected();
                    link = Some(stream);
                    decoder = Decoder::synced();
                }
                read = reading => match read {
                    Ok(n) if n > 0 => {
                        decoder.push(&buf[..n]);
                        while let Ok(Some(frame)) = decoder.next_frame() {
                            let _ = session.handle(now(), frame);
                        }
                    }
                    _ => {
                        link = None;
                        session.disconnected();
                    }
                },
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        }
    });
    Box::new(move || {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let sent = links.send(theirs);
        Box::pin(async move {
            sent.map_err(|_| io::Error::other("node gone"))?;
            let (reader, writer) = tokio::io::split(ours);
            Ok(Link {
                reader: Box::new(reader),
                writer: Box::new(writer),
                reason: None,
                guard: None,
            })
        })
    })
}

fn setup(mode: Mode) -> (Client, Arc<Mutex<Mode>>, Arc<Mutex<Seen>>) {
    let mode = Arc::new(Mutex::new(mode));
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (client, _pushes) = Client::start(node(mode.clone(), seen.clone()));
    (client, mode, seen)
}

fn dirs() -> Request {
    Request::Dirs { path: None }
}

async fn wait_for(client: &Client, wanted: impl Fn(&Status) -> bool) -> Status {
    let mut status = client.status();
    let found = status
        .wait_for(|status| wanted(status))
        .await
        .unwrap()
        .clone();
    found
}

#[tokio::test(start_paused = true)]
async fn request_gets_its_reply() {
    let (client, _, _) = setup(Mode::Normal);
    let (value, body) = client
        .request(&dirs(), &[], Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(value["id"], 1);
    assert_eq!(body, b"body");
    assert_eq!(*client.status().borrow(), Status::Online);
}

#[tokio::test(start_paused = true)]
async fn link_drop_reconnects_and_delivers_the_reply_exactly_once() {
    let (client, _, seen) = setup(Mode::DropBeforeReply);
    let (value, _) = client
        .request(&dirs(), &[], Duration::from_secs(60))
        .await
        .unwrap();
    assert_eq!(value["id"], 1);
    let (value, _) = client
        .request(&dirs(), &[], Duration::from_secs(60))
        .await
        .unwrap();
    assert_eq!(value["id"], 2);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.requests, [1, 2], "each request handled exactly once");
    assert_eq!(seen.links, 2, "one reconnect");
}

#[tokio::test(start_paused = true)]
async fn a_stalled_node_is_noticed_within_15_seconds_and_reconnected() {
    let (client, mode, seen) = setup(Mode::Normal);
    client
        .request(&dirs(), &[], Duration::from_secs(10))
        .await
        .unwrap();
    *mode.lock().unwrap() = Mode::Stall;
    let stalled = Instant::now();
    let status = wait_for(&client, |s| matches!(s, Status::Offline { .. })).await;
    assert!(
        stalled.elapsed() <= Duration::from_secs(15),
        "noticed after {:?}",
        stalled.elapsed()
    );
    assert!(matches!(status, Status::Offline { attempt: 1, .. }));
    wait_for(&client, |s| *s == Status::Online).await;
    assert_eq!(seen.lock().unwrap().links, 2);
    client
        .request(&dirs(), &[], Duration::from_secs(10))
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn requests_fail_at_their_deadline() {
    let (client, _, seen) = setup(Mode::Silent);
    let started = Instant::now();
    let error = client
        .request(&dirs(), &[], Duration::from_secs(3))
        .await
        .unwrap_err();
    assert_eq!(error.kind, "timeout");
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(seen.lock().unwrap().requests, [1]);
}

#[tokio::test(start_paused = true)]
async fn requests_queue_while_offline_and_go_out_after_reconnect() {
    let connects = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(Mutex::new(Mode::Normal));
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mut inner = node(mode, seen.clone());
    let counter = connects.clone();
    // 前两次连不上。
    let connector: Connector = Box::new(move || {
        if counter.fetch_add(1, Ordering::Relaxed) < 2 {
            return Box::pin(async { Err(io::Error::other("unreachable")) });
        }
        inner()
    });
    let (client, _pushes) = Client::start(connector);
    let (value, _) = client
        .request(&dirs(), &[], Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(value["id"], 1);
    assert_eq!(connects.load(Ordering::Relaxed), 3);
}

#[tokio::test(start_paused = true)]
async fn a_rejecting_node_is_not_retried_until_asked() {
    let connects = Arc::new(AtomicUsize::new(0));
    let counter = connects.clone();
    let connector: Connector = Box::new(move || {
        counter.fetch_add(1, Ordering::Relaxed);
        Box::pin(async {
            let (ours, mut theirs) = tokio::io::duplex(4096);
            let reject = Frame::Reject {
                version: crate::PROTOCOL_VERSION + 1,
                reason: "protocol version mismatch".into(),
            };
            theirs.write_all(&reject.encode()).await?;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                drop(theirs);
            });
            let (reader, writer) = tokio::io::split(ours);
            Ok(Link {
                reader: Box::new(reader),
                writer: Box::new(writer),
                reason: None,
                guard: None,
            })
        })
    });
    let (client, _pushes) = Client::start(connector);
    let status = wait_for(&client, |s| matches!(s, Status::Failed { .. })).await;
    assert!(matches!(status, Status::Failed { error } if error.contains("mismatch")));
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(connects.load(Ordering::Relaxed), 1);
    client.retry();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(connects.load(Ordering::Relaxed), 2);
    assert!(matches!(*client.status().borrow(), Status::Failed { .. }));
}

#[test]
fn probe_finds_berth_outside_path_and_node_command_quotes_it() {
    let home = std::env::temp_dir().join(format!("berth-probe-{}", std::process::id()));
    let bin = home.join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let berth = bin.join("berth");
    std::fs::write(&berth, "#!/bin/sh\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&berth, std::fs::Permissions::from_mode(0o755)).unwrap();
    let out = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(probe_command(None))
        .env("HOME", &home)
        .env("PATH", "/bin:/usr/bin")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        berth.to_string_lossy()
    );
    // 上次记下的路径仍可执行就沿用；失效了回到常规候选。
    let pinned = home.join("other berth");
    std::fs::write(&pinned, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&pinned, std::fs::Permissions::from_mode(0o755)).unwrap();
    let probe = |preferred: &std::path::Path| {
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(probe_command(Some(&preferred.to_string_lossy())))
            .env("HOME", &home)
            .env("PATH", "/bin:/usr/bin")
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    assert_eq!(probe(&pinned), pinned.to_string_lossy());
    assert_eq!(probe(&home.join("gone")), berth.to_string_lossy());
    std::fs::remove_dir_all(&home).unwrap();
    assert_eq!(node_command("/a b/it's"), r"'/a b/it'\''s' node stdio");
}
