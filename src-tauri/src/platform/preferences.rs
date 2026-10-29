//! 用户偏好存于 `$BERTH_HOME/preferences.json`（默认 `~/.berth`）。
//!
//! These are settings that must be readable **before** the Tauri builder and
//! tokio runtime start (e.g. WebView2 rendering flags applied via
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`). All access is synchronous I/O so
//! the data must stay tiny.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const PREFERENCES_FILE_NAME: &str = "preferences.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppPreferences {
    pub disable_hardware_acceleration: bool,
}

pub fn preferences_file_path() -> PathBuf {
    crate::platform::paths::berth_home_dir().join(PREFERENCES_FILE_NAME)
}

/// Read preferences synchronously. Missing / unreadable / malformed file
/// returns `Default::default()`. Errors are intentionally swallowed because
/// this is called on the startup hot-path; callers log if needed.
pub fn load() -> AppPreferences {
    let path = preferences_file_path();
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => AppPreferences::default(),
        Err(err) => {
            tracing::error!("[Preferences] failed to read {}: {err}", path.display());
            AppPreferences::default()
        }
    }
}

pub fn save(prefs: &AppPreferences) -> io::Result<()> {
    let path = preferences_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(prefs)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
    fs::write(&path, serialized)
}

#[cfg(test)]
mod tests {
    #[test]
    fn preferences_live_under_berth_home() {
        let lock = crate::tool::path::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let path = super::preferences_file_path();
        let home = crate::platform::paths::berth_home_dir();
        assert_eq!(path.parent(), Some(home.as_path()));
        assert_eq!(
            path.file_name(),
            Some(std::ffi::OsStr::new("preferences.json"))
        );
    }

    #[test]
    fn preferences_read_and_write_only_in_dev_home() {
        let lock = crate::tool::path::TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        temp_env::with_var("BERTH_HOME", Some(home.path().as_os_str()), || {
            let path = super::preferences_file_path();
            assert_eq!(path, home.path().join("preferences.json"));
            super::save(&super::AppPreferences {
                disable_hardware_acceleration: true,
            })
            .unwrap();
            assert!(super::load().disable_hardware_acceleration);
            assert!(path.is_file());
        });
    }
}
