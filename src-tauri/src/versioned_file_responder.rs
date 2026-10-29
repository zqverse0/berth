use std::path::Path;

use crate::app_error::AppCommandError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileVersion {
    pub etag: String,
    pub length: u64,
    pub modified_ns: u128,
    pub file_id: Option<u128>,
}

pub async fn snapshot(path: &Path) -> Result<FileVersion, AppCommandError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(AppCommandError::io)?;
    Ok(version_from_metadata(&metadata))
}

fn version_from_metadata(metadata: &std::fs::Metadata) -> FileVersion {
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let file_id = metadata_file_id(metadata);
    FileVersion {
        etag: format!(
            "\"{:x}-{:x}-{:x}\"",
            metadata.len(),
            modified_ns,
            file_id.unwrap_or_default()
        ),
        length: metadata.len(),
        modified_ns,
        file_id,
    }
}

#[cfg(unix)]
pub(crate) fn metadata_file_id(metadata: &std::fs::Metadata) -> Option<u128> {
    use std::os::unix::fs::MetadataExt;

    Some(metadata.ino() as u128)
}

#[cfg(not(unix))]
pub(crate) fn metadata_file_id(_metadata: &std::fs::Metadata) -> Option<u128> {
    None
}
