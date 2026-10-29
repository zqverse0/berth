//! GUI、CLI 共用的本地服务商凭据；与数据实例隔离，不访问系统钥匙串。

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn directory(data_dir: &Path) -> PathBuf {
    data_dir.join("credentials")
}

fn read(data_dir: &Path) -> io::Result<HashMap<String, String>> {
    let path = directory(data_dir).join("providers.json");
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error),
    };
    serde_json::from_str(&text).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid local provider credential file; restore it from backup instead of overwriting it"))
}

/// 读取凭据；不存在返回 None，读取错误不冒充空凭据。
pub fn get(data_dir: &Path, account: &str) -> io::Result<Option<String>> {
    Ok(read(data_dir)?.remove(account))
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn update<T>(
    data_dir: &Path,
    edit: impl FnOnce(&mut HashMap<String, String>) -> T,
) -> io::Result<T> {
    let dir = directory(data_dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(&dir)?;

    // 锁文件保持稳定；数据文件可原子替换，跨 GUI / CLI 不丢并发更新。
    let lock = private_options()
        .create(true)
        .read(true)
        .open(dir.join("providers.lock"))?;
    lock.lock()?;
    let mut values = read(data_dir)?;
    let result = edit(&mut values);
    let json = serde_json::to_vec(&values).map_err(io::Error::other)?;
    let temp = dir.join(format!(".providers-{}.tmp", uuid::Uuid::new_v4()));
    let saved = (|| {
        let mut file = private_options().create_new(true).open(&temp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, dir.join("providers.json"))
    })();
    if saved.is_err() {
        let _ = fs::remove_file(&temp);
    }
    saved?;
    Ok(result)
}

/// 保存或替换一个凭据，保留其他账户。
pub fn set(data_dir: &Path, account: &str, secret: &str) -> io::Result<()> {
    update(data_dir, |values| {
        values.insert(account.to_string(), secret.to_string());
    })
}

/// 删除一个凭据，保留其他账户。
pub fn delete(data_dir: &Path, account: &str) -> io::Result<()> {
    update(data_dir, |values| {
        values.remove(account);
    })
}

/// 在锁内读取或生成令牌；GUI 与 CLI 同时首次访问也得到同一个值。
pub fn get_or_create(data_dir: &Path, account: &str) -> io::Result<String> {
    update(data_dir, |values| {
        if let Some(token) = values.get(account).filter(|value| !value.is_empty()) {
            return token.clone();
        }
        let token = format!("berth-tk-{}", uuid::Uuid::new_v4().simple());
        values.insert(account.to_string(), token.clone());
        token
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_other_accounts_and_instances() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        assert_eq!(get(dir.path(), "a").unwrap(), None);
        set(dir.path(), "a", "test-a").unwrap();
        set(dir.path(), "b", "test-b").unwrap();
        delete(dir.path(), "a").unwrap();
        assert_eq!(get(dir.path(), "a").unwrap(), None);
        assert_eq!(get(dir.path(), "b").unwrap().as_deref(), Some("test-b"));
        assert_eq!(get(other.path(), "b").unwrap(), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory(dir.path()))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            for file in ["providers.json", "providers.lock"] {
                assert_eq!(
                    fs::metadata(directory(dir.path()).join(file))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
    }

    #[test]
    fn concurrent_updates_preserve_every_account_and_one_proxy_token() {
        let dir = tempfile::tempdir().unwrap();
        let workers: Vec<_> = (0..8)
            .map(|id| {
                let root = dir.path().to_owned();
                std::thread::spawn(move || {
                    set(&root, &format!("account-{id}"), "test-key").unwrap();
                    get_or_create(&root, "proxy").unwrap()
                })
            })
            .collect();
        let tokens: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(tokens.iter().all(|token| token == &tokens[0]));
        for id in 0..8 {
            assert_eq!(
                get(dir.path(), &format!("account-{id}"))
                    .unwrap()
                    .as_deref(),
                Some("test-key")
            );
        }
    }

    #[test]
    fn corrupt_file_is_reported_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        set(dir.path(), "a", "test-key").unwrap();
        let path = directory(dir.path()).join("providers.json");
        fs::write(&path, "broken json").unwrap();
        assert!(get(dir.path(), "a").is_err());
        assert!(set(dir.path(), "b", "another-key").is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken json");
    }
}
