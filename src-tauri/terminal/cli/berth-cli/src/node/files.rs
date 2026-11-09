//! 节点的文件传输（收与发）：只碰已注册项目根之内的路径（符号链接解析后判断）。

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use berth_node::api::ApiError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_file(path: &Path) -> Result<String, ApiError> {
    let mut file = fs::File::open(path).map_err(|error| io_error(path, error))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| io_error(path, error))?;
    Ok(hex(&hasher.finalize()))
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
pub(crate) fn put_finish(scope: &Scope, path: &str, sha256: &str) -> Result<Value, ApiError> {
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
    Ok(json!({ "dir": false, "size": meta.len(), "version": file_version(&meta) }))
}

/// 下载开始：文件的大小与哈希。
pub(crate) fn get_begin(scope: &Scope, path: &str) -> Result<Value, ApiError> {
    let source = scope.resolve(path, false)?;
    let meta = fs::metadata(&source).map_err(|error| io_error(&source, error))?;
    if !meta.is_file() {
        return Err(ApiError::new("invalid", format!("{} is not a file", source.display())));
    }
    Ok(json!({ "size": meta.len(), "sha256": sha256_file(&source)? }))
}

/// 读一块，到文件尾为空。
pub(crate) fn get_chunk(scope: &Scope, path: &str, offset: u64, len: u64) -> Result<Vec<u8>, ApiError> {
    let source = scope.resolve(path, false)?;
    let mut file = fs::File::open(&source).map_err(|error| io_error(&source, error))?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| io_error(&source, error))?;
    let mut bytes = Vec::new();
    file.take(len)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(&source, error))?;
    Ok(bytes)
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
    fn download_reads_chunks_inside_projects_only() {
        let (dir, scope, root) = scope();
        let file = format!("{root}/a.bin");
        fs::write(&file, b"hello world").unwrap();
        let info = get_begin(&scope, &file).unwrap();
        assert_eq!(info["size"], 11);
        assert_eq!(info["sha256"], hex(&Sha256::digest(b"hello world")));
        assert_eq!(get_chunk(&scope, &file, 6, 100).unwrap(), b"world");
        assert_eq!(get_chunk(&scope, &file, 11, 100).unwrap(), b"");
        assert_eq!(get_begin(&scope, &root).unwrap_err().kind, "invalid");

        fs::write(dir.path().join("secret"), "x").unwrap();
        let outside = dir.path().join("secret").display().to_string();
        assert_eq!(get_begin(&scope, &outside).unwrap_err().kind, "forbidden");
        assert_eq!(get_chunk(&scope, &outside, 0, 1).unwrap_err().kind, "forbidden");
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
        assert_eq!(sha256_file(Path::new(&dest)).unwrap(), sha);
        assert_eq!(put_begin(&scope, &dest, 1, &sha).unwrap_err().kind, "conflict");

        let other = format!("{root}/bad.bin");
        let wrong = hex(&Sha256::digest(b"something else"));
        put_begin(&scope, &other, 3, &wrong).unwrap();
        put_chunk(&scope, &other, &wrong, 0, b"abc").unwrap();
        assert_eq!(put_finish(&scope, &other, &wrong).unwrap_err().kind, "invalid");
        assert!(!Path::new(&other).exists());
    }
}
