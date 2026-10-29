use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;

pub const WORKSPACE_TRANSFER_PROGRESS_EVENT: &str = "workspace://transfer-progress";

const DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY: usize = 4;
const DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY: usize = 2;
const DEFAULT_WORKSPACE_ZIP_CONCURRENCY: usize = 2;
const DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY: usize = 2;
const DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS: u64 = 300;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadKind {
    File,
    Dir,
}

#[derive(Clone, Debug)]
pub struct DownloadTicketSpec {
    pub root_path: PathBuf,
    pub target_path: PathBuf,
    pub relative_path: String,
    pub kind: DownloadKind,
    pub filename: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTicketIssued {
    pub ticket: String,
    pub url: String,
    pub filename: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug)]
pub struct DownloadTicket {
    pub root_path: PathBuf,
    pub target_path: PathBuf,
    pub relative_path: String,
    pub kind: DownloadKind,
    pub filename: String,
    pub expires_at: Instant,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTransferProgress {
    pub transfer_id: String,
    pub direction: TransferDirection,
    pub loaded: u64,
    pub total: Option<u64>,
    pub state: TransferState,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Running,
    Done,
    Cancelled,
    Error,
}

pub struct WorkspaceTransferManager {
    resources: Arc<crate::workspace_state::resource::WorkspaceResourceLeaseStore>,
    cancels: Mutex<HashMap<String, CancellationToken>>,
    pub workspace_upload_semaphore: Semaphore,
    pub remote_upload_semaphore: Semaphore,
    pub zip_semaphore: Semaphore,
    pub remote_download_semaphore: Semaphore,
    pub idle_timeout: Duration,
}

impl WorkspaceTransferManager {
    pub fn new_from_env() -> Self {
        Self::new_with_resources_from_env(Arc::new(
            crate::workspace_state::resource::WorkspaceResourceLeaseStore::new(),
        ))
    }

    pub fn new_with_resources_from_env(
        resources: Arc<crate::workspace_state::resource::WorkspaceResourceLeaseStore>,
    ) -> Self {
        Self {
            resources,
            cancels: Mutex::new(HashMap::new()),
            workspace_upload_semaphore: Semaphore::new(env_usize(
                "WORKSPACE_UPLOAD_MAX_CONCURRENCY",
                DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY,
            )),
            remote_upload_semaphore: Semaphore::new(env_usize(
                "REMOTE_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
                DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY,
            )),
            zip_semaphore: Semaphore::new(env_usize(
                "WORKSPACE_ZIP_MAX_CONCURRENCY",
                DEFAULT_WORKSPACE_ZIP_CONCURRENCY,
            )),
            remote_download_semaphore: Semaphore::new(env_usize(
                "REMOTE_WORKSPACE_DOWNLOAD_MAX_CONCURRENCY",
                DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY,
            )),
            idle_timeout: env_duration_secs(
                "WORKSPACE_TRANSFER_IDLE_TIMEOUT_SECS",
                DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS,
            ),
        }
    }

    pub fn new_for_tests(ticket_ttl: Duration) -> Self {
        let resources = Arc::new(
            crate::workspace_state::resource::WorkspaceResourceLeaseStore::new_for_tests(
                crate::workspace_state::resource::LeaseLimits {
                    idle_ttl: ticket_ttl,
                    absolute_ttl: ticket_ttl,
                    max_live: 512,
                },
            ),
        );
        Self::new_for_tests_with_resources(resources)
    }

    pub fn new_for_tests_with_resources(
        resources: Arc<crate::workspace_state::resource::WorkspaceResourceLeaseStore>,
    ) -> Self {
        Self {
            resources,
            cancels: Mutex::new(HashMap::new()),
            workspace_upload_semaphore: Semaphore::new(DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY),
            remote_upload_semaphore: Semaphore::new(DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY),
            zip_semaphore: Semaphore::new(DEFAULT_WORKSPACE_ZIP_CONCURRENCY),
            remote_download_semaphore: Semaphore::new(
                DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY,
            ),
            idle_timeout: Duration::from_secs(DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS),
        }
    }

    pub async fn register_transfer(&self) -> (String, CancellationToken) {
        let transfer_id = uuid::Uuid::new_v4().simple().to_string();
        let token = CancellationToken::new();
        self.cancels
            .lock()
            .await
            .insert(transfer_id.clone(), token.clone());
        (transfer_id, token)
    }

    pub async fn finish_transfer(&self, transfer_id: &str) {
        self.cancels.lock().await.remove(transfer_id);
    }

    pub async fn cancel(&self, transfer_id: &str) -> bool {
        let token = self.cancels.lock().await.remove(transfer_id);
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn issue_download_ticket(
        &self,
        spec: DownloadTicketSpec,
    ) -> Result<DownloadTicketIssued, crate::app_error::AppCommandError> {
        let filename = spec.filename.clone();
        let issued = self
            .resources
            .issue_download(
                crate::workspace_state::resource::ResourceLeaseSpec {
                    purpose: crate::workspace_state::resource::ResourcePurpose::Download,
                    access: crate::workspace_state::resource::ResourceAccess::OneShot,
                    canonical_root: spec.root_path,
                    canonical_target: spec.target_path,
                    owner: "workspace-transfer".to_string(),
                    source_version: None,
                },
                crate::workspace_state::resource::DownloadLeaseData {
                    relative_path: spec.relative_path,
                    is_directory: spec.kind == DownloadKind::Dir,
                    filename: spec.filename,
                },
            )
            .await?;

        Ok(DownloadTicketIssued {
            url: issued.id.clone(),
            ticket: issued.id,
            filename,
            expires_at: issued.expires_at_ms / 1_000,
        })
    }

    pub async fn consume_download_ticket(&self, ticket: &str) -> Option<DownloadTicket> {
        let (spec, download, expires_at) = self
            .resources
            .consume_download(ticket, "workspace-transfer")
            .await
            .ok()?;
        Some(DownloadTicket {
            root_path: spec.canonical_root,
            target_path: spec.canonical_target,
            relative_path: download.relative_path,
            kind: if download.is_directory {
                DownloadKind::Dir
            } else {
                DownloadKind::File
            },
            filename: download.filename,
            expires_at: expires_at.into(),
        })
    }

    pub async fn cleanup_expired_tickets(&self) {
        self.resources.cleanup_expired().await;
    }
}

/// Parse a positive `usize` from an operator env var, identified by its bare
/// suffix. Reads `BERTH_{suffix}` via [`crate::platform::paths::env_var`].
pub fn env_usize(suffix: &str, default: usize) -> usize {
    crate::platform::paths::env_var(suffix)
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

/// Parse a positive seconds duration from an operator env var, identified by
/// its bare suffix. Reads `BERTH_{suffix}` via [`crate::platform::paths::env_var`].
pub fn env_duration_secs(suffix: &str, default_secs: u64) -> Duration {
    Duration::from_secs(
        crate::platform::paths::env_var(suffix)
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default_secs),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn env_usize_uses_default_for_missing_invalid_and_zero() {
        // `env_usize` takes a bare suffix and only reads BERTH_.
        temp_env::with_vars_unset(
            [
                "BERTH_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
                "CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
            ],
            || {
                assert_eq!(env_usize("WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
            },
        );
        temp_env::with_var(
            "BERTH_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
            Some("nope"),
            || {
                assert_eq!(env_usize("WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
            },
        );
        temp_env::with_var("BERTH_WORKSPACE_UPLOAD_MAX_CONCURRENCY", Some("0"), || {
            assert_eq!(env_usize("WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
        });
    }

    #[test]
    fn env_usize_reads_only_berth_prefix() {
        // Legacy CODEG_ alone is ignored after the hard-cut.
        temp_env::with_vars_unset(["BERTH_WORKSPACE_ZIP_MAX_CONCURRENCY"], || {
            temp_env::with_var("CODEG_WORKSPACE_ZIP_MAX_CONCURRENCY", Some("7"), || {
                assert_eq!(env_usize("WORKSPACE_ZIP_MAX_CONCURRENCY", 4), 4);
            });
        });
        // BERTH_ is the only effective value.
        temp_env::with_var("BERTH_WORKSPACE_ZIP_MAX_CONCURRENCY", Some("9"), || {
            temp_env::with_var("CODEG_WORKSPACE_ZIP_MAX_CONCURRENCY", Some("7"), || {
                assert_eq!(env_usize("WORKSPACE_ZIP_MAX_CONCURRENCY", 4), 9);
            });
        });
    }

    #[tokio::test]
    async fn ticket_is_single_use_and_expires() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_millis(20));
        let ticket = manager
            .issue_download_ticket(DownloadTicketSpec {
                root_path: PathBuf::from("/tmp/root"),
                target_path: PathBuf::from("/tmp/root/file.txt"),
                relative_path: "file.txt".to_string(),
                kind: DownloadKind::File,
                filename: "file.txt".to_string(),
            })
            .await;
        let ticket = ticket.unwrap();
        assert!(manager
            .consume_download_ticket(&ticket.ticket)
            .await
            .is_some());
        assert!(manager
            .consume_download_ticket(&ticket.ticket)
            .await
            .is_none());

        let expired = manager
            .issue_download_ticket(DownloadTicketSpec {
                root_path: PathBuf::from("/tmp/root"),
                target_path: PathBuf::from("/tmp/root/old.txt"),
                relative_path: "old.txt".to_string(),
                kind: DownloadKind::File,
                filename: "old.txt".to_string(),
            })
            .await;
        let expired = expired.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(manager
            .consume_download_ticket(&expired.ticket)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn cancel_marks_token_and_removes_entry() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60));
        let (id, token) = manager.register_transfer().await;
        assert!(!token.is_cancelled());
        assert!(manager.cancel(&id).await);
        assert!(token.is_cancelled());
        assert!(!manager.cancel(&id).await);
    }
}
