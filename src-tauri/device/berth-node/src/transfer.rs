//! 文件传输：按偏移分块、断点续传、传完校验哈希（不用 rsync）。
//!
//! 一次上传 = `PutBegin`（对方回已收到的字节数，同一内容从断点续上）→ 依次 `PutChunk` → `PutFinish`。
//! 块是 [`crate::Priority::Bulk`]：只用空闲带宽；终端交互活跃时调用方用 [`crate::client::Client::yield_until`]
//! 让传输连接降速。失败（超时、断开太久）原样返回，再调一次即从对方已收到处继续，已确认的块不重发。
//! 取消 = drop 返回的 future（未完成的请求随之撤销）。
//!
//! 一次下载 = `GetBegin`（对方回大小与哈希）→ 依次 `GetChunk`，写到目标旁的 `.part`，校验后改名。

use std::fs::File;
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::api::{ApiError, Request};

/// 一块的大小：最差 30KB/s 下约 9 秒一块，进度够细，往返开销占比小。
/// ponytail: 一次只有一块在途，高延迟高带宽时用不满链路；要更快再按块流水。
pub const CHUNK: usize = 256 * 1024;
/// 单块请求的截止时间（含断线重连续上的余量）。
pub const CHUNK_DEADLINE: Duration = Duration::from_secs(120);

fn local(error: std::io::Error, path: &Path) -> ApiError {
    ApiError::new("unavailable", format!("{}: {error}", path.display()))
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|error| ApiError::new("internal", error.to_string()))?
}

/// 本机文件的大小与 sha256（十六进制）。
pub async fn digest(path: &Path) -> Result<(u64, String), ApiError> {
    let path = path.to_path_buf();
    blocking(move || {
        let mut file = File::open(&path).map_err(|error| local(error, &path))?;
        let mut hasher = Sha256::new();
        let size = std::io::copy(&mut file, &mut hasher).map_err(|error| local(error, &path))?;
        let hex = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok((size, hex))
    })
    .await
}

async fn read_chunk(path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, ApiError> {
    let path: PathBuf = path.to_path_buf();
    blocking(move || {
        let mut file = File::open(&path).map_err(|error| local(error, &path))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| local(error, &path))?;
        let mut buf = Vec::with_capacity(len);
        file.take(len as u64)
            .read_to_end(&mut buf)
            .map_err(|error| local(error, &path))?;
        Ok(buf)
    })
    .await
}

/// 把本机 `source` 传到对方的 `dest`（对方已注册项目之内的绝对路径）。
///
/// `send` 发一个请求并等回复（生产中即 `Client::request`）；`progress(已确认字节, 总字节)`
/// 在续传起点与每块确认后调用。成功返回对方落盘后的文件信息。
pub async fn upload<F, Fut>(
    source: &Path,
    dest: &str,
    mut send: F,
    mut progress: impl FnMut(u64, u64),
) -> Result<Value, ApiError>
where
    F: FnMut(Request, Vec<u8>) -> Fut,
    Fut: Future<Output = Result<(Value, Vec<u8>), ApiError>>,
{
    let (size, sha256) = digest(source).await?;
    let offset_of = |reply: &Value| reply["offset"].as_u64();
    let (begun, _) = send(
        Request::PutBegin {
            path: dest.to_owned(),
            size,
            sha256: sha256.clone(),
        },
        Vec::new(),
    )
    .await?;
    let mut offset =
        offset_of(&begun).ok_or_else(|| ApiError::new("invalid", "PutBegin returned no offset"))?;
    progress(offset, size);
    while offset < size {
        let chunk = read_chunk(source, offset, CHUNK).await?;
        if chunk.is_empty() {
            return Err(ApiError::new("invalid", "source file shrank during upload"));
        }
        let request = Request::PutChunk {
            path: dest.to_owned(),
            sha256: sha256.clone(),
            offset,
        };
        offset = match send(request, chunk).await {
            Ok((reply, _)) => offset_of(&reply)
                .ok_or_else(|| ApiError::new("invalid", "PutChunk returned no offset"))?,
            // 对方收到的与我们以为的不一致（如上一块的回复丢了）：按对方的续。
            Err(error) => match error.detail.as_ref().and_then(offset_of) {
                Some(have) => have,
                None => return Err(error),
            },
        };
        progress(offset.min(size), size);
    }
    let (stat, _) = send(
        Request::PutFinish {
            path: dest.to_owned(),
            sha256,
        },
        Vec::new(),
    )
    .await?;
    Ok(stat)
}

async fn append(path: &Path, bytes: Vec<u8>) -> Result<(), ApiError> {
    let path = path.to_path_buf();
    blocking(move || {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|error| local(error, &path))
    })
    .await
}

/// 把对方的 `source` 拉到本机 `dest`：`dest` 内容已相同直接用，否则校验后替换。
/// 同一内容中断后再调一次，从 `.part` 已有的字节续上。
pub async fn download<F, Fut>(
    source: &str,
    dest: &Path,
    mut send: F,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), ApiError>
where
    F: FnMut(Request, Vec<u8>) -> Fut,
    Fut: Future<Output = Result<(Value, Vec<u8>), ApiError>>,
{
    let (info, _) = send(
        Request::GetBegin {
            path: source.to_owned(),
        },
        Vec::new(),
    )
    .await?;
    let (Some(size), Some(sha256)) = (info["size"].as_u64(), info["sha256"].as_str()) else {
        return Err(ApiError::new(
            "invalid",
            "GetBegin returned no size or sha256",
        ));
    };
    // 哈希来自对方且要进文件名：先确认只是十六进制。
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::new("invalid", "sha256 must be 64 hex digits"));
    }
    if digest(dest)
        .await
        .is_ok_and(|(_, have)| have.eq_ignore_ascii_case(sha256))
    {
        progress(size, size);
        return Ok(());
    }
    let part = dest.with_file_name(format!(".{}.berth-part", &sha256[..16]));
    let mut offset = std::fs::metadata(&part).map_or(0, |meta| meta.len());
    if offset > size {
        std::fs::remove_file(&part).map_err(|error| local(error, &part))?;
        offset = 0;
    }
    // 空文件没有块：也要有 `.part` 可改名。
    append(&part, Vec::new()).await?;
    progress(offset, size);
    while offset < size {
        let request = Request::GetChunk {
            path: source.to_owned(),
            offset,
            len: CHUNK as u64,
        };
        let (_, chunk) = send(request, Vec::new()).await?;
        if chunk.is_empty() {
            return Err(ApiError::new(
                "invalid",
                "source file shrank during download",
            ));
        }
        offset += chunk.len() as u64;
        append(&part, chunk).await?;
        progress(offset.min(size), size);
    }
    let (_, actual) = digest(&part).await?;
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = std::fs::remove_file(&part);
        return Err(ApiError::new(
            "invalid",
            "content hash mismatch; download restarts",
        ));
    }
    std::fs::rename(&part, dest).map_err(|error| local(error, dest))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;

    /// 内存里的对方：与 `berth node` 的 put 规则一致（同一内容续传、偏移必须对齐、收齐校验哈希）。
    #[derive(Default)]
    struct Peer {
        part: Vec<u8>,
        sha256: String,
        done: Option<Vec<u8>>,
        /// 收到的块字节数（验证已确认的不重发）。
        received: usize,
        /// 第几块（从 1 数）失败一次。
        fail_chunk: Option<usize>,
        chunks: usize,
    }

    type Sent = std::future::Ready<Result<(Value, Vec<u8>), ApiError>>;

    fn send(peer: &Arc<Mutex<Peer>>) -> impl FnMut(Request, Vec<u8>) -> Sent {
        let peer = peer.clone();
        move |request, body| {
            let mut peer = peer.lock().unwrap();
            let reply = match request {
                Request::PutBegin { sha256, .. } => {
                    if peer.sha256 != sha256 {
                        peer.part.clear();
                        peer.sha256 = sha256;
                    }
                    Ok(json!({ "offset": peer.part.len() }))
                }
                Request::PutChunk { offset, .. } => {
                    peer.chunks += 1;
                    if peer.fail_chunk == Some(peer.chunks) {
                        peer.fail_chunk = None;
                        Err(ApiError::new("timeout", "request timed out"))
                    } else if offset != peer.part.len() as u64 {
                        Err(ApiError {
                            detail: Some(json!({ "offset": peer.part.len() })),
                            ..ApiError::new("invalid", "offset mismatch")
                        })
                    } else {
                        peer.received += body.len();
                        peer.part.extend_from_slice(&body);
                        Ok(json!({ "offset": peer.part.len() }))
                    }
                }
                Request::PutFinish { sha256, .. } => {
                    let hex: String = Sha256::digest(&peer.part)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    if hex == sha256 {
                        peer.done = Some(std::mem::take(&mut peer.part));
                        Ok(json!({ "dir": false }))
                    } else {
                        Err(ApiError::new("conflict", "hash mismatch"))
                    }
                }
                other => Err(ApiError::new("invalid", format!("{other:?}"))),
            };
            std::future::ready(reply.map(|value| (value, Vec::new())))
        }
    }

    /// 测试用源文件（`name` 各测试不同，并行不冲突）。
    fn source(name: &str, len: usize) -> (PathBuf, Vec<u8>) {
        let path =
            std::env::temp_dir().join(format!("berth-transfer-{}-{name}", std::process::id()));
        let bytes: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        (path, bytes)
    }

    #[tokio::test]
    async fn uploads_in_chunks_with_progress_and_hash_check() {
        let (path, bytes) = source("chunks", CHUNK * 2 + 100);
        let peer = Arc::new(Mutex::new(Peer::default()));
        let mut seen = Vec::new();
        upload(&path, "/p/dest.bin", send(&peer), |done, total| {
            seen.push((done, total))
        })
        .await
        .unwrap();
        let total = bytes.len() as u64;
        assert_eq!(
            seen,
            [
                (0, total),
                (CHUNK as u64, total),
                (2 * CHUNK as u64, total),
                (total, total)
            ]
        );
        assert_eq!(peer.lock().unwrap().done.as_deref(), Some(&bytes[..]));
    }

    #[tokio::test]
    async fn resumes_after_a_failure_without_resending_acknowledged_bytes() {
        let (path, bytes) = source("resume", CHUNK * 3);
        let peer = Arc::new(Mutex::new(Peer {
            fail_chunk: Some(2),
            ..Peer::default()
        }));
        let error = upload(&path, "/p/dest.bin", send(&peer), |_, _| {})
            .await
            .unwrap_err();
        assert_eq!(error.kind, "timeout");
        assert_eq!(peer.lock().unwrap().part.len(), CHUNK);

        let mut first = None;
        upload(&path, "/p/dest.bin", send(&peer), |done, _| {
            first.get_or_insert(done);
        })
        .await
        .unwrap();
        assert_eq!(first, Some(CHUNK as u64));
        let peer = peer.lock().unwrap();
        assert_eq!(peer.received, bytes.len());
        assert_eq!(peer.done.as_deref(), Some(&bytes[..]));
    }

    #[tokio::test]
    async fn follows_the_peer_offset_when_a_reply_was_lost() {
        let (path, bytes) = source("lost", CHUNK * 2);
        let peer = Arc::new(Mutex::new(Peer::default()));
        let mut inner = send(&peer);
        let mut lost = false;
        // 第一块写进去了但回复丢了：客户端重发同一偏移，对方报不一致并给出已收到的偏移。
        let lossy = move |request: Request, body: Vec<u8>| {
            let resend = matches!(request, Request::PutChunk { offset: 0, .. }) && !lost;
            if resend {
                // 这一次的回复丢掉（块已经写进去了）。
                lost = true;
                drop(inner(request.clone(), body.clone()));
            }
            inner(request, body)
        };
        upload(&path, "/p/dest.bin", lossy, |_, _| {})
            .await
            .unwrap();
        let peer = peer.lock().unwrap();
        assert_eq!(peer.received, bytes.len());
        assert_eq!(peer.done.as_deref(), Some(&bytes[..]));
    }

    /// 内存里的对方（下载）：`fail_chunk` 第几块失败一次，记下读过的偏移。
    fn serve(
        bytes: Vec<u8>,
        fail_chunk: Option<usize>,
        offsets: Arc<Mutex<Vec<u64>>>,
    ) -> impl FnMut(Request, Vec<u8>) -> Sent {
        let mut chunks = 0;
        let mut fail_chunk = fail_chunk;
        move |request, _| {
            let reply = match request {
                Request::GetBegin { .. } => {
                    let hex: String = Sha256::digest(&bytes)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    Ok((json!({ "size": bytes.len(), "sha256": hex }), Vec::new()))
                }
                Request::GetChunk { offset, len, .. } => {
                    chunks += 1;
                    if fail_chunk == Some(chunks) {
                        fail_chunk = None;
                        Err(ApiError::new("timeout", "request timed out"))
                    } else {
                        offsets.lock().unwrap().push(offset);
                        let start = (offset as usize).min(bytes.len());
                        let end = (start + len as usize).min(bytes.len());
                        Ok((Value::Null, bytes[start..end].to_vec()))
                    }
                }
                other => Err(ApiError::new("invalid", format!("{other:?}"))),
            };
            std::future::ready(reply)
        }
    }

    fn dest_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("berth-pull-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn download_resumes_after_a_failure_and_replaces_stale_dest() {
        let bytes: Vec<u8> = (0..CHUNK * 2 + 100).map(|i| (i * 7 % 251) as u8).collect();
        let dir = dest_dir("resume");
        let dest = dir.join("out.bin");
        std::fs::write(&dest, b"stale").unwrap();
        let offsets = Arc::new(Mutex::new(Vec::new()));
        let error = download(
            "/p/a.bin",
            &dest,
            serve(bytes.clone(), Some(2), offsets.clone()),
            |_, _| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "timeout");
        assert_eq!(std::fs::read(&dest).unwrap(), b"stale");

        download(
            "/p/a.bin",
            &dest,
            serve(bytes.clone(), None, offsets.clone()),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
        // 第一块没有重取；只剩目标文件，`.part` 已改名。
        assert_eq!(
            *offsets.lock().unwrap(),
            [0, CHUNK as u64, 2 * CHUNK as u64]
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);

        // 内容相同：不再取块。
        offsets.lock().unwrap().clear();
        download(
            "/p/a.bin",
            &dest,
            serve(bytes, None, offsets.clone()),
            |_, _| {},
        )
        .await
        .unwrap();
        assert!(offsets.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn download_rejects_a_bad_hash_and_handles_empty_files() {
        let dir = dest_dir("hash");
        let dest = dir.join("empty");
        let offsets = Arc::new(Mutex::new(Vec::new()));
        download("/p/e", &dest, serve(Vec::new(), None, offsets), |_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"");

        let lying = |request, _: Vec<u8>| {
            std::future::ready(match request {
                Request::GetBegin { .. } => {
                    Ok((json!({ "size": 3, "sha256": "../../evil" }), Vec::new()))
                }
                _ => Ok((Value::Null, b"abc".to_vec())),
            })
        };
        let error = download("/p/x", &dir.join("x"), lying, |_, _| {})
            .await
            .unwrap_err();
        assert_eq!(error.kind, "invalid");

        let wrong = |request, _: Vec<u8>| {
            std::future::ready(match request {
                Request::GetBegin { .. } => {
                    Ok((json!({ "size": 3, "sha256": "0".repeat(64) }), Vec::new()))
                }
                _ => Ok((Value::Null, b"abc".to_vec())),
            })
        };
        let error = download("/p/y", &dir.join("y"), wrong, |_, _| {})
            .await
            .unwrap_err();
        assert_eq!(error.kind, "invalid");
        assert!(!dir.join("y").exists());
    }
}
