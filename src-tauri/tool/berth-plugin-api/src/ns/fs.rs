//! fs@1（脚本 · 权限 `fs`）：本机路径读写。路径为绝对路径或 `~` 开头。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::rpc::{str_param, ApiError, ApiResult};

pub fn call(name: &str, params: &Value) -> Option<ApiResult> {
    Some(match name {
        "readText" => path(params, "path").and_then(|path| read_text(&path, &params["tailBytes"])),
        "writeText" => write_text(params),
        "stat" => path(params, "path").map(|path| stat(&path)),
        "list" => path(params, "dir").and_then(|dir| list(&dir)),
        "mkdir" => path(params, "dir").and_then(|dir| mkdir(&dir, &params["mode"])),
        "remove" => path(params, "path").and_then(|path| remove(&path)),
        "symlink" => {
            two(params, "target", "link").and_then(|(target, link)| symlink(&target, &link))
        }
        "copy" => two(params, "from", "to").and_then(|(from, to)| copy(&from, &to)),
        "rename" => two(params, "from", "to").and_then(|(from, to)| {
            std::fs::rename(&from, &to)
                .map(|_| Value::Null)
                .map_err(|error| ApiError::io(&from.to_string_lossy(), error))
        }),
        "resolve" => path(params, "path").and_then(|path| {
            std::fs::canonicalize(&path)
                .map(|resolved| json!(resolved.to_string_lossy()))
                .map_err(|error| ApiError::io(&path.to_string_lossy(), error))
        }),
        _ => return None,
    })
}

/// 展开开头的 `~`。
pub(crate) fn expand(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            home.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(path),
    }
}

fn path(params: &Value, key: &str) -> Result<PathBuf, ApiError> {
    let path = expand(str_param(params, key)?);
    if !path.is_absolute() {
        return Err(ApiError::invalid(format!(
            "{key} must be absolute or start with ~"
        )));
    }
    Ok(path)
}

fn two(params: &Value, a: &str, b: &str) -> Result<(PathBuf, PathBuf), ApiError> {
    Ok((path(params, a)?, path(params, b)?))
}

/// 读文本；`tailBytes` 只读末尾这么多字节（大日志），切断的多字节字符按替换符解码。
fn read_text(path: &Path, tail: &Value) -> ApiResult {
    use std::io::{Read, Seek, SeekFrom};
    let label = path.to_string_lossy();
    let io = |error| ApiError::io(&label, error);
    if tail.is_null() {
        return std::fs::read_to_string(path).map(|text| json!(text)).map_err(io);
    }
    let tail = tail.as_u64().ok_or_else(|| ApiError::invalid("tailBytes must be a positive integer"))?;
    let mut file = std::fs::File::open(path).map_err(io)?;
    let size = file.metadata().map_err(io)?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(tail))).map_err(io)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(io)?;
    Ok(json!(String::from_utf8_lossy(&bytes)))
}

/// 原子写：同目录临时文件写完再改名；父目录不存在时创建。
fn write_text(params: &Value) -> ApiResult {
    let target = path(params, "path")?;
    let text = str_param(params, "text")?;
    let mode = match &params["mode"] {
        Value::Null => 0o644,
        value => value
            .as_u64()
            .filter(|mode| *mode <= 0o7777)
            .ok_or_else(|| ApiError::invalid("mode must be an integer like 0o600"))?
            as u32,
    };
    let label = target.to_string_lossy().into_owned();
    let parent = target
        .parent()
        .ok_or_else(|| ApiError::invalid("path has no parent"))?;
    std::fs::create_dir_all(parent).map_err(|error| ApiError::io(&label, error))?;
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{name}.berth-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|error| ApiError::io(&label, error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode))
            .map_err(|error| ApiError::io(&label, error))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    std::fs::rename(&tmp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        ApiError::io(&label, error)
    })?;
    Ok(Value::Null)
}

/// 递归建目录；`mode` 只作用于最后一级（如会话目录 0o700）。
fn mkdir(dir: &Path, mode: &Value) -> ApiResult {
    let label = dir.to_string_lossy();
    std::fs::create_dir_all(dir).map_err(|error| ApiError::io(&label, error))?;
    if !mode.is_null() {
        let mode = mode
            .as_u64()
            .filter(|mode| *mode <= 0o7777)
            .ok_or_else(|| ApiError::invalid("mode must be an integer like 0o700"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode as u32))
                .map_err(|error| ApiError::io(&label, error))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(Value::Null)
}

fn stat(path: &Path) -> Value {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Value::Null;
    };
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    json!({
        "kind": if metadata.is_dir() { "dir" } else { "file" },
        "size": metadata.len(),
        "mtimeMs": mtime,
    })
}

fn list(dir: &Path) -> ApiResult {
    let label = dir.to_string_lossy();
    let mut names = std::fs::read_dir(dir)
        .map_err(|error| ApiError::io(&label, error))?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect::<Vec<_>>();
    names.sort();
    Ok(json!(names))
}

fn remove(path: &Path) -> ApiResult {
    let result = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
    };
    result
        .map(|_| Value::Null)
        .map_err(|error| ApiError::io(&path.to_string_lossy(), error))
}

fn symlink(target: &Path, link: &Path) -> ApiResult {
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let result = if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
    result
        .map(|_| Value::Null)
        .map_err(|error| ApiError::io(&link.to_string_lossy(), error))
}

/// 复制文件，或递归复制目录。
fn copy(from: &Path, to: &Path) -> ApiResult {
    fn walk(from: &Path, to: &Path) -> std::io::Result<()> {
        if !from.is_dir() {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            return std::fs::copy(from, to).map(|_| ());
        }
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            walk(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    }
    walk(from, to)
        .map(|_| Value::Null)
        .map_err(|error| ApiError::io(&from.to_string_lossy(), error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::Reason;

    #[test]
    fn write_read_stat_list_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a/b.txt");
        let p = |path: &Path| json!(path.to_string_lossy());
        call(
            "writeText",
            &json!({"path": p(&file), "text": "hi", "mode": 0o600}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            call("readText", &json!({"path": p(&file)}))
                .unwrap()
                .unwrap(),
            json!("hi")
        );
        assert_eq!(
            call("stat", &json!({"path": p(&file)})).unwrap().unwrap()["kind"],
            json!("file")
        );
        assert_eq!(
            call("list", &json!({"dir": p(&dir.path().join("a"))}))
                .unwrap()
                .unwrap(),
            json!(["b.txt"])
        );
        call("remove", &json!({"path": p(&dir.path().join("a"))}))
            .unwrap()
            .unwrap();
        assert_eq!(
            call("stat", &json!({"path": p(&file)})).unwrap().unwrap(),
            Value::Null
        );
        call("remove", &json!({"path": p(&file)})).unwrap().unwrap();
    }

    #[test]
    fn relative_paths_and_missing_files_are_reported() {
        let tail = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tail.path(), "line1\nline2\n").unwrap();
        let read = call("readText", &json!({"path": tail.path().to_string_lossy(), "tailBytes": 6}));
        assert_eq!(read.unwrap().unwrap(), json!("line2\n"));
        let error = call("readText", &json!({"path": "rel.txt"}))
            .unwrap()
            .unwrap_err();
        assert_eq!(error.reason, Reason::InvalidParams);
        let error = call("readText", &json!({"path": "/berth-no-such-file"}))
            .unwrap()
            .unwrap_err();
        assert_eq!(error.reason, Reason::NotFound);
    }
}
