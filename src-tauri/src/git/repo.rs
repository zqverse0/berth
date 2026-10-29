//! Single source of truth for "is this path a git repository?" detection.
//!
//! The check is deliberately strict: the exact path must contain a `.git`
//! entry (directory for regular repos, file for linked worktrees and
//! submodules). We do **not** walk up to ancestors.
//!
//! Rationale: codeg scopes every workspace-facing feature (file tree
//! watcher, git changes panel, log panel) to the directory the user opens.
//! If one code path walks up and another doesn't, the UI falls into a
//! "schizophrenic" state where some panels see a repo and others don't.
//! Keeping the primitive strict forces every consumer onto the same
//! interpretation.
//!
//! Bare repositories are intentionally not supported — they have no working
//! tree, which makes them an unusual target for a workspace-oriented editor.

use std::{fs, io::ErrorKind, path::Path};

use crate::app_error::AppCommandError;

/// Returns true when `path` is the root of a git working tree.
///
/// `.git` may be a directory (normal repo) or a file (worktree/submodule
/// pointer). `Path::exists` treats both as present.
pub fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

/// Preflight guard for git commands. Short-circuits with a typed error code
/// when the target path is not a git working tree, so callers avoid locale-
/// dependent stderr parsing for the most common "wrong folder" failure.
pub fn ensure_git_repo(path: &str) -> Result<(), AppCommandError> {
    let root = Path::new(path);

    let root_meta = fs::metadata(root).map_err(|err| match err.kind() {
        ErrorKind::NotFound => {
            AppCommandError::not_found(format!("Workspace path does not exist: {path}"))
        }
        ErrorKind::PermissionDenied => {
            AppCommandError::permission_denied(format!("Cannot access workspace path: {path}"))
                .with_detail(err.to_string())
        }
        _ => AppCommandError::io(err)
            .with_detail(format!("Failed to inspect workspace path: {path}")),
    })?;

    if !root_meta.is_dir() {
        return Err(AppCommandError::invalid_input(format!(
            "Workspace path is not a directory: {path}"
        )));
    }

    let git_path = root.join(".git");
    match fs::metadata(&git_path) {
        Ok(_) => Ok(()),
        Err(err) => match err.kind() {
            ErrorKind::NotFound => Err(AppCommandError::not_a_git_repository(format!(
                "Not a Git repository: {path}"
            ))),
            ErrorKind::PermissionDenied => Err(AppCommandError::permission_denied(format!(
                "Cannot access Git metadata: {}",
                git_path.display()
            ))
            .with_detail(err.to_string())),
            _ => Err(AppCommandError::io(err).with_detail(format!(
                "Failed to inspect Git metadata: {}",
                git_path.display()
            ))),
        },
    }
}
