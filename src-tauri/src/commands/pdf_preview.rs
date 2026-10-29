use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{State, WebviewWindow};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::app_error::AppCommandError;
// Desktop Tauri manages `WorkspaceResourceLeaseStore` directly (see lib.rs
// `.manage(workspace_resources)`). It does NOT manage `AppState` — that Arc is
// only built for the embedded web server / codeg-server. These commands must
// inject the store itself or open_local_pdf_source fails at state resolution
// before any file IO runs.
use crate::workspace_state::resource::{
    ResourceAccess, ResourceLeaseSpec, ResourcePurpose, SourceVersion, WorkspaceResourceLeaseStore,
};

const MAX_RANGE_BYTES: u64 = 256 * 1024;

fn validate_range(begin: u64, end: u64, length: u64) -> Result<usize, AppCommandError> {
    if begin >= end || end > length || end - begin > MAX_RANGE_BYTES {
        return Err(AppCommandError::invalid_input("Invalid PDF byte range"));
    }
    Ok((end - begin) as usize)
}

fn local_version(metadata: &std::fs::Metadata) -> SourceVersion {
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    SourceVersion::LocalFile {
        length: metadata.len(),
        modified_ns,
        file_id: crate::versioned_file_responder::metadata_file_id(metadata),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSourceOpened {
    source_id: String,
    length: u64,
    source_version: String,
}

#[tauri::command]
pub async fn open_local_pdf_source(
    window: WebviewWindow,
    root_path: String,
    path: String,
    resources: State<'_, Arc<WorkspaceResourceLeaseStore>>,
) -> Result<PdfSourceOpened, AppCommandError> {
    let target = resolve_workspace_file_target(&root_path, &path)?;
    let canonical_root = std::fs::canonicalize(root_path).map_err(AppCommandError::io)?;
    let canonical_target = std::fs::canonicalize(target).map_err(AppCommandError::io)?;
    let metadata = std::fs::metadata(&canonical_target).map_err(AppCommandError::io)?;
    let version = local_version(&metadata);
    let issued = resources
        .issue(ResourceLeaseSpec {
            purpose: ResourcePurpose::LocalPdfSource,
            access: ResourceAccess::ReusablePreview,
            canonical_root,
            canonical_target,
            owner: window.label().to_string(),
            source_version: Some(version.clone()),
        })
        .await?;
    Ok(PdfSourceOpened {
        source_id: issued.id,
        length: metadata.len(),
        source_version: format!("{:?}", version),
    })
}

#[tauri::command]
pub async fn read_local_pdf_range(
    window: WebviewWindow,
    source_id: String,
    begin: u64,
    end: u64,
    resources: State<'_, Arc<WorkspaceResourceLeaseStore>>,
) -> Result<tauri::ipc::Response, AppCommandError> {
    let source = resources
        .resolve(&source_id, ResourcePurpose::LocalPdfSource, window.label())
        .await?;
    let mut file = tokio::fs::File::open(&source.canonical_target)
        .await
        .map_err(AppCommandError::io)?;
    let metadata = file.metadata().await.map_err(AppCommandError::io)?;
    if source.source_version.as_ref() != Some(&local_version(&metadata)) {
        return Err(AppCommandError::invalid_input("PDF source changed"));
    }
    let size = validate_range(begin, end, metadata.len())?;
    file.seek(std::io::SeekFrom::Start(begin))
        .await
        .map_err(AppCommandError::io)?;
    let mut bytes = vec![0; size];
    file.read_exact(&mut bytes)
        .await
        .map_err(AppCommandError::io)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn close_local_pdf_source(
    window: WebviewWindow,
    source_id: String,
    resources: State<'_, Arc<WorkspaceResourceLeaseStore>>,
) -> Result<(), AppCommandError> {
    if resources
        .resolve(&source_id, ResourcePurpose::LocalPdfSource, window.label())
        .await
        .is_ok()
    {
        resources.revoke(&source_id).await;
    }
    Ok(())
}

// ── Path safety helpers (inlined from former web/handlers/workspace_files.rs) ──

fn validate_relative_components(rel: &Path) -> Result<(), AppCommandError> {
    use std::path::Component;
    if rel.is_absolute() {
        return Err(AppCommandError::invalid_input("Path must be relative"));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppCommandError::invalid_input("Path cannot contain '..'"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppCommandError::invalid_input("Invalid path component"));
            }
        }
    }
    Ok(())
}

fn resolve_relative_path(root: &Path, rel: &str) -> Result<PathBuf, AppCommandError> {
    let rel_path = Path::new(rel);
    validate_relative_components(rel_path)?;
    Ok(root.join(rel_path))
}

fn ensure_inside_root(root: &Path, target: &Path) -> Result<(), AppCommandError> {
    let canonical_root = std::fs::canonicalize(root).map_err(AppCommandError::io)?;
    let canonical_target = std::fs::canonicalize(target).map_err(AppCommandError::io)?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(AppCommandError::invalid_input(
            "Resolved path escapes workspace root",
        ));
    }
    Ok(())
}

fn ensure_workspace_root(root: &Path) -> Result<(), AppCommandError> {
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found(
            "Workspace folder does not exist",
        ));
    }
    Ok(())
}

fn resolve_workspace_file_target(
    root_path: &str,
    rel_path: &str,
) -> Result<PathBuf, AppCommandError> {
    let root = PathBuf::from(root_path);
    ensure_workspace_root(&root)?;
    let target = resolve_relative_path(&root, rel_path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    ensure_inside_root(&root, &target)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::validate_range;

    #[test]
    fn validates_bounded_pdf_ranges() {
        assert_eq!(
            validate_range(0, 256 * 1024, 300 * 1024).unwrap(),
            256 * 1024
        );
        assert!(validate_range(10, 10, 20).is_err());
        assert!(validate_range(0, 300 * 1024, 300 * 1024).is_err());
        assert!(validate_range(0, 21, 20).is_err());
    }
}
