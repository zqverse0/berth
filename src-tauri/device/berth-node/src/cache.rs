//! 每设备磁盘缓存：打开设备 / 项目 / 文件时先显示上次的结果（0 次往返），后台再校验。
//!
//! 键 → 一个文件（文件名是键的 sha256），内容原样存。总大小超过上限时按最久未用（mtime，读取时刷新）淘汰。
//! 缓存可以随时丢：写失败、读到半截都只是少一次「先显示」。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

/// 一台设备的缓存目录。
pub struct Cache {
    dir: PathBuf,
    cap: u64,
}

impl Cache {
    /// `dir` 不存在时在第一次写入时创建；`cap` 是总字节上限。
    pub fn new(dir: impl Into<PathBuf>, cap: u64) -> Self {
        Self {
            dir: dir.into(),
            cap,
        }
    }

    fn path(&self, key: &str) -> PathBuf {
        let digest = Sha256::digest(key.as_bytes());
        let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        self.dir.join(name)
    }

    /// 读一项并刷新它的使用时间。
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.path(key);
        let bytes = fs::read(&path).ok()?;
        if let Ok(file) = fs::File::options().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        Some(bytes)
    }

    /// 写一项（先写临时文件再改名，读的一方不会看到半截），然后按上限淘汰。
    pub fn put(&self, key: &str, bytes: &[u8]) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let path = self.path(key);
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        self.evict(&path)
    }

    /// 删一项。
    pub fn remove(&self, key: &str) {
        let _ = fs::remove_file(self.path(key));
    }

    fn evict(&self, keep: &Path) -> io::Result<()> {
        let mut files: Vec<(SystemTime, u64, PathBuf)> = fs::read_dir(&self.dir)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                meta.is_file().then(|| {
                    (
                        meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        meta.len(),
                        entry.path(),
                    )
                })
            })
            .collect();
        let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
        files.sort();
        for (_, len, path) in files {
            if total <= self.cap {
                break;
            }
            if path != keep {
                let _ = fs::remove_file(&path);
                total -= len;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_least_recently_used_past_the_cap() {
        let dir = std::env::temp_dir().join(format!("berth-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let cache = Cache::new(&dir, 250);
        let old = SystemTime::now() - std::time::Duration::from_secs(60);
        for key in ["a", "b"] {
            cache.put(key, &[0; 100]).unwrap();
            fs::File::options()
                .write(true)
                .open(cache.path(key))
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        // 读过的 a 变成最近使用；写入 c 超出上限时淘汰 b。
        assert_eq!(cache.get("a").unwrap().len(), 100);
        cache.put("c", &[1; 100]).unwrap();
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some());
        assert_eq!(cache.get("c").unwrap(), [1; 100]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
