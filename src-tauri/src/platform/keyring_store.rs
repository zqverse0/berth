#[cfg(feature = "tauri-runtime")]
const fn service_name(debug: bool) -> &'static str {
    if debug {
        "berth-dev"
    } else {
        "berth"
    }
}

// 单测必须与正式版、开发版 keyring 均隔离；集成测试不可访问真实 keyring。
#[cfg(all(feature = "tauri-runtime", test))]
const SERVICE_NAME: &str = "berth-test";
#[cfg(all(feature = "tauri-runtime", not(test)))]
const SERVICE_NAME: &str = service_name(cfg!(debug_assertions));

fn token_key(account_id: &str) -> String {
    format!("github-token:{}", account_id)
}

fn translate_token_key(provider: &str) -> String {
    format!("translate:{provider}")
}

// 账户名与 CLI 只读路径共用（berth-project-core）。
use berth_project_core::service::model_provider_launch::{
    api_key_account as model_provider_key, secrets_account as model_provider_secrets_key,
    PROXY_TOKEN_ACCOUNT,
};

fn channel_token_key(channel_id: i32) -> String {
    format!("chat-channel:{}", channel_id)
}

// 系统授权可能无限等待：只允许一个阻塞任务，调用方最多等待十秒。
static KEYRING_IO: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

async fn run_keyring_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let permit = KEYRING_IO
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        run_blocking(move || {
            // 超时不能取消系统调用；许可随任务保留，防止重复请求堆积线程。
            let _permit = permit;
            operation()
        })
        .await?
    })
    .await
    .map_err(|_| "System credential access timed out; check keyring authorization".to_string())?
}

pub async fn get_token(account_id: &str) -> Result<Option<String>, String> {
    let account_id = account_id.to_string();
    run_keyring_blocking(move || get_token_blocking(&account_id)).await
}

pub async fn set_token(account_id: &str, token: &str) -> Result<(), String> {
    let account_id = account_id.to_string();
    let token = token.to_string();
    run_keyring_blocking(move || set_token_blocking(&account_id, &token)).await
}

pub async fn delete_token(account_id: &str) -> Result<(), String> {
    let account_id = account_id.to_string();
    run_keyring_blocking(move || delete_token_blocking(&account_id)).await
}

pub async fn get_translate_api_key(provider: &str) -> Result<Option<String>, String> {
    let provider = provider.to_string();
    run_keyring_blocking(move || get_translate_api_key_blocking(&provider)).await
}

pub async fn set_translate_api_key(provider: &str, api_key: &str) -> Result<(), String> {
    let provider = provider.to_string();
    let api_key = api_key.to_string();
    run_keyring_blocking(move || set_translate_api_key_blocking(&provider, &api_key)).await
}

pub async fn delete_translate_api_key(provider: &str) -> Result<(), String> {
    let provider = provider.to_string();
    run_keyring_blocking(move || delete_translate_api_key_blocking(&provider)).await
}

pub async fn get_channel_token(channel_id: i32) -> Result<Option<String>, String> {
    run_keyring_blocking(move || get_channel_token_blocking(channel_id)).await
}

pub async fn set_channel_token(channel_id: i32, token: &str) -> Result<(), String> {
    let token = token.to_string();
    run_keyring_blocking(move || set_channel_token_blocking(channel_id, &token)).await
}

pub async fn delete_channel_token(channel_id: i32) -> Result<(), String> {
    run_keyring_blocking(move || delete_channel_token_blocking(channel_id)).await
}

// ── Tauri mode: OS keyring ──

#[cfg(feature = "tauri-runtime")]
fn set_token_blocking(account_id: &str, token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &token_key(account_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("keyring set error: {e}"))
}

#[cfg(feature = "tauri-runtime")]
fn get_token_blocking(account_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &token_key(account_id))
        .map_err(|error| format!("keyring init error: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("keyring read error: {error}")),
    }
}

#[cfg(feature = "tauri-runtime")]
fn delete_token_blocking(account_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &token_key(account_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}

// ── Server mode: file-based token store ──

#[cfg(not(feature = "tauri-runtime"))]
fn tokens_file_path() -> std::path::PathBuf {
    tokens_file_path_for(std::env::var("BERTH_DATA_DIR").ok().as_deref())
}

/// Resolve the on-disk `tokens.json` path given an explicit
/// `BERTH_DATA_DIR` value (or `None` to fall back to the platform
/// default). Always returns an absolute path so subprocess credential
/// helpers — which inherit our env but run in git's CWD, not ours —
/// don't end up looking for `tokens.json` in the user's repo. Factored
/// out so tests can exercise path resolution without poking at process
/// env state.
#[cfg(not(feature = "tauri-runtime"))]
fn tokens_file_path_for(env_value: Option<&str>) -> std::path::PathBuf {
    let dir = env_value.map(std::path::PathBuf::from).unwrap_or_else(|| {
        dirs::data_dir()
            .map(|d| d.join("berth"))
            .unwrap_or_else(|| std::path::PathBuf::from(".berth-data"))
    });
    crate::git::credential::absolutize(&dir).join("tokens.json")
}

#[cfg(not(feature = "tauri-runtime"))]
fn read_tokens() -> std::collections::HashMap<String, String> {
    let path = tokens_file_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[cfg(not(feature = "tauri-runtime"))]
fn write_tokens(tokens: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let path = tokens_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create token store directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("failed to serialize tokens: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("failed to write token store: {e}"))
}

#[cfg(not(feature = "tauri-runtime"))]
fn set_token_blocking(account_id: &str, token: &str) -> Result<(), String> {
    let mut tokens = read_tokens();
    tokens.insert(token_key(account_id), token.to_string());
    write_tokens(&tokens)
}

#[cfg(not(feature = "tauri-runtime"))]
fn get_token_blocking(account_id: &str) -> Result<Option<String>, String> {
    Ok(read_tokens().get(&token_key(account_id)).cloned())
}

#[cfg(not(feature = "tauri-runtime"))]
fn delete_token_blocking(account_id: &str) -> Result<(), String> {
    let mut tokens = read_tokens();
    tokens.remove(&token_key(account_id));
    write_tokens(&tokens)
}

// ── Chat channel token helpers ──
// Reuse the same storage mechanism (keyring or file) with a different key prefix.

#[cfg(feature = "tauri-runtime")]
fn set_channel_token_blocking(channel_id: i32, token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &channel_token_key(channel_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("keyring set error: {e}"))
}

#[cfg(feature = "tauri-runtime")]
fn get_channel_token_blocking(channel_id: i32) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &channel_token_key(channel_id))
        .map_err(|error| format!("keyring init error: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("keyring read error: {error}")),
    }
}

#[cfg(feature = "tauri-runtime")]
fn delete_channel_token_blocking(channel_id: i32) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &channel_token_key(channel_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}

#[cfg(not(feature = "tauri-runtime"))]
fn set_channel_token_blocking(channel_id: i32, token: &str) -> Result<(), String> {
    let mut tokens = read_tokens();
    tokens.insert(channel_token_key(channel_id), token.to_string());
    write_tokens(&tokens)
}

#[cfg(not(feature = "tauri-runtime"))]
fn get_channel_token_blocking(channel_id: i32) -> Result<Option<String>, String> {
    Ok(read_tokens().get(&channel_token_key(channel_id)).cloned())
}

#[cfg(not(feature = "tauri-runtime"))]
fn delete_channel_token_blocking(channel_id: i32) -> Result<(), String> {
    let mut tokens = read_tokens();
    tokens.remove(&channel_token_key(channel_id));
    write_tokens(&tokens)
}

// ── Translate API keys ──

#[cfg(feature = "tauri-runtime")]
fn set_translate_api_key_blocking(provider: &str, api_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &translate_token_key(provider))
        .map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(api_key)
        .map_err(|e| format!("keyring set error: {e}"))
}

#[cfg(feature = "tauri-runtime")]
fn get_translate_api_key_blocking(provider: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &translate_token_key(provider))
        .map_err(|error| format!("keyring init error: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("keyring read error: {error}")),
    }
}

#[cfg(feature = "tauri-runtime")]
fn delete_translate_api_key_blocking(provider: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &translate_token_key(provider))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}

#[cfg(not(feature = "tauri-runtime"))]
fn set_translate_api_key_blocking(provider: &str, api_key: &str) -> Result<(), String> {
    let mut tokens = read_tokens();
    tokens.insert(translate_token_key(provider), api_key.to_string());
    write_tokens(&tokens)
}

#[cfg(not(feature = "tauri-runtime"))]
fn get_translate_api_key_blocking(provider: &str) -> Result<Option<String>, String> {
    Ok(read_tokens().get(&translate_token_key(provider)).cloned())
}

#[cfg(not(feature = "tauri-runtime"))]
fn delete_translate_api_key_blocking(provider: &str) -> Result<(), String> {
    let mut tokens = read_tokens();
    tokens.remove(&translate_token_key(provider));
    write_tokens(&tokens)
}

// ── 服务商凭据：GUI / CLI 共用本地文件，不再调用系统钥匙串 ──

fn provider_data_dir() -> std::path::PathBuf {
    use berth_project_core::instance::{default_data_dir, BuildInstance};
    let build = if cfg!(all(debug_assertions, feature = "tauri-runtime")) {
        BuildInstance::Dev
    } else {
        BuildInstance::Release
    };
    crate::platform::paths::resolve_effective_data_dir(&default_data_dir(build))
}

pub fn set_model_provider_api_key(provider_id: i32, api_key: &str) -> Result<(), String> {
    berth_project_core::credentials::set(
        &provider_data_dir(),
        &model_provider_key(provider_id),
        api_key,
    )
    .map_err(|error| error.to_string())
}

pub fn get_model_provider_api_key(provider_id: i32) -> Result<Option<String>, String> {
    berth_project_core::credentials::get(&provider_data_dir(), &model_provider_key(provider_id))
        .map_err(|error| error.to_string())
}

pub fn delete_model_provider_api_key(provider_id: i32) -> Result<(), String> {
    berth_project_core::credentials::delete(&provider_data_dir(), &model_provider_key(provider_id))
        .map_err(|error| error.to_string())
}

pub fn set_model_provider_secrets(provider_id: i32, secrets: &str) -> Result<(), String> {
    berth_project_core::credentials::set(
        &provider_data_dir(),
        &model_provider_secrets_key(provider_id),
        secrets,
    )
    .map_err(|error| error.to_string())
}

pub fn get_model_provider_secrets(provider_id: i32) -> Result<Option<String>, String> {
    berth_project_core::credentials::get(
        &provider_data_dir(),
        &model_provider_secrets_key(provider_id),
    )
    .map_err(|error| error.to_string())
}

pub fn delete_model_provider_secrets(provider_id: i32) -> Result<(), String> {
    berth_project_core::credentials::delete(
        &provider_data_dir(),
        &model_provider_secrets_key(provider_id),
    )
    .map_err(|error| error.to_string())
}

/// 服务商凭据改存本地文件之前（4b76eb2）保存的 Key 仍在系统钥匙串里：每个数据实例导入一次。
/// 只补文件里缺的账户、不覆盖；全部读完才写标记，超时或出错下次启动重试。钥匙串条目保留不删。
#[cfg(feature = "tauri-runtime")]
pub async fn import_legacy_provider_credentials(provider_ids: Vec<i32>) -> Result<usize, String> {
    let dir = provider_data_dir();
    let marker = dir.join("credentials").join("keyring-imported");
    if marker.exists() {
        return Ok(0);
    }
    run_keyring_blocking(move || {
        let mut imported = 0;
        for id in provider_ids {
            for account in [model_provider_key(id), model_provider_secrets_key(id)] {
                if berth_project_core::credentials::get(&dir, &account)
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    continue;
                }
                let entry = keyring::Entry::new(SERVICE_NAME, &account)
                    .map_err(|error| format!("keyring init error: {error}"))?;
                match entry.get_password() {
                    Ok(secret) if !secret.trim().is_empty() => {
                        berth_project_core::credentials::set(&dir, &account, &secret)
                            .map_err(|error| error.to_string())?;
                        imported += 1;
                    }
                    Ok(_) | Err(keyring::Error::NoEntry) => {}
                    Err(error) => return Err(format!("keyring read error: {error}")),
                }
            }
        }
        std::fs::create_dir_all(marker.parent().expect("credentials dir"))
            .and_then(|()| std::fs::write(&marker, b""))
            .map_err(|error| error.to_string())?;
        Ok(imported)
    })
    .await
}

pub fn get_or_create_provider_proxy_token() -> Result<String, String> {
    berth_project_core::credentials::get_or_create(&provider_data_dir(), PROXY_TOKEN_ACCOUNT)
        .map_err(|error| error.to_string())
}

pub fn get_provider_proxy_token() -> Result<Option<String>, String> {
    berth_project_core::credentials::get(&provider_data_dir(), PROXY_TOKEN_ACCOUNT)
        .map_err(|error| error.to_string())
}

#[cfg(all(test, not(feature = "tauri-runtime")))]
mod tests {
    use super::*;

    #[test]
    fn test_tokens_file_path_absolutizes_relative_env() {
        // Regression: a relative `BERTH_DATA_DIR=data` previously made
        // `tokens.json` resolve against the helper subprocess's CWD (i.e.
        // git's repo dir), even after we'd absolutized the path used for
        // the database. The token store must always land on an absolute
        // path so DB lookup and token lookup point at the same root.
        let cwd = std::env::current_dir().expect("cwd");
        let resolved = tokens_file_path_for(Some("data"));
        assert!(
            resolved.is_absolute(),
            "tokens path must be absolute, got: {}",
            resolved.display()
        );
        assert_eq!(resolved, cwd.join("data").join("tokens.json"));
    }

    #[test]
    fn test_tokens_file_path_absolute_env_unchanged() {
        let data_dir = std::env::current_dir().expect("cwd").join("berth-data");
        let data_dir_str = data_dir.to_string_lossy().to_string();
        let resolved = tokens_file_path_for(Some(&data_dir_str));
        assert_eq!(resolved, data_dir.join("tokens.json"));
    }

    #[test]
    fn test_tokens_file_path_default_when_unset() {
        // No env var → derived from `dirs::data_dir()` (always absolute on
        // every platform we ship to). Just verify we end at `tokens.json`
        // and that the result is absolute, not the literal default.
        let resolved = tokens_file_path_for(None);
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("tokens.json"));
    }
}
/// 凭据 I/O 放到阻塞线程，不占用数据库所在的异步工作线程。
pub async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod async_tests {
    use super::{run_blocking, run_keyring_blocking, KEYRING_IO};

    #[test]
    fn stalled_keyring_times_out_without_blocking_database_or_stacking_workers() {
        use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        use std::time::Duration;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let task = tokio::spawn(run_keyring_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(15)).unwrap();
                Ok(42)
            }));
            started_rx.await.unwrap();

            let query = tokio::time::timeout(Duration::from_secs(1), async {
                let db = Database::connect("sqlite::memory:").await.unwrap();
                db.query_one(Statement::from_string(DbBackend::Sqlite, "SELECT 1"))
                    .await
                    .unwrap()
            })
            .await;

            let second_started = Arc::new(AtomicBool::new(false));
            let started = Arc::clone(&second_started);
            let queued = tokio::time::timeout(
                Duration::from_millis(50),
                run_keyring_blocking(move || {
                    started.store(true, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await;
            let timed_out = task.await.unwrap();
            let permit_still_held = KEYRING_IO.available_permits() == 0;
            release_tx.send(()).unwrap();
            let recovered =
                tokio::time::timeout(Duration::from_secs(1), run_keyring_blocking(|| Ok(7))).await;

            assert!(query.unwrap().is_some());
            assert!(queued.is_err());
            assert!(!second_started.load(Ordering::SeqCst));
            assert!(timed_out.unwrap_err().contains("timed out"));
            assert!(permit_still_held);
            assert_eq!(recovered.unwrap().unwrap(), 7);
        });
    }

    #[test]
    fn credential_io_does_not_block_async_queries() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let task = tokio::spawn(run_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                42
            }));
            started_rx.await.unwrap();
            let query = tokio::time::timeout(std::time::Duration::from_millis(100), async {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                7
            })
            .await;
            release_tx.send(()).unwrap();
            assert_eq!(query.unwrap(), 7);
            assert_eq!(task.await.unwrap().unwrap(), 42);
        });
    }
}
