//! 节点的文件读写与接收传输：只碰已注册项目根之内的路径（符号链接解析后判断）。

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use berth_node::api::{self, ApiError, Entry, Listing, ReadHead, Stat};
use sha2::{Digest, Sha256};

/// 判断二进制看开头多少字节。
const SNIFF: usize = 8 * 1024;

fn io_error(path: &Path, error: std::io::Error) -> ApiError {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => "not_found",
        std::io::ErrorKind::PermissionDenied => "forbidden",
        _ => "internal",
    };
    ApiError::new(kind, format!("{}: {error}", path.display()))
}

/// 已注册项目根（规范化后）。
pub(crate) struct Scope {
    roots: Vec<PathBuf>,
}

impl Scope {
    pub(crate) fn new(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        Self {
            roots: roots
                .into_iter()
                .filter_map(|root| fs::canonicalize(root).ok())
                .collect(),
        }
    }

    /// 解析路径并确认在某个项目根之内；`may_create` 时允许最后一级还不存在。
    pub(crate) fn resolve(&self, path: &str, may_create: bool) -> Result<PathBuf, ApiError> {
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err(ApiError::new("invalid", "path must be absolute"));
        }
        let resolved = match fs::canonicalize(path) {
            Ok(resolved) => resolved,
            Err(error) if may_create && error.kind() == std::io::ErrorKind::NotFound => {
                let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                    return Err(ApiError::new("invalid", "path has no parent"));
                };
                fs::canonicalize(parent)
                    .map_err(|error| io_error(parent, error))?
                    .join(name)
            }
            Err(error) => return Err(io_error(path, error)),
        };
        if self.roots.iter().any(|root| resolved.starts_with(root)) {
            Ok(resolved)
        } else {
            Err(ApiError::new(
                "forbidden",
                format!("{} is outside the registered projects", path.display()),
            ))
        }
    }
}

fn file_version(meta: &fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{mtime:x}-{:x}", meta.len())
}

fn entries(dir: &Path) -> Result<Vec<Entry>, ApiError> {
    let mut entries: Vec<Entry> = fs::read_dir(dir)
        .map_err(|error| io_error(dir, error))?
        .filter_map(Result::ok)
        .filter_map(|item| {
            // 指向目录的符号链接按目录显示；断链跳过。
            let meta = fs::metadata(item.path()).ok()?;
            Some(Entry {
                name: item.file_name().to_string_lossy().into_owned(),
                dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
            })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

fn listing_version(entries: &[Entry], dir: &Path) -> String {
    let mut hasher = Sha256::new();
    for entry in entries {
        hasher.update(entry.name.as_bytes());
        hasher.update([0, entry.dir as u8]);
        hasher.update(entry.size.to_le_bytes());
        // 同大小改写也要变：带上修改时间。
        if let Ok(meta) = fs::metadata(dir.join(&entry.name)) {
            hasher.update(file_version(&meta).as_bytes());
        }
    }
    hex(&hasher.finalize()[..12])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn stat(scope: &Scope, path: &str) -> Result<Stat, ApiError> {
    let path = scope.resolve(path, false)?;
    let meta = fs::metadata(&path).map_err(|error| io_error(&path, error))?;
    if meta.is_dir() {
        let entries = entries(&path)?;
        return Ok(Stat {
            dir: true,
            size: 0,
            version: listing_version(&entries, &path),
        });
    }
    Ok(Stat {
        dir: false,
        size: meta.len(),
        version: file_version(&meta),
    })
}

pub(crate) fn list(scope: &Scope, path: &str, version: Option<&str>) -> Result<Listing, ApiError> {
    let path = scope.resolve(path, false)?;
    let entries = entries(&path)?;
    let current = listing_version(&entries, &path);
    let unchanged = version == Some(current.as_str());
    Ok(Listing {
        version: current,
        unchanged,
        entries: if unchanged { Vec::new() } else { entries },
    })
}

pub(crate) fn read(
    scope: &Scope,
    path: &str,
    offset: u64,
    len: u64,
) -> Result<(ReadHead, Vec<u8>), ApiError> {
    let path = scope.resolve(path, false)?;
    let mut file = fs::File::open(&path).map_err(|error| io_error(&path, error))?;
    let meta = file.metadata().map_err(|error| io_error(&path, error))?;
    if meta.is_dir() {
        return Err(ApiError::new("invalid", "path is a directory"));
    }
    let mut sniff = vec![0; SNIFF.min(meta.len() as usize)];
    file.read_exact(&mut sniff)
        .map_err(|error| io_error(&path, error))?;
    let binary = sniff.contains(&0);
    let len = len.min(api::MAX_READ).min(meta.len().saturating_sub(offset));
    let mut body = vec![0; len as usize];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut body))
        .map_err(|error| io_error(&path, error))?;
    Ok((
        ReadHead {
            size: meta.len(),
            version: file_version(&meta),
            binary,
        },
        body,
    ))
}

/// 先写同目录临时文件再改名：中途失败不留半个文件；保留原文件权限。
fn replace(path: &Path, content: &[u8]) -> Result<(), ApiError> {
    let tmp = path.with_file_name(format!(
        ".{}.berth-write",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content)?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, path)
    };
    write().map_err(|error| {
        let _ = fs::remove_file(&tmp);
        io_error(path, error)
    })
}

fn conflict(current: Option<String>) -> ApiError {
    ApiError {
        detail: Some(serde_json::json!({ "version": current })),
        ..ApiError::new("conflict", "the file changed on the device since it was read")
    }
}

/// `version` 与磁盘不一致时报冲突、不覆盖；`None` 表示新建。
pub(crate) fn write(
    scope: &Scope,
    path: &str,
    version: Option<&str>,
    content: &[u8],
) -> Result<Stat, ApiError> {
    let path = scope.resolve(path, true)?;
    let current = fs::metadata(&path).ok().map(|meta| file_version(&meta));
    if current.as_deref() != version {
        return Err(conflict(current));
    }
    replace(&path, content)?;
    let meta = fs::metadata(&path).map_err(|error| io_error(&path, error))?;
    Ok(Stat {
        dir: false,
        size: meta.len(),
        version: file_version(&meta),
    })
}

fn sha256_file(path: &Path) -> Result<String, ApiError> {
    let mut file = fs::File::open(path).map_err(|error| io_error(path, error))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| io_error(path, error))?;
    Ok(hex(&hasher.finalize()))
}

pub(crate) fn hash(scope: &Scope, path: &str) -> Result<String, ApiError> {
    sha256_file(&scope.resolve(path, false)?)
}

/// 未完成的上传：同目录隐藏文件，按内容哈希命名，同一内容才续传。
fn part_path(dest: &Path, sha256: &str) -> Result<PathBuf, ApiError> {
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::new("invalid", "sha256 must be 64 hex digits"));
    }
    Ok(dest.with_file_name(format!(
        ".{}.{}.berth-part",
        dest.file_name().unwrap_or_default().to_string_lossy(),
        &sha256[..16]
    )))
}

fn part_len(part: &Path) -> u64 {
    fs::metadata(part).map_or(0, |meta| meta.len())
}

/// 返回已收到的字节数（断点）。目标已存在时拒绝：不静默覆盖对方的文件。
pub(crate) fn put_begin(scope: &Scope, path: &str, size: u64, sha256: &str) -> Result<u64, ApiError> {
    let dest = scope.resolve(path, true)?;
    if dest.exists() {
        return Err(ApiError::new("conflict", format!("{} already exists", dest.display())));
    }
    let part = part_path(&dest, sha256)?;
    let have = part_len(&part);
    if have > size {
        fs::remove_file(&part).map_err(|error| io_error(&part, error))?;
        return Ok(0);
    }
    Ok(have)
}

/// 追加一块；`offset` 必须等于已收到的字节数（重复的块按已收到处理，不重写）。
pub(crate) fn put_chunk(
    scope: &Scope,
    path: &str,
    sha256: &str,
    offset: u64,
    bytes: &[u8],
) -> Result<u64, ApiError> {
    let dest = scope.resolve(path, true)?;
    let part = part_path(&dest, sha256)?;
    let have = part_len(&part);
    if offset + bytes.len() as u64 <= have {
        return Ok(have);
    }
    if offset != have {
        return Err(ApiError {
            detail: Some(serde_json::json!({ "offset": have })),
            ..ApiError::new("invalid", format!("expected offset {have}, got {offset}"))
        });
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part)
        .map_err(|error| io_error(&part, error))?;
    file.write_all(bytes).map_err(|error| io_error(&part, error))?;
    Ok(have + bytes.len() as u64)
}

/// 校验哈希后改名为目标；哈希不对删掉重来。
pub(crate) fn put_finish(scope: &Scope, path: &str, sha256: &str) -> Result<Stat, ApiError> {
    let dest = scope.resolve(path, true)?;
    let part = part_path(&dest, sha256)?;
    let actual = sha256_file(&part)?;
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = fs::remove_file(&part);
        return Err(ApiError::new("invalid", "content hash mismatch; upload restarts"));
    }
    if dest.exists() {
        return Err(ApiError::new("conflict", format!("{} already exists", dest.display())));
    }
    fs::rename(&part, &dest).map_err(|error| io_error(&dest, error))?;
    let meta = fs::metadata(&dest).map_err(|error| io_error(&dest, error))?;
    Ok(Stat {
        dir: false,
        size: meta.len(),
        version: file_version(&meta),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> (tempfile::TempDir, Scope, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir(&root).unwrap();
        let scope = Scope::new([root.clone()]);
        let root = fs::canonicalize(root).unwrap().display().to_string();
        (dir, scope, root)
    }

    #[test]
    fn paths_outside_projects_are_refused() {
        let (dir, scope, root) = scope();
        fs::write(dir.path().join("secret"), "x").unwrap();
        let outside = dir.path().join("secret").display().to_string();
        assert_eq!(scope.resolve(&outside, false).unwrap_err().kind, "forbidden");
        let escape = format!("{root}/../secret");
        assert_eq!(scope.resolve(&escape, false).unwrap_err().kind, "forbidden");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret"), format!("{root}/link")).unwrap();
            assert_eq!(scope.resolve(&format!("{root}/link"), false).unwrap_err().kind, "forbidden");
        }
        assert_eq!(scope.resolve("relative", false).unwrap_err().kind, "invalid");
    }

    #[test]
    fn listing_returns_only_changes_by_version() {
        let (_dir, scope, root) = scope();
        fs::write(format!("{root}/a.txt"), "a").unwrap();
        fs::create_dir(format!("{root}/src")).unwrap();
        let first = list(&scope, &root, None).unwrap();
        assert_eq!(
            first.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["src", "a.txt"]
        );
        let again = list(&scope, &root, Some(&first.version)).unwrap();
        assert!(again.unchanged && again.entries.is_empty());
        fs::write(format!("{root}/b.txt"), "b").unwrap();
        let changed = list(&scope, &root, Some(&first.version)).unwrap();
        assert!(!changed.unchanged);
        assert_eq!(changed.entries.len(), 3);
    }

    #[test]
    fn read_first_screen_then_continue() {
        let (_dir, scope, root) = scope();
        let path = format!("{root}/big.txt");
        let content: Vec<u8> = (0..100_000u32).map(|i| b'a' + (i % 26) as u8).collect();
        fs::write(&path, &content).unwrap();
        let (head, first) = read(&scope, &path, 0, api::FIRST_SCREEN).unwrap();
        assert_eq!(head.size, content.len() as u64);
        assert!(!head.binary);
        assert_eq!(first, content[..api::FIRST_SCREEN as usize]);
        let (_, rest) = read(&scope, &path, api::FIRST_SCREEN, api::MAX_READ).unwrap();
        assert_eq!(rest, content[api::FIRST_SCREEN as usize..]);
        fs::write(format!("{root}/bin"), [0u8, 1, 2]).unwrap();
        assert!(read(&scope, &format!("{root}/bin"), 0, 3).unwrap().0.binary);
    }

    #[test]
    fn write_refuses_to_overwrite_concurrent_change() {
        let (_dir, scope, root) = scope();
        let path = format!("{root}/notes.md");
        let created = write(&scope, &path, None, b"v1").unwrap();
        assert_eq!(write(&scope, &path, None, b"again").unwrap_err().kind, "conflict");
        let (head, _) = read(&scope, &path, 0, 10).unwrap();
        assert_eq!(head.version, created.version);
        // 对方在我们读之后改过。
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(&path, "theirs, longer").unwrap();
        let error = write(&scope, &path, Some(&head.version), b"mine").unwrap_err();
        assert_eq!(error.kind, "conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "theirs, longer");
        let (fresh, _) = read(&scope, &path, 0, 100).unwrap();
        write(&scope, &path, Some(&fresh.version), b"mine").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    }

    #[test]
    fn upload_resumes_from_received_bytes_and_checks_hash() {
        let (_dir, scope, root) = scope();
        let dest = format!("{root}/drop.bin");
        let content: Vec<u8> = (0..10_000u32).map(|i| (i * 7) as u8).collect();
        let sha = hex(&Sha256::digest(&content));
        assert_eq!(put_begin(&scope, &dest, content.len() as u64, &sha).unwrap(), 0);
        put_chunk(&scope, &dest, &sha, 0, &content[..4000]).unwrap();
        // 断线后重来：从 4000 续上，重复的块不重写。
        assert_eq!(put_begin(&scope, &dest, content.len() as u64, &sha).unwrap(), 4000);
        assert_eq!(put_chunk(&scope, &dest, &sha, 0, &content[..4000]).unwrap(), 4000);
        assert_eq!(
            put_chunk(&scope, &dest, &sha, 6000, &content[6000..]).unwrap_err().kind,
            "invalid"
        );
        put_chunk(&scope, &dest, &sha, 4000, &content[4000..]).unwrap();
        put_finish(&scope, &dest, &sha).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), content);
        assert_eq!(hash(&scope, &dest).unwrap(), sha);
        assert_eq!(put_begin(&scope, &dest, 1, &sha).unwrap_err().kind, "conflict");

        let other = format!("{root}/bad.bin");
        let wrong = hex(&Sha256::digest(b"something else"));
        put_begin(&scope, &other, 3, &wrong).unwrap();
        put_chunk(&scope, &other, &wrong, 0, b"abc").unwrap();
        assert_eq!(put_finish(&scope, &other, &wrong).unwrap_err().kind, "invalid");
        assert!(!Path::new(&other).exists());
    }
}
