//! 调 `git` 命令行（任务状态从 git 派生，不引第二套 git 实现）。

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

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

/// 只读查询（log、diff、worktree list 等）按引用指纹缓存：结果只取决于各分支 / HEAD 指向哪个提交和
/// 有哪些 worktree，这些都没变就不再起 git。任务页每 2–5 秒轮询，每个任务约 9 个 git 进程，
/// 不缓存时看任务页约占 21% CPU。工作区内容相关的查询（`status`）不要走这里。
pub(crate) fn stdout_cached(root: &Path, args: &[&str]) -> Option<String> {
    let Some(fingerprint) = ref_fingerprint(root) else {
        return stdout(root, args);
    };
    let key = format!("{}\0{}\0{fingerprint:x}", root.display(), args.join("\0"));
    let slot = {
        let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        // 旧指纹的条目不会再命中；涨到上限整体清掉即可。
        if cache.len() > 2048 {
            cache.clear();
        }
        cache.entry(key).or_default().clone()
    };
    // 同一查询并发时（views 按任务并行）只跑一次 git，其余等结果。
    let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(value) = slot.as_ref() {
        return value.clone();
    }
    let value = stdout(root, args);
    *slot = Some(value.clone());
    value
}

type Slot = Arc<Mutex<Option<Option<String>>>>;
static CACHE: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(Default::default);
static GIT_DIRS: LazyLock<Mutex<HashMap<PathBuf, (PathBuf, PathBuf)>>> =
    LazyLock::new(Default::default);

/// 读 `.git` 里记录 HEAD、分支和 worktree 的小文件算出的内容指纹（不起进程）；
/// 任何提交、切分支、增删 worktree 都会改其中的文件。
fn ref_fingerprint(root: &Path) -> Option<u64> {
    let (git_dir, common) = git_dirs(root)?;
    let mut hasher = DefaultHasher::new();
    let mut add = |path: &Path| {
        path.hash(&mut hasher);
        fs::read(path).ok().hash(&mut hasher);
    };
    add(&git_dir.join("HEAD"));
    add(&common.join("HEAD"));
    add(&common.join("packed-refs"));
    add(&common.join("reftable/tables.list"));
    let mut stack = vec![common.join("refs")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                stack.push(path);
            } else {
                add(&path);
            }
        }
    }
    let mut worktrees: Vec<PathBuf> = fs::read_dir(common.join("worktrees"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    worktrees.sort();
    for worktree in worktrees {
        add(&worktree.join("HEAD"));
        add(&worktree.join("gitdir"));
    }
    Some(hasher.finish())
}

/// （本 checkout 的 git 目录，共享的 common 目录）；只解析一次。
fn git_dirs(root: &Path) -> Option<(PathBuf, PathBuf)> {
    if let Some(dirs) = GIT_DIRS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(root)
    {
        return Some(dirs.clone());
    }
    let out = stdout(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
    )?;
    let mut lines = out.lines();
    let dirs = (PathBuf::from(lines.next()?), PathBuf::from(lines.next()?));
    GIT_DIRS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(root.to_path_buf(), dirs.clone());
    Some(dirs)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
}

/// `git worktree list --porcelain`；不是 git 仓库时为空。第一项是 git 的主 worktree。
pub(crate) fn worktrees(root: &Path) -> Vec<Worktree> {
    let Some(listing) = stdout_cached(root, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    // 项目可以是仓库的子目录：git 列的是仓库根，换成各 checkout 里的同一子目录。
    let prefix = stdout_cached(root, &["rev-parse", "--show-prefix"]).unwrap_or_default();
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
    stdout_cached(root, &["rev-parse", "--abbrev-ref", "HEAD"])
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
