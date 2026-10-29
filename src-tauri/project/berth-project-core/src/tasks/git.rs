//! 调 `git` 命令行（任务状态从 git 派生，不引第二套 git 实现）。

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use super::{TaskError, TaskResult};

pub(crate) fn run(root: &Path, args: &[&str]) -> Option<Output> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()
}

/// 成功时返回去掉首尾空白的 stdout。
pub(crate) fn stdout(root: &Path, args: &[&str]) -> Option<String> {
    let output = run(root, args)?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub(crate) fn succeeds(root: &Path, args: &[&str]) -> bool {
    run(root, args).is_some_and(|output| output.status.success())
}

/// 失败时把 stderr 带进错误。
pub(crate) fn checked(root: &Path, args: &[&str]) -> TaskResult<String> {
    let output =
        run(root, args).ok_or_else(|| TaskError::new("git_failed", "git is not available"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(TaskError::new(
            "git_failed",
            format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
}

/// `git worktree list --porcelain`；不是 git 仓库时为空。第一项是 git 的主 worktree。
pub(crate) fn worktrees(root: &Path) -> Vec<Worktree> {
    let Some(listing) = stdout(root, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    // 项目可以是仓库的子目录：git 列的是仓库根，换成各 checkout 里的同一子目录。
    let prefix = stdout(root, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    listing
        .split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut branch = None;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = Some(PathBuf::from(value));
                } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(value.to_owned());
                }
            }
            path.map(|path| Worktree {
                path: if prefix.is_empty() {
                    path
                } else {
                    path.join(&prefix)
                },
                branch,
            })
        })
        .collect()
}

pub(crate) fn current_branch(root: &Path) -> Option<String> {
    stdout(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|name| !name.is_empty() && name != "HEAD")
}

pub(crate) fn branch_exists(root: &Path, branch: &str) -> bool {
    succeeds(
        root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
}

pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canonical(a) == canonical(b)
}
