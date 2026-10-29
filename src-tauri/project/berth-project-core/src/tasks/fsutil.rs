//! 有上限的读取、原子写入与进程间排他锁（与旧 Python 脚本的 `flock` 互斥）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{TaskError, TaskResult};

pub(crate) const MAX_JSON_BYTES: u64 = 512 * 1024;
pub(crate) const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024;

pub(crate) fn read_bounded(path: &Path, limit: u64) -> TaskResult<Vec<u8>> {
    let meta = fs::symlink_metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            TaskError::new("not_found", format!("File not found: {}", path.display()))
        }
        _ => TaskError::new(
            "io_error",
            format!("Cannot read {}: {error}", path.display()),
        ),
    })?;
    if meta.file_type().is_symlink() {
        return Err(TaskError::new(
            "unsafe_path",
            format!("Symlinked workflow file is not allowed: {}", path.display()),
        ));
    }
    if meta.len() > limit {
        return Err(TaskError::new(
            "too_large",
            format!("File is larger than the allowed limit: {}", path.display()),
        ));
    }
    fs::read(path).map_err(|error| {
        TaskError::new(
            "io_error",
            format!("Cannot read {}: {error}", path.display()),
        )
    })
}

pub(crate) fn read_text(path: &Path, limit: u64) -> TaskResult<String> {
    String::from_utf8(read_bounded(path, limit)?)
        .map_err(|_| TaskError::new("invalid_input", format!("Not UTF-8: {}", path.display())))
}

/// 读 JSON；文件不存在时返回 `None`。
pub(crate) fn read_json(path: &Path) -> TaskResult<Option<serde_json::Value>> {
    let bytes = match read_bounded(path, MAX_JSON_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.code == "not_found" => return Ok(None),
        Err(error) => return Err(error),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        TaskError::new(
            "invalid_json",
            format!("Malformed JSON: {}: {error}", path.display()),
        )
    })
}

pub(crate) fn atomic_write(path: &Path, content: &[u8]) -> TaskResult<()> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(TaskError::new(
            "unsafe_path",
            format!(
                "Symlinked workflow file is not writable: {}",
                path.display()
            ),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| TaskError::new("io_error", format!("No parent: {}", path.display())))?;
    fs::create_dir_all(parent)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temporary = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut handle = File::create(&temporary)?;
        handle.write_all(content)?;
        handle.sync_all()?;
        fs::rename(&temporary, path)
    };
    write().map_err(|error| {
        let _ = fs::remove_file(&temporary);
        TaskError::new(
            "io_error",
            format!("Cannot write {}: {error}", path.display()),
        )
    })
}

/// 与旧脚本 `json.dumps(indent=2, ensure_ascii=False) + "\n"` 同一形态。
pub(crate) fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> TaskResult<()> {
    let mut encoded = serde_json::to_vec_pretty(value)
        .map_err(|error| TaskError::new("io_error", error.to_string()))?;
    encoded.push(b'\n');
    atomic_write(path, &encoded)
}

/// 持有 `path` 上的排他锁直到返回值被丢弃。
pub(crate) fn lock(path: &Path) -> TaskResult<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let handle = OpenOptions::new().create(true).append(true).open(path)?;
    handle.lock()?;
    Ok(handle)
}

pub(crate) fn etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("\"sha256-{hex}\"")
}

/// 小写、非字母数字连成 `-`、最长 80；与旧脚本同一规则（目录名、worktree 路径都用它）。
pub(crate) fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in value.trim().chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let trimmed: String = out.trim_end_matches('-').chars().take(80).collect();
    let trimmed = trimmed.trim_end_matches('-').to_owned();
    if trimmed.is_empty() {
        "task".to_owned()
    } else {
        trimmed
    }
}

/// 任务目录名 / 群名的合法字符（沿用旧脚本的正则）。
pub(crate) fn safe_component(value: &str, label: &str, max: usize) -> TaskResult<String> {
    let value = value.trim();
    let mut chars = value.chars();
    let valid = matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= max
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if valid {
        Ok(value.to_owned())
    } else {
        Err(TaskError::new(
            "invalid_input",
            format!("Invalid {label}: {value:?}"),
        ))
    }
}
