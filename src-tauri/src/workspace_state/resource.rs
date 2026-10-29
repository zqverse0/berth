use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::app_error::AppCommandError;

const DOWNLOAD_TTL: Duration = Duration::from_secs(60);
const PREVIEW_IDLE_TTL: Duration = Duration::from_secs(1_800);
const PREVIEW_ABSOLUTE_TTL: Duration = Duration::from_secs(28_800);
const MAX_LIVE_LEASES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceAccess {
    OneShot,
    ReusablePreview,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourcePurpose {
    Download,
    Backup,
    PdfPreview,
    LocalPdfSource,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourceVersion {
    HttpEntity {
        etag: String,
        length: u64,
    },
    LocalFile {
        length: u64,
        modified_ns: u128,
        file_id: Option<u128>,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct LeaseLimits {
    pub idle_ttl: Duration,
    pub absolute_ttl: Duration,
    pub max_live: usize,
}

#[derive(Clone, Debug)]
pub struct ResourceLeaseSpec {
    pub purpose: ResourcePurpose,
    pub access: ResourceAccess,
    pub canonical_root: PathBuf,
    pub canonical_target: PathBuf,
    pub owner: String,
    pub source_version: Option<SourceVersion>,
}

#[derive(Clone, Debug)]
pub struct ResourceLeaseIssued {
    pub id: String,
    pub expires_at_ms: i64,
}

struct WorkspaceResourceLease {
    spec: ResourceLeaseSpec,
    download: Option<DownloadLeaseData>,
    issued_at: Instant,
    last_accessed_at: Instant,
}

pub struct WorkspaceResourceLeaseStore {
    entries: Mutex<HashMap<String, WorkspaceResourceLease>>,
    limits: LeaseLimits,
    download_ttl: Duration,
}

#[derive(Clone, Debug)]
pub(crate) struct DownloadLeaseData {
    pub relative_path: String,
    pub is_directory: bool,
    pub filename: String,
}

impl WorkspaceResourceLeaseStore {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            limits: LeaseLimits {
                idle_ttl: PREVIEW_IDLE_TTL,
                absolute_ttl: PREVIEW_ABSOLUTE_TTL,
                max_live: MAX_LIVE_LEASES,
            },
            download_ttl: DOWNLOAD_TTL,
        }
    }

    pub fn new_for_tests(limits: LeaseLimits) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            download_ttl: limits.idle_ttl,
            limits,
        }
    }

    pub async fn issue(
        &self,
        spec: ResourceLeaseSpec,
    ) -> Result<ResourceLeaseIssued, AppCommandError> {
        self.issue_inner(spec, None).await
    }

    pub(crate) async fn issue_download(
        &self,
        spec: ResourceLeaseSpec,
        download: DownloadLeaseData,
    ) -> Result<ResourceLeaseIssued, AppCommandError> {
        self.issue_inner(spec, Some(download)).await
    }

    async fn issue_inner(
        &self,
        spec: ResourceLeaseSpec,
        download: Option<DownloadLeaseData>,
    ) -> Result<ResourceLeaseIssued, AppCommandError> {
        let now = Instant::now();
        let mut entries = self.entries.lock().await;
        self.cleanup_expired_locked(&mut entries, now);
        if entries.len() >= self.limits.max_live {
            return Err(AppCommandError::resource_capacity(
                "Workspace resource capacity has been reached",
            ));
        }

        let ttl = self.idle_ttl_for(&spec).min(self.absolute_ttl_for(&spec));
        let id = uuid::Uuid::new_v4().simple().to_string();
        entries.insert(
            id.clone(),
            WorkspaceResourceLease {
                spec,
                download,
                issued_at: now,
                last_accessed_at: now,
            },
        );

        Ok(ResourceLeaseIssued {
            id,
            expires_at_ms: unix_time_after(ttl),
        })
    }

    pub(crate) async fn consume_download(
        &self,
        id: &str,
        owner: &str,
    ) -> Result<(ResourceLeaseSpec, DownloadLeaseData, Instant), AppCommandError> {
        let now = Instant::now();
        let mut entries = self.entries.lock().await;
        self.cleanup_expired_locked(&mut entries, now);

        let is_match = entries.get(id).is_some_and(|lease| {
            lease.spec.purpose == ResourcePurpose::Download
                && lease.spec.access == ResourceAccess::OneShot
                && lease.spec.owner == owner
                && lease.download.is_some()
        });
        if !is_match {
            return Err(resource_not_found());
        }
        let lease = entries.remove(id).expect("matched lease must exist");
        let expires_at = lease.issued_at + self.absolute_ttl_for(&lease.spec);
        Ok((
            lease.spec,
            lease.download.expect("matched download data must exist"),
            expires_at,
        ))
    }

    pub async fn resolve(
        &self,
        id: &str,
        purpose: ResourcePurpose,
        owner: &str,
    ) -> Result<ResourceLeaseSpec, AppCommandError> {
        let now = Instant::now();
        let mut entries = self.entries.lock().await;
        self.cleanup_expired_locked(&mut entries, now);

        let Some(lease) = entries.get_mut(id) else {
            return Err(resource_not_found());
        };
        if lease.spec.purpose != purpose || lease.spec.owner != owner {
            return Err(resource_not_found());
        }

        let spec = lease.spec.clone();
        match lease.spec.access {
            ResourceAccess::OneShot => {
                entries.remove(id);
            }
            ResourceAccess::ReusablePreview => {
                lease.last_accessed_at = now;
            }
        }
        Ok(spec)
    }

    pub async fn revoke(&self, id: &str) -> bool {
        self.entries.lock().await.remove(id).is_some()
    }

    pub async fn cleanup_expired(&self) {
        let now = Instant::now();
        let mut entries = self.entries.lock().await;
        self.cleanup_expired_locked(&mut entries, now);
    }

    fn cleanup_expired_locked(
        &self,
        entries: &mut HashMap<String, WorkspaceResourceLease>,
        now: Instant,
    ) {
        entries.retain(|_, lease| !self.is_expired(lease, now));
    }

    fn is_expired(&self, lease: &WorkspaceResourceLease, now: Instant) -> bool {
        now.duration_since(lease.issued_at) >= self.absolute_ttl_for(&lease.spec)
            || now.duration_since(lease.last_accessed_at) >= self.idle_ttl_for(&lease.spec)
    }

    fn idle_ttl_for(&self, spec: &ResourceLeaseSpec) -> Duration {
        match spec.access {
            ResourceAccess::OneShot => self.download_ttl,
            ResourceAccess::ReusablePreview => self.limits.idle_ttl,
        }
    }

    fn absolute_ttl_for(&self, spec: &ResourceLeaseSpec) -> Duration {
        match spec.access {
            ResourceAccess::OneShot => self.download_ttl,
            ResourceAccess::ReusablePreview => self.limits.absolute_ttl,
        }
    }
}

impl Default for WorkspaceResourceLeaseStore {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_time_after(ttl: Duration) -> i64 {
    SystemTime::now()
        .checked_add(ttl)
        .unwrap_or(SystemTime::now())
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn resource_not_found() -> AppCommandError {
    AppCommandError::not_found("Workspace resource is invalid or expired")
}

#[cfg(test)]
impl ResourceLeaseSpec {
    fn test_file(access: ResourceAccess) -> Self {
        Self {
            purpose: if access == ResourceAccess::OneShot {
                ResourcePurpose::Download
            } else {
                ResourcePurpose::PdfPreview
            },
            access,
            canonical_root: PathBuf::from("/workspace"),
            canonical_target: PathBuf::from("/workspace/report.pdf"),
            owner: "test-window".to_string(),
            source_version: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::app_error::AppErrorCode;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn one_shot_is_removed_after_first_resolve() {
        let store = WorkspaceResourceLeaseStore::new_for_tests(LeaseLimits {
            idle_ttl: Duration::from_secs(60),
            absolute_ttl: Duration::from_secs(600),
            max_live: 2,
        });
        let issued = store
            .issue(ResourceLeaseSpec::test_file(ResourceAccess::OneShot))
            .await
            .unwrap();

        assert!(store
            .resolve(&issued.id, ResourcePurpose::Download, "test-window")
            .await
            .is_ok());
        assert_eq!(
            store
                .resolve(&issued.id, ResourcePurpose::Download, "test-window")
                .await
                .unwrap_err()
                .code,
            AppErrorCode::NotFound,
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reusable_preview_touches_idle_but_not_absolute_expiry() {
        let store = WorkspaceResourceLeaseStore::new_for_tests(LeaseLimits {
            idle_ttl: Duration::from_secs(60),
            absolute_ttl: Duration::from_secs(120),
            max_live: 2,
        });
        let issued = store
            .issue(ResourceLeaseSpec::test_file(
                ResourceAccess::ReusablePreview,
            ))
            .await
            .unwrap();

        tokio::time::advance(Duration::from_secs(50)).await;
        store
            .resolve(&issued.id, ResourcePurpose::PdfPreview, "test-window")
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(50)).await;
        store
            .resolve(&issued.id, ResourcePurpose::PdfPreview, "test-window")
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(21)).await;
        assert!(store
            .resolve(&issued.id, ResourcePurpose::PdfPreview, "test-window")
            .await
            .is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn issue_returns_capacity_error_without_evicting_a_live_lease() {
        let store = WorkspaceResourceLeaseStore::new_for_tests(LeaseLimits {
            idle_ttl: Duration::from_secs(60),
            absolute_ttl: Duration::from_secs(600),
            max_live: 1,
        });
        let first = store
            .issue(ResourceLeaseSpec::test_file(
                ResourceAccess::ReusablePreview,
            ))
            .await
            .unwrap();

        assert_eq!(
            store
                .issue(ResourceLeaseSpec::test_file(
                    ResourceAccess::ReusablePreview,
                ))
                .await
                .unwrap_err()
                .code,
            AppErrorCode::ResourceCapacity,
        );
        assert!(store
            .resolve(&first.id, ResourcePurpose::PdfPreview, "test-window")
            .await
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn revoke_reports_whether_the_lease_existed() {
        let store = WorkspaceResourceLeaseStore::new_for_tests(LeaseLimits {
            idle_ttl: Duration::from_secs(60),
            absolute_ttl: Duration::from_secs(600),
            max_live: 2,
        });
        let issued = store
            .issue(ResourceLeaseSpec::test_file(
                ResourceAccess::ReusablePreview,
            ))
            .await
            .unwrap();

        assert!(store.revoke(&issued.id).await);
        assert!(!store.revoke(&issued.id).await);
    }
}
