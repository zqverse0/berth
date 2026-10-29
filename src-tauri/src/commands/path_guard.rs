use std::path::{Component, Path, PathBuf};

use crate::app_error::AppCommandError;

pub(crate) fn resolve_tree_path(root: &Path, rel_path: &str) -> Result<PathBuf, AppCommandError> {
    let rel = Path::new(rel_path);
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

    Ok(root.join(rel))
}

/// Lexically normalize `path` by collapsing `.` and `..` segments without
/// touching the filesystem. Mirrors Go's `filepath.Clean` semantics.
///
/// - `Component::CurDir` (`.`) segments are dropped.
/// - `Component::ParentDir` (`..`) pops the previous `Normal` component. When
///   the previous component is a root (`RootDir` / `Prefix`) it is a no-op so
///   absolute paths cannot escape below `/`. When the accumulator is empty or
///   already ends in another `..`, the `..` is preserved verbatim so callers
///   can still detect relative-path escapes lexically.
/// - Consecutive separators and trailing separators are already normalized by
///   `Path::components`.
/// - An empty input becomes `PathBuf::from(".")` (matching `filepath.Clean("")`).
///
/// This is the workspace-boundary primitive used by
/// `ensure_path_in_workspace`; it performs zero filesystem I/O and therefore
/// permits symlinks whose targets live outside the workspace while still
/// rejecting `..`-based lexical escapes.
pub(crate) fn lexical_clean(path: &Path) -> PathBuf {
    let mut out: Vec<Component<'_>> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {
                    // At an absolute root: `..` collapses to a no-op so we
                    // cannot fabricate a path above `/`.
                }
                _ => out.push(comp),
            },
            other => out.push(other),
        }
    }
    if out.is_empty() {
        PathBuf::from(".")
    } else {
        out.iter().collect()
    }
}

/// Lexical workspace-boundary check.
///
/// Prevents API inputs from escaping the workspace root via `..` or absolute
/// paths, without following symlinks. Physical containment of a symlink's
/// target is deliberately NOT part of this check: workspace-internal symlinks
/// pointing outside are a legitimate content pattern (shared dotfiles,
/// worktrees, cross-repo tool state). Write-side defenses (`symlink_metadata`
/// in `save_file_content`) remain responsible for refusing to overwrite a
/// symlink's target, and `open_no_follow` guards read-side TOCTOU on the leaf.
pub(crate) fn ensure_path_in_workspace(root: &Path, target: &Path) -> Result<(), AppCommandError> {
    let root_clean = lexical_clean(root);
    let target_abs = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let target_clean = lexical_clean(&target_abs);
    if !target_clean.starts_with(&root_clean) {
        return Err(AppCommandError::invalid_input(
            "Path escapes workspace root",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod lexical_boundary_tests {
    use super::*;

    #[test]
    fn lexical_clean_handles_dotdot() {
        // `a/b/..` collapses to `a`, and the trailing `c` survives.
        assert_eq!(lexical_clean(Path::new("a/b/../c")), PathBuf::from("a/c"));
        // Leading `./` and interior `./` are dropped.
        assert_eq!(lexical_clean(Path::new("./a/./b")), PathBuf::from("a/b"));
        // Trailing separators / redundant separators are normalized by
        // `Path::components`, so `a/b/` becomes `a/b`.
        assert_eq!(lexical_clean(Path::new("a/b/")), PathBuf::from("a/b"));
        // The empty path canonicalizes to `.` (Go's `filepath.Clean("")`).
        assert_eq!(lexical_clean(Path::new("")), PathBuf::from("."));
    }

    #[cfg(unix)]
    #[test]
    fn lexical_clean_stops_dotdot_at_absolute_root() {
        // `..` past the root of an absolute path must be a no-op so callers
        // cannot fabricate `/etc` from `/w/../..`.
        assert_eq!(
            lexical_clean(Path::new("/w/../../etc")),
            PathBuf::from("/etc"),
        );
        assert_eq!(lexical_clean(Path::new("/../..")), PathBuf::from("/"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_lexical_dotdot_escape() {
        // A relative `..` chain that lexically resolves outside the root must
        // be refused without any filesystem I/O.
        let root = Path::new("/workspace");
        let err = ensure_path_in_workspace(root, Path::new("../etc/passwd"))
            .expect_err("lexical escape must be rejected");
        assert!(
            err.to_string().contains("escapes workspace root"),
            "error should identify a workspace escape, got: {err}",
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_absolute_path_outside_root() {
        let root = Path::new("/workspace");
        let err = ensure_path_in_workspace(root, Path::new("/etc/passwd"))
            .expect_err("absolute path outside root must be rejected");
        assert!(
            err.to_string().contains("escapes workspace root"),
            "error should identify a workspace escape, got: {err}",
        );
    }

    #[cfg(unix)]
    #[test]
    fn accepts_normal_relative_path() {
        // A well-formed relative path stays inside the root and is accepted
        // without touching the filesystem (target does not need to exist).
        let root = Path::new("/workspace");
        assert!(ensure_path_in_workspace(root, Path::new("src/main.rs")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn accepts_interior_dotdot_that_stays_inside_root() {
        // `a/../b` under the root collapses to `<root>/b`, which is still a
        // sub-path of `<root>` and therefore allowed.
        let root = Path::new("/workspace");
        assert!(
            ensure_path_in_workspace(root, Path::new("a/../b")).is_ok(),
            "interior `..` that stays inside root must be accepted",
        );
    }

    #[cfg(unix)]
    #[test]
    fn accepts_nonexistent_target() {
        // Lexical ownership does not require the target to exist on disk
        // (the old canonicalize-based check failed on missing paths).
        let root = Path::new("/workspace");
        assert!(
            ensure_path_in_workspace(root, Path::new("no/such/file.rs")).is_ok(),
            "missing targets that stay lexically inside root must be accepted",
        );
    }
}
