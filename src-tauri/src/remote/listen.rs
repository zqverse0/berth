//! 远程访问的监听地址与访问密码：设置页由用户填写，保存即重新绑定，不用重启。
//! 没设密码不监听。地址随实例的库、密码随实例的凭据文件：dev 与正式版各一份。

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use berth_project_core::service::app_metadata_service;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;

use super::{accept_loop, Remote, PORT};
use crate::app_error::AppCommandError;
use crate::platform::keyring_store;

const SETTINGS_KEY: &str = "remote_access_settings";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessSettings {
    /// `ip` 或 `ip:port`（IPv6 写 `[ip]:port`），不写端口用本实例默认端口。
    #[serde(default)]
    pub addresses: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindError {
    pub address: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub settings: RemoteAccessSettings,
    pub default_port: u16,
    pub has_password: bool,
    /// 正在监听的 `ip:port`。
    pub listening: Vec<String>,
    pub errors: Vec<BindError>,
}

#[derive(Default)]
struct Bound {
    tasks: Vec<JoinHandle<()>>,
    listening: Vec<String>,
    errors: Vec<BindError>,
}

/// 由 `remote::host` 放进 Tauri state；命令经它读状态、改设置。
pub struct Listeners<R: tauri::Runtime> {
    remote: Arc<Remote<R>>,
    conn: DatabaseConnection,
    bound: tokio::sync::Mutex<Bound>,
}

impl<R: tauri::Runtime> Listeners<R> {
    pub(super) fn new(remote: Arc<Remote<R>>, conn: DatabaseConnection) -> Self {
        Self {
            remote,
            conn,
            bound: tokio::sync::Mutex::default(),
        }
    }

    pub async fn status(&self) -> Result<RemoteAccessStatus, AppCommandError> {
        let settings = load(&self.conn).await?;
        let has_password = password().await?.is_some();
        let bound = self.bound.lock().await;
        Ok(RemoteAccessStatus {
            settings,
            default_port: PORT,
            has_password,
            listening: bound.listening.clone(),
            errors: bound.errors.clone(),
        })
    }

    /// `password`：`None` 不改，空串清除。
    pub async fn update(
        &self,
        mut settings: RemoteAccessSettings,
        password: Option<String>,
    ) -> Result<RemoteAccessStatus, AppCommandError> {
        settings.addresses = settings
            .addresses
            .iter()
            .map(|address| address.trim().to_owned())
            .filter(|address| !address.is_empty())
            .collect();
        for address in &settings.addresses {
            parse_address(address).ok_or_else(|| {
                AppCommandError::invalid_input(format!("Invalid address: {address}"))
            })?;
        }
        if let Some(password) = password {
            let password = Some(password).filter(|value| !value.is_empty());
            keyring_store::run_blocking(move || {
                keyring_store::set_remote_access_password(password.as_deref())
            })
            .await
            .and_then(|result| result)
            .map_err(AppCommandError::io_error)?;
        }
        let raw = serde_json::to_string(&settings).map_err(|e| {
            AppCommandError::invalid_input("Failed to serialize remote access settings")
                .with_detail(e.to_string())
        })?;
        app_metadata_service::upsert_value(&self.conn, SETTINGS_KEY, &raw).await?;
        self.apply(&settings).await;
        self.status().await
    }

    /// 关掉现有监听再按设置重新绑定；已建立的连接不受影响，页面断开后自然结束。
    pub(super) async fn apply(&self, settings: &RemoteAccessSettings) {
        let mut bound = self.bound.lock().await;
        for task in bound.tasks.drain(..) {
            task.abort();
            // 等任务真正结束、listener 释放，同一地址才能马上重绑。
            let _ = task.await;
        }
        bound.listening.clear();
        bound.errors.clear();

        let session = match password().await {
            Ok(Some(password)) => session_token(&password).await,
            Ok(None) => None,
            Err(error) => {
                tracing::warn!("[remote] read password: {error}");
                None
            }
        };
        let has_session = session.is_some();
        *self.remote.session.write().expect("remote session") = session;
        if !has_session {
            tracing::info!("[remote] no password; remote access disabled");
            return;
        }

        let addrs: std::collections::BTreeSet<SocketAddr> = settings
            .addresses
            .iter()
            .filter_map(|address| parse_address(address))
            .collect();
        for addr in addrs {
            match tokio::net::TcpListener::bind(addr).await {
                Ok(listener) => {
                    tracing::info!("[remote] listening on http://{addr}/");
                    bound.listening.push(addr.to_string());
                    bound
                        .tasks
                        .push(tokio::spawn(accept_loop(listener, self.remote.clone())));
                }
                Err(error) => {
                    tracing::info!("[remote] {addr} unavailable ({error})");
                    bound.errors.push(BindError {
                        address: addr.to_string(),
                        message: error.to_string(),
                    });
                }
            }
        }
    }
}

pub(super) async fn load(
    conn: &DatabaseConnection,
) -> Result<RemoteAccessSettings, AppCommandError> {
    let Some(raw) = app_metadata_service::get_value(conn, SETTINGS_KEY).await? else {
        return Ok(RemoteAccessSettings::default());
    };
    serde_json::from_str(&raw).map_err(|e| {
        AppCommandError::configuration_invalid("Failed to parse remote access settings")
            .with_detail(e.to_string())
    })
}

async fn password() -> Result<Option<String>, AppCommandError> {
    keyring_store::run_blocking(keyring_store::get_remote_access_password)
        .await
        .and_then(|result| result)
        .map_err(AppCommandError::io_error)
}

/// 登录 cookie 的值：密码加盐的哈希。改密码即作废已登录的浏览器，重启不用重新登录。
async fn session_token(password: &str) -> Option<String> {
    let salt = keyring_store::run_blocking(keyring_store::get_or_create_remote_access_salt)
        .await
        .and_then(|result| result)
        .map_err(|error| tracing::warn!("[remote] salt: {error}"))
        .ok()?;
    Some(hash(&salt, password))
}

fn hash(salt: &str, password: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{salt}\n{password}")))
}

/// 登录时校验：用同一个盐算出的哈希与当前 cookie 值相同即通过。
pub(super) async fn check_password(input: &str, session: &str) -> bool {
    let Ok(Ok(salt)) =
        keyring_store::run_blocking(keyring_store::get_or_create_remote_access_salt).await
    else {
        return false;
    };
    hash(&salt, input) == session
}

fn parse_address(address: &str) -> Option<SocketAddr> {
    address
        .parse::<SocketAddr>()
        .ok()
        .or_else(|| Some(SocketAddr::new(address.parse::<IpAddr>().ok()?, PORT)))
        .filter(|addr| addr.port() != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_port_is_optional() {
        assert_eq!(
            parse_address("100.0.0.1"),
            Some(SocketAddr::new("100.0.0.1".parse().unwrap(), PORT))
        );
        assert_eq!(
            parse_address("100.0.0.1:8080").map(|a| a.port()),
            Some(8080)
        );
        assert_eq!(parse_address("[::1]:8080").map(|a| a.port()), Some(8080));
        assert_eq!(parse_address("100.0.0.1:0"), None);
        assert_eq!(parse_address("berth.local"), None);
    }

    #[test]
    fn hash_depends_on_salt_and_password() {
        assert_ne!(hash("a", "pw"), hash("b", "pw"));
        assert_ne!(hash("a", "pw"), hash("a", "pw2"));
        assert_eq!(hash("a", "pw"), hash("a", "pw"));
    }
}
