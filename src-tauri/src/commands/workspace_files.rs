use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{Match, WalkBuilder};
use serde::Serialize;
use tokio::sync::Semaphore;
use walkdir::WalkDir;

use crate::app_error::AppCommandError;
use crate::commands::path_guard::{ensure_path_in_workspace, resolve_tree_path};

/// 文件树、搜索和 workspace watcher 共用的硬排除目录。
///
/// 这些目录通常是生成元数据或依赖树。统一维护可以避免 UI 展示 watcher
/// 永远不会观察的路径，也避免搜索再次遍历同一批高成本目录。
pub(crate) const WORKSPACE_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "target",
    ".venv",
    "__pycache__",
];

/// 文件树、搜索和 workspace watcher 共用的硬排除文件名。
///
/// 除 `.DS_Store` 外是 Office 套件打开文档时放在旁边的锁文件：
/// Microsoft Office 的 `~$xxx.docx`、WPS 的 `.~xxx.docx`、LibreOffice 的
/// `.~lock.xxx.docx#`。它们只有几百字节、不是文档，却带着文档扩展名，
/// 列出来会被当成文档预览并报错。
pub(crate) fn is_ignored_workspace_file_name(name: &str) -> bool {
    name == ".DS_Store" || name.starts_with("~$") || name.starts_with(".~")
}

/// Hard limit: refuse to open files larger than 50 MB in the text editor.
const FILE_OPEN_HARD_LIMIT: usize = 50_000_000;

/// Save limit: refuse to save content larger than 50 MB.
const FILE_SAVE_HARD_LIMIT: usize = 50_000_000;

const FILE_BASE64_DEFAULT_MAX_BYTES: usize = 20_000_000;

const FILE_BASE64_MAX_BYTES: usize = 100_000_000;

const FILE_IO_MAX_CONCURRENT_OPS: usize = 8;

static FILE_IO_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(FILE_IO_MAX_CONCURRENT_OPS));

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileTreeNode {
    File {
        name: String,
        path: String,
        /// Present only when this node itself is a symlink; holds the raw
        /// `readlink` target (relative form preserved). Informational only —
        /// does not change open/expand behaviour.
        #[serde(rename = "linkTarget", skip_serializing_if = "Option::is_none")]
        link_target: Option<String>,
        /// 被 `.gitignore` / `.git/info/exclude` 忽略（仍列出，前端淡化显示）。
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        ignored: bool,
    },
    Dir {
        name: String,
        path: String,
        children: Vec<FileTreeNode>,
        /// Same semantics as [`FileTreeNode::File::link_target`].
        #[serde(rename = "linkTarget", skip_serializing_if = "Option::is_none")]
        link_target: Option<String>,
        /// 目录自身是 git 仓库根（含 `.git`，目录或文件——嵌套仓库 /
        /// submodule / linked worktree 的边界）。前端据此把该目录显示为
        /// 可折叠的独立子项目。
        #[serde(rename = "isRepo")]
        is_repo: bool,
        /// 同 [`FileTreeNode::File::ignored`]；被忽略目录下的条目也都标记。
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        ignored: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryKind {
    File,
    Dir,
}

/// A flat workspace entry produced by `list_workspace_files`. Unlike the nested
/// `FileTreeNode`, this is a single flat record suited to fuzzy file search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceFileEntry {
    pub name: String,
    /// Path relative to the workspace root, always forward-slashed.
    pub path: String,
    pub kind: WorkspaceEntryKind,
}

#[derive(Debug, Serialize)]
pub struct FilePreviewContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct FileEditContent {
    pub path: String,
    pub content: String,
    pub etag: String,
    pub mtime_ms: Option<i64>,
    pub readonly: bool,
    pub line_ending: String,
}

#[derive(Debug, Serialize)]
pub struct FileSaveResult {
    pub path: String,
    pub etag: String,
    pub mtime_ms: Option<i64>,
    pub readonly: bool,
    pub line_ending: String,
}

fn validate_new_name(new_name: &str) -> Result<&str, AppCommandError> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("New name cannot be empty"));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(AppCommandError::invalid_input("Invalid file name"));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppCommandError::invalid_input(
            "New name cannot contain path separators",
        ));
    }
    Ok(trimmed)
}

fn file_mtime_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    let millis = elapsed.as_millis();
    if millis > i64::MAX as u128 {
        return Some(i64::MAX);
    }
    Some(millis as i64)
}

fn detect_line_ending(content: &[u8]) -> String {
    let mut has_lf = false;
    let mut has_crlf = false;

    for index in 0..content.len() {
        if content[index] != b'\n' {
            continue;
        }

        if index > 0 && content[index - 1] == b'\r' {
            has_crlf = true;
        } else {
            has_lf = true;
        }

        if has_lf && has_crlf {
            return "mixed".to_string();
        }
    }

    if has_crlf {
        "crlf".to_string()
    } else if has_lf {
        "lf".to_string()
    } else {
        "none".to_string()
    }
}

fn compute_etag(content: &[u8], metadata: &std::fs::Metadata) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    if let Some(mtime_ms) = file_mtime_ms(metadata) {
        mtime_ms.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// Classify a walk entry as a directory, following a single symlink hop when
/// the leaf itself is a symlink. Never call `metadata()` here: it follows the
/// entire chain and stalls on self-referential links (`ELOOP`). Dangling,
/// looping, or unreadable symlinks are treated as non-directories so traversal
/// never aborts.
fn entry_is_dir(file_type: std::fs::FileType, path: &Path) -> bool {
    if !file_type.is_symlink() {
        return file_type.is_dir();
    }
    let Ok(target) = std::fs::read_link(path) else {
        return false;
    };
    let resolved = if target.is_absolute() {
        target
    } else {
        match path.parent() {
            Some(parent) => parent.join(target),
            None => target,
        }
    };
    std::fs::symlink_metadata(&resolved)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

/// Raw `readlink` target for informational `linkTarget` fields. Returns
/// `None` for non-symlinks or when `readlink` fails.
fn read_link_target(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_symlink() {
        return None;
    }
    std::fs::read_link(path)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn read_text_full(target: &Path, hard_limit: usize) -> Result<String, AppCommandError> {
    let metadata = std::fs::metadata(target).map_err(AppCommandError::io)?;
    if metadata.len() > hard_limit as u64 {
        return Err(
            AppCommandError::invalid_input("File is too large to open in editor")
                .with_detail(format!("size={}, limit={}", metadata.len(), hard_limit)),
        );
    }

    let bytes = std::fs::read(target).map_err(AppCommandError::io)?;

    if bytes.iter().take(2_048).any(|b| *b == 0) {
        return Err(AppCommandError::invalid_input(
            "Binary files are not supported in preview",
        ));
    }

    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn atomic_write_text(path: &Path, bytes: &[u8]) -> Result<(), AppCommandError> {
    let parent = path.parent().ok_or_else(|| {
        AppCommandError::invalid_input("Cannot determine parent directory for target file")
            .with_detail(path.display().to_string())
    })?;
    if !parent.exists() {
        return Err(
            AppCommandError::not_found("Parent directory does not exist")
                .with_detail(parent.display().to_string()),
        );
    }

    let temp_path = parent.join(format!(
        ".berth-edit-{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let existing_permissions = std::fs::metadata(path).ok().map(|m| m.permissions());

    let write_result = (|| -> Result<(), AppCommandError> {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(AppCommandError::io)?;

        temp.write_all(bytes).map_err(AppCommandError::io)?;
        temp.sync_all().map_err(AppCommandError::io)?;

        if let Some(permissions) = existing_permissions {
            std::fs::set_permissions(&temp_path, permissions).map_err(AppCommandError::io)?;
        }

        replace_file(&temp_path, path)?;
        sync_directory(parent)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }

    write_result
}

#[cfg(unix)]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    std::fs::rename(temp_path, target_path).map_err(AppCommandError::io)
}

#[cfg(target_os = "windows")]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let src = to_wide(temp_path);
    let dst = to_wide(target_path);

    // SAFETY: pointers are valid and UTF-16 null-terminated for the duration of the call.
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if ok == 0 {
        return Err(
            AppCommandError::io_error("Failed to atomically replace file")
                .with_detail(std::io::Error::last_os_error().to_string()),
        );
    }

    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    std::fs::rename(temp_path, target_path).map_err(AppCommandError::io)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), AppCommandError> {
    let dir = std::fs::File::open(path).map_err(AppCommandError::io)?;
    dir.sync_all().map_err(AppCommandError::io)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), AppCommandError> {
    Ok(())
}

async fn run_file_io<T, F>(f: F) -> Result<T, AppCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppCommandError> + Send + 'static,
{
    let _permit = FILE_IO_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| AppCommandError::task_execution_failed("File I/O runtime is unavailable"))?;

    tokio::task::spawn_blocking(f).await.map_err(|e| {
        AppCommandError::task_execution_failed("File I/O task failed").with_detail(e.to_string())
    })?
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_home_directory() -> Result<String, AppCommandError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppCommandError::io_error("Could not determine home directory"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_directory_entries(path: String) -> Result<Vec<DirectoryEntry>, AppCommandError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppCommandError::io_error("Path is not a directory").with_detail(path));
    }

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    let read_dir = std::fs::read_dir(&root).map_err(|e| {
        AppCommandError::io_error("Failed to read directory").with_detail(e.to_string())
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // Follow symlinks: check if the resolved path is a directory
        let is_dir = if file_type.is_symlink() {
            entry.path().is_dir()
        } else {
            file_type.is_dir()
        };
        if !is_dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden directories (starting with '.')
        if name.starts_with('.') {
            continue;
        }
        let abs_path = entry.path().to_string_lossy().to_string();

        // Peek into subdirectory to check if it has child directories
        let has_children = match std::fs::read_dir(entry.path()) {
            Ok(sub) => sub.filter_map(|e| e.ok()).any(|e| {
                let ft = e.file_type().ok();
                let is_sub_dir = ft.is_some_and(|ft| {
                    if ft.is_symlink() {
                        e.path().is_dir()
                    } else {
                        ft.is_dir()
                    }
                });
                if !is_sub_dir {
                    return false;
                }
                let sub_name = e.file_name().to_string_lossy().to_string();
                !sub_name.starts_with('.')
            }),
            Err(_) => false,
        };

        entries.push(DirectoryEntry {
            name,
            path: abs_path,
            has_children,
        });
    }

    // Sort by name, case-insensitive
    entries.sort_by_key(|a| a.name.to_lowercase());

    Ok(entries)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Only meaningful when `is_dir` is true.
    pub has_children: bool,
    /// File size in bytes; `None` for directories.
    pub size: Option<u64>,
}

/// List immediate children of `path`, returning both directories and files.
/// Mirrors `list_directory_entries` but does not filter out files, used by the
/// "attach server file" picker.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_directory_with_files(
    path: String,
) -> Result<Vec<DirectoryItem>, AppCommandError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppCommandError::io_error("Path is not a directory").with_detail(path));
    }

    let mut items: Vec<DirectoryItem> = Vec::new();
    let read_dir = std::fs::read_dir(&root).map_err(|e| {
        AppCommandError::io_error("Failed to read directory").with_detail(e.to_string())
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // Follow symlinks for the dir/file classification.
        let is_dir = if file_type.is_symlink() {
            entry.path().is_dir()
        } else {
            file_type.is_dir()
        };
        let abs_path = entry.path().to_string_lossy().to_string();

        let (has_children, size) = if is_dir {
            let has = match std::fs::read_dir(entry.path()) {
                Ok(sub) => sub.filter_map(|e| e.ok()).any(|e| {
                    let sub_name = e.file_name().to_string_lossy().to_string();
                    !sub_name.starts_with('.')
                }),
                Err(_) => false,
            };
            (has, None)
        } else {
            let size = entry.metadata().ok().map(|m| m.len());
            (false, size)
        };

        items.push(DirectoryItem {
            name,
            path: abs_path,
            is_dir,
            has_children,
            size,
        });
    }

    // Sort: directories first, then files; each group by name case-insensitive.
    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(items)
}

/// 目录自己的忽略规则：`.gitignore`，仓库根再加 `.git/info/exclude`。
fn dir_gitignore(dir: &Path) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(dir);
    let mut found = false;
    for file in [dir.join(".gitignore"), dir.join(".git/info/exclude")] {
        if file.is_file() {
            found |= builder.add(file).is_none();
        }
    }
    found.then(|| builder.build().ok()).flatten()
}

/// 按 git 语义从最近的目录往上找第一条命中的规则（`!` 取反即不忽略）。
fn gitignore_match(rules: &HashMap<PathBuf, Gitignore>, path: &Path, is_dir: bool) -> bool {
    let mut dir = path.parent();
    while let Some(current) = dir {
        if let Some(rule) = rules.get(current) {
            match rule.matched(path, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        dir = current.parent();
    }
    false
}

/// 从 `root` 往上收集到仓库根为止的规则：懒加载会以子目录为根重走，上层规则也要生效。
/// 不在 git 仓库里时只用 `root` 以下的规则。
fn ancestor_gitignores(root: &Path) -> HashMap<PathBuf, Gitignore> {
    let mut rules = HashMap::new();
    let mut collected = Vec::new();
    for dir in root.ancestors().skip(1) {
        collected.push(dir);
        if dir.join(".git").exists() {
            for dir in collected {
                if let Some(rule) = dir_gitignore(dir) {
                    rules.insert(dir.to_path_buf(), rule);
                }
            }
            break;
        }
    }
    rules
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_file_tree(
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<FileTreeNode>, AppCommandError> {
    let root = PathBuf::from(&path);
    let depth = max_depth.unwrap_or(usize::MAX);

    // Collect all entries, skipping ignored directories
    let mut dir_children: HashMap<PathBuf, Vec<FileTreeNode>> = HashMap::new();
    let mut dir_order: Vec<PathBuf> = Vec::new();
    let mut dir_paths_by_rel: HashMap<String, PathBuf> = HashMap::new();
    // 含 `.git` 的目录（嵌套仓库边界）。`.git` 目录/文件都被 WORKSPACE 过滤
    // 不进入树，但 filter_entry 先于过滤看到它——据此标记其父目录。
    let mut repo_dirs: HashSet<PathBuf> = HashSet::new();
    // WalkDir 先序遍历：进入目录时登记它的规则，子项命中前父目录规则已就位。
    let mut gitignores = if root.join(".git").exists() {
        HashMap::new()
    } else {
        ancestor_gitignores(&root)
    };
    let mut ignored_dirs: HashSet<PathBuf> = HashSet::new();

    for entry in WalkDir::new(&root)
        .max_depth(depth)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // `.git`（目录或文件）永远不进入树；它存在的父目录是仓库根。
            if name == ".git" {
                if let Some(parent) = e.path().parent() {
                    repo_dirs.insert(parent.to_path_buf());
                }
                return false;
            }
            // Follow one symlink hop so directory symlinks (e.g. shared dotfiles)
            // participate in the same ignore-name rules as real directories.
            // WalkDir still does not descend into them (`follow_links=false`);
            // the frontend lazy-loads by re-rooting `get_file_tree` on expand.
            if entry_is_dir(e.file_type(), e.path()) {
                !WORKSPACE_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                !is_ignored_workspace_file_name(&name)
            }
        })
    {
        // Skip unreadable entries (ELOOP, permission, vanished files) rather
        // than failing the whole tree — a looping `.pi` must not blank the
        // project file list or retrigger watch-resync.
        let Ok(entry) = entry else { continue };
        let entry_path = entry.path().to_path_buf();

        // Skip the root itself
        if entry_path == root {
            if let Some(rule) = dir_gitignore(&root) {
                gitignores.insert(root.clone(), rule);
            }
            dir_children.entry(root.clone()).or_default();
            dir_order.push(root.clone());
            continue;
        }

        let parent = entry_path.parent().unwrap_or(&root).to_path_buf();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = entry_path
            .strip_prefix(&root)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .replace('\\', "/");
        let is_dir = entry_is_dir(entry.file_type(), &entry_path);
        let link_target = read_link_target(&entry_path);
        let ignored =
            ignored_dirs.contains(&parent) || gitignore_match(&gitignores, &entry_path, is_dir);

        if is_dir {
            if ignored {
                ignored_dirs.insert(entry_path.clone());
            } else if let Some(rule) = dir_gitignore(&entry_path) {
                gitignores.insert(entry_path.clone(), rule);
            }
            dir_paths_by_rel.insert(rel_path.clone(), entry_path.clone());
            dir_children.entry(entry_path.clone()).or_default();
            dir_order.push(entry_path);
            // Add a placeholder Dir node to parent (children filled later).
            // Directory symlinks get an empty children list here because
            // WalkDir does not follow them; expansion re-roots the walk.
            dir_children
                .entry(parent)
                .or_default()
                .push(FileTreeNode::Dir {
                    name,
                    path: rel_path,
                    children: vec![],
                    link_target,
                    is_repo: false, // placeholder：组装阶段按 repo_dirs 重建
                    ignored,
                });
        } else {
            dir_children
                .entry(parent)
                .or_default()
                .push(FileTreeNode::File {
                    name,
                    path: rel_path,
                    link_target,
                    ignored,
                });
        }
    }

    // Build tree bottom-up: process dirs in reverse order so children are ready
    for dir_path in dir_order.iter().rev() {
        let children = dir_children.remove(dir_path).unwrap_or_default();

        // Sort: dirs first, then files, alphabetically within each group
        let mut dirs: Vec<FileTreeNode> = Vec::new();
        let mut files: Vec<FileTreeNode> = Vec::new();
        for child in children {
            match &child {
                FileTreeNode::Dir { .. } => dirs.push(child),
                FileTreeNode::File { .. } => files.push(child),
            }
        }
        dirs.sort_by(|a, b| {
            let a_name = match a {
                FileTreeNode::Dir { name, .. } => name,
                _ => unreachable!(),
            };
            let b_name = match b {
                FileTreeNode::Dir { name, .. } => name,
                _ => unreachable!(),
            };
            a_name.to_lowercase().cmp(&b_name.to_lowercase())
        });
        files.sort_by(|a, b| {
            let a_name = match a {
                FileTreeNode::File { name, .. } => name,
                _ => unreachable!(),
            };
            let b_name = match b {
                FileTreeNode::File { name, .. } => name,
                _ => unreachable!(),
            };
            a_name.to_lowercase().cmp(&b_name.to_lowercase())
        });

        let mut sorted: Vec<FileTreeNode> = Vec::with_capacity(dirs.len() + files.len());

        // Fill dir children from the map
        for d in dirs {
            if let FileTreeNode::Dir {
                name,
                path: rel_path,
                link_target,
                ignored,
                ..
            } = d
            {
                let full_path = dir_paths_by_rel
                    .get(&rel_path)
                    .cloned()
                    .unwrap_or_else(|| root.join(Path::new(&rel_path)));
                let sub_children = dir_children.remove(&full_path).unwrap_or_default();
                sorted.push(FileTreeNode::Dir {
                    name,
                    path: rel_path,
                    children: sub_children,
                    link_target,
                    is_repo: repo_dirs.contains(&full_path),
                    ignored,
                });
            }
        }
        sorted.extend(files);

        dir_children.insert(dir_path.clone(), sorted);
    }

    Ok(dir_children.remove(&root).unwrap_or_default())
}

/// Flat, gitignore-aware listing of every file and directory under `path`, for
/// fuzzy file search. Unlike [`get_file_tree`], ignored directories
/// (`node_modules`, `target`, `dist`, …) are pruned *during* the walk, so no
/// depth cap is needed: deep files stay reachable while the heavy trees are
/// never descended and the payload stays small. Gitignore handling that used to
/// run client-side now happens here at native speed in a single pass.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_workspace_files(
    path: String,
) -> Result<Vec<WorkspaceFileEntry>, AppCommandError> {
    let root = PathBuf::from(&path);

    // Conservative gitignore parity with the previous client-side pass: respect
    // in-tree `.gitignore`/`.ignore`/`.git/info/exclude`, but not the global
    // gitignore or parent-directory ignores (the workspace root is the
    // boundary). `require_git(false)` keeps `.gitignore` effective even outside
    // a git repo. `hidden(false)` keeps dotfiles visible. The `filter_entry`
    // mirrors `get_file_tree`'s hardcoded ignores exactly.
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .parents(false)
        .ignore(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            let is_dir = e
                .file_type()
                .map(|t| entry_is_dir(t, e.path()))
                .unwrap_or(false);
            if is_dir {
                !WORKSPACE_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                !is_ignored_workspace_file_name(&name)
            }
        })
        .build();

    let mut entries: Vec<WorkspaceFileEntry> = Vec::new();
    for result in walker {
        // Skip unreadable entries (permission errors, transient races) rather
        // than failing the whole search.
        let Ok(entry) = result else { continue };
        let entry_path = entry.path();

        // Skip the root directory itself.
        if entry_path == root {
            continue;
        }

        // Match `get_file_tree`: follow one symlink hop so directory
        // symlinks are searchable as dirs, not as opaque files.
        let is_dir = entry
            .file_type()
            .map(|t| entry_is_dir(t, entry_path))
            .unwrap_or(false);
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = entry_path
            .strip_prefix(&root)
            .unwrap_or(entry_path)
            .to_string_lossy()
            .replace('\\', "/");

        entries.push(WorkspaceFileEntry {
            name,
            path: rel_path,
            kind: if is_dir {
                WorkspaceEntryKind::Dir
            } else {
                WorkspaceEntryKind::File
            },
        });
    }

    Ok(entries)
}

/// One resolved match for `resolve_workspace_reference`: the file/dir the
/// selection points at, plus the workspace-relative path the file tree uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceReferenceMatch {
    pub kind: WorkspaceEntryKind,
    /// Absolute path (forward-slashed) for open/preview surfaces.
    pub abs_path: String,
    /// Path relative to the workspace root, always forward-slashed.
    pub rel_path: String,
}

/// Resolve a user text selection (from the pointer capsule menu) against the
/// workspace. `text` arrives already cleaned by the frontend: quotes/stack
/// prefixes stripped, line/column suffixes removed, URLs filtered out. This
/// command is the single source of truth for "does this reference exist", so
/// it deliberately walks the live filesystem instead of consulting any
/// cached index — a freshly created or gitignored-but-real file resolves.
///
/// Matching rules:
/// - Absolute paths (incl. `~`, expanded here) are checked with
///   `fs::metadata`; when inside the root a rel_path is derived, else the
///   abs path doubles as the rel path.
/// - Relative references match entries whose path equals the query or ends
///   with `/query` (suffix match), so output emitted relative to a
///   subdirectory still resolves. An exact full-path hit is preferred over
///   suffix hits and suppresses them.
/// - The walk prunes only the hardcoded `WORKSPACE_IGNORED_DIRS` (build
///   products) — gitignore is version-control semantics and must not decide
///   whether a local file can be opened.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn resolve_workspace_reference(
    root: String,
    text: String,
) -> Result<Vec<WorkspaceReferenceMatch>, AppCommandError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let root_path = PathBuf::from(&root);
    // Normalize the reference to forward slashes without a trailing slash.
    let query = trimmed.replace('\\', "/").trim_end_matches('/').to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    // Absolute or `~` reference: stat directly, no walk needed.
    let abs_query = if query.starts_with('/') || query.starts_with('~') {
        Some(expand_home(&query))
    } else if query.len() > 2 && query.as_bytes()[1] == b':' && query.contains(':') && {
        // Windows drive path like `C:/x` or `C:\x`.
        query.as_bytes()[0].is_ascii_alphabetic()
            && (query.as_bytes()[2] == b'/' || query.as_bytes()[2] == b'\\')
    } {
        Some(PathBuf::from(&query))
    } else {
        None
    };

    if let Some(abs) = abs_query {
        let Ok(metadata) = std::fs::metadata(&abs) else {
            return Ok(Vec::new());
        };
        let abs_display = abs.to_string_lossy().replace('\\', "/");
        let rel = abs
            .strip_prefix(&root_path)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| abs_display.clone());
        return Ok(vec![WorkspaceReferenceMatch {
            kind: if metadata.is_dir() {
                WorkspaceEntryKind::Dir
            } else {
                WorkspaceEntryKind::File
            },
            abs_path: abs_display,
            rel_path: rel,
        }]);
    }

    // Relative reference: walk live (same pruning as list_workspace_files).
    let walker = WalkBuilder::new(&root_path)
        .hidden(false)
        .parents(false)
        .ignore(false)
        .git_ignore(false)
        .git_exclude(false)
        .git_global(false)
        .require_git(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            let is_dir = e
                .file_type()
                .map(|t| entry_is_dir(t, e.path()))
                .unwrap_or(false);
            if is_dir {
                !WORKSPACE_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                !is_ignored_workspace_file_name(&name)
            }
        })
        .build();

    let query_lower = query.to_lowercase();
    let mut exact: Option<WorkspaceReferenceMatch> = None;
    let mut suffix: Vec<WorkspaceReferenceMatch> = Vec::new();

    for result in walker {
        let Ok(entry) = result else { continue };
        let entry_path = entry.path();
        if entry_path == root_path {
            continue;
        }
        let is_dir = entry
            .file_type()
            .map(|t| entry_is_dir(t, entry_path))
            .unwrap_or(false);
        let rel = entry_path
            .strip_prefix(&root_path)
            .unwrap_or(entry_path)
            .to_string_lossy()
            .replace('\\', "/");
        let rel_lower = rel.to_lowercase();

        if exact.is_none() && rel_lower == query_lower {
            let abs = entry_path.to_string_lossy().replace('\\', "/");
            exact = Some(WorkspaceReferenceMatch {
                kind: if is_dir {
                    WorkspaceEntryKind::Dir
                } else {
                    WorkspaceEntryKind::File
                },
                abs_path: abs,
                rel_path: rel,
            });
            continue;
        }
        if rel_lower.ends_with(&format!("/{query_lower}")) {
            let abs = entry_path.to_string_lossy().replace('\\', "/");
            suffix.push(WorkspaceReferenceMatch {
                kind: if is_dir {
                    WorkspaceEntryKind::Dir
                } else {
                    WorkspaceEntryKind::File
                },
                abs_path: abs,
                rel_path: rel,
            });
        }
    }

    // An exact full-path hit wins outright: suffix hits are alternatives the
    // user did not spell out, so they turn into noise rather than signal.
    Ok(if let Some(exact) = exact {
        vec![exact]
    } else {
        suffix
    })
}

/// Expand a leading `~` using the OS home directory; other prefixes pass
/// through unchanged (the caller only invokes this for absolute refs).
fn expand_home(query: &str) -> PathBuf {
    if query == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(query));
    }
    if let Some(rest) = query.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(query)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_base64(
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("Path cannot be empty"));
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let limit = max_bytes
        .unwrap_or(FILE_BASE64_DEFAULT_MAX_BYTES)
        .clamp(4_096, FILE_BASE64_MAX_BYTES);

    run_file_io(move || {
        let metadata = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        if metadata.len() > limit as u64 {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        let bytes = std::fs::read(&target).map_err(AppCommandError::io)?;
        if bytes.len() > limit {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
}

/// Open a file for reading, refusing a final-component symlink (unix) so a
/// path validated by canonicalization cannot be redirected through a symlink
/// swapped in afterward.
#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_FLAG_OPEN_REPARSE_POINT opens the reparse point itself instead of
    // following it, so a symlink/junction swapped in after validation is opened
    // (and then rejected by the is_file() check) rather than followed outside
    // the workspace root.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// Like `read_file_base64`, but confined to a workspace root: the path is
/// relative to `root_path` and is canonicalized (resolving symlinks) so it can
/// never read outside the workspace. Used by the HTML preview to inline local
/// sub-resources without exposing the unconfined `read_file_base64` to crafted
/// markup (e.g. a symlink pointing at `/etc/passwd`).
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_workspace_file_base64(
    root_path: String,
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let limit = max_bytes
        .unwrap_or(FILE_BASE64_DEFAULT_MAX_BYTES)
        .clamp(4_096, FILE_BASE64_MAX_BYTES);

    run_file_io(move || {
        use std::io::Read;
        // Canonicalize and confine, then open a single handle (O_NOFOLLOW on
        // unix) and do metadata + read on the fd. This closes the check-then-
        // read race: the original `target` symlink can't be re-resolved (we use
        // the canonical path), a final-component symlink swapped in after the
        // check makes the open fail, and metadata/read never re-look-up the path.
        let canonical_root = std::fs::canonicalize(&root).map_err(AppCommandError::io)?;
        let canonical_target = std::fs::canonicalize(&target).map_err(AppCommandError::io)?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err(AppCommandError::invalid_input(
                "Path is outside workspace root",
            ));
        }
        let mut file = open_no_follow(&canonical_target).map_err(AppCommandError::io)?;
        let metadata = file.metadata().map_err(AppCommandError::io)?;
        if !metadata.is_file() {
            return Err(AppCommandError::invalid_input("Path is not a file"));
        }
        if metadata.len() > limit as u64 {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        // take(limit + 1) bounds the read even if the file grows after fstat.
        let mut bytes = Vec::new();
        Read::take(&mut file, limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(AppCommandError::io)?;
        if bytes.len() > limit {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_preview(
    root_path: String,
    path: String,
) -> Result<FilePreviewContent, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_path_in_workspace(&root, &target)?;
        let content = read_text_full(&target, FILE_OPEN_HARD_LIMIT)?;
        Ok(FilePreviewContent {
            path: path_for_response,
            content,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_for_edit(
    root_path: String,
    path: String,
) -> Result<FileEditContent, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_path_in_workspace(&root, &target)?;
        let metadata = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        let content = read_text_full(&target, FILE_OPEN_HARD_LIMIT)?;
        let readonly = metadata.permissions().readonly();
        let mtime_ms = file_mtime_ms(&metadata);
        let etag = compute_etag(content.as_bytes(), &metadata);
        let line_ending = detect_line_ending(content.as_bytes());

        Ok(FileEditContent {
            path: path_for_response,
            content,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_file_content(
    root_path: String,
    path: String,
    content: String,
    expected_etag: Option<String>,
) -> Result<FileSaveResult, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }
    if content.len() > FILE_SAVE_HARD_LIMIT {
        return Err(
            AppCommandError::invalid_input("File is too large to save in editor")
                .with_detail(format!("max_bytes={FILE_SAVE_HARD_LIMIT}")),
        );
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_path_in_workspace(&root, &target)?;

        let link_meta = std::fs::symlink_metadata(&target).map_err(AppCommandError::io)?;
        if link_meta.file_type().is_symlink() {
            return Err(AppCommandError::invalid_input(
                "Saving symlink targets is not supported",
            ));
        }

        let before_meta = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        if before_meta.permissions().readonly() {
            return Err(AppCommandError::permission_denied("File is read-only"));
        }

        let current_bytes = std::fs::read(&target).map_err(AppCommandError::io)?;
        if current_bytes.iter().take(2_048).any(|b| *b == 0) {
            return Err(AppCommandError::invalid_input(
                "Binary files are not supported in editor",
            ));
        }
        let current_etag = compute_etag(&current_bytes, &before_meta);
        if let Some(expected) = expected_etag {
            if expected != current_etag {
                return Err(AppCommandError::invalid_input(
                    "File has changed on disk. Reload the file before saving.",
                ));
            }
        }

        atomic_write_text(&target, content.as_bytes())?;

        let after_meta = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        let etag = compute_etag(content.as_bytes(), &after_meta);
        let mtime_ms = file_mtime_ms(&after_meta);
        let readonly = after_meta.permissions().readonly();
        let line_ending = detect_line_ending(content.as_bytes());

        Ok(FileSaveResult {
            path: path_for_response,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

fn build_local_copy_file_name(original_name: &str, attempt: usize) -> String {
    let original = Path::new(original_name);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(original_name);
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty());

    let suffix = if attempt <= 1 {
        ".local".to_string()
    } else {
        format!(".local.{}", attempt)
    };

    match extension {
        Some(ext) => format!("{stem}{suffix}.{ext}"),
        None => format!("{stem}{suffix}"),
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_file_copy(
    root_path: String,
    path: String,
    content: String,
) -> Result<FileSaveResult, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }
    if content.len() > FILE_SAVE_HARD_LIMIT {
        return Err(
            AppCommandError::invalid_input("File is too large to save in editor")
                .with_detail(format!("max_bytes={FILE_SAVE_HARD_LIMIT}")),
        );
    }

    let source = resolve_tree_path(&root, &path)?;
    if !source.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !source.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    run_file_io(move || {
        ensure_path_in_workspace(&root, &source)?;

        let source_meta = std::fs::symlink_metadata(&source).map_err(AppCommandError::io)?;
        if source_meta.file_type().is_symlink() {
            return Err(AppCommandError::invalid_input(
                "Saving symlink targets is not supported",
            ));
        }

        let parent = source
            .parent()
            .ok_or_else(|| {
                AppCommandError::invalid_input("Cannot determine parent directory for source file")
            })?
            .to_path_buf();
        ensure_path_in_workspace(&root, &parent)?;

        let source_name = source
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| AppCommandError::invalid_input("Cannot determine source file name"))?;

        let mut created_path: Option<PathBuf> = None;
        for attempt in 1..=9_999 {
            let candidate_name = build_local_copy_file_name(&source_name, attempt);
            let candidate_path = parent.join(candidate_name);
            if candidate_path.exists() {
                continue;
            }
            created_path = Some(candidate_path);
            break;
        }

        let created_path = created_path.ok_or_else(|| {
            AppCommandError::already_exists(
                "Unable to create copy file: too many existing local copies",
            )
        })?;
        atomic_write_text(&created_path, content.as_bytes())?;

        let metadata = std::fs::metadata(&created_path).map_err(AppCommandError::io)?;
        let etag = compute_etag(content.as_bytes(), &metadata);
        let mtime_ms = file_mtime_ms(&metadata);
        let readonly = metadata.permissions().readonly();
        let line_ending = detect_line_ending(content.as_bytes());
        let rel_path = created_path
            .strip_prefix(&root)
            .map_err(|e| {
                AppCommandError::invalid_input("Failed to compute relative path for copy")
                    .with_detail(e.to_string())
            })?
            .to_string_lossy()
            .replace('\\', "/");

        Ok(FileSaveResult {
            path: rel_path,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn rename_file_tree_entry(
    root_path: String,
    path: String,
    new_name: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("Target file does not exist"));
    }
    if target == root {
        return Err(AppCommandError::invalid_input(
            "Cannot rename workspace root",
        ));
    }

    let parent = target
        .parent()
        .ok_or_else(|| AppCommandError::invalid_input("Cannot rename path without parent"))?;
    let validated_name = validate_new_name(&new_name)?;
    let next_path = parent.join(validated_name);

    if next_path == target {
        return Ok(path);
    }
    if next_path.exists() {
        return Err(AppCommandError::already_exists(
            "A file with this name already exists",
        ));
    }

    std::fs::rename(&target, &next_path).map_err(AppCommandError::io)?;

    let rel = next_path
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

/// Move a file/directory into a different directory of the same workspace,
/// keeping its name. `source_path` and `dest_dir` are both workspace-relative
/// (forward slashes); `dest_dir` is `""` for the workspace root. Returns the new
/// workspace-relative path of the moved entry.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn move_file_tree_entry(
    root_path: String,
    source_path: String,
    dest_dir: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let source = resolve_tree_path(&root, &source_path)?;
    // `symlink_metadata` doesn't follow the final component, so a (possibly
    // dangling) symlink entry the tree still shows counts as existing — and
    // `fs::rename` moves the link itself rather than whatever it points at.
    match std::fs::symlink_metadata(&source) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppCommandError::not_found("Source file does not exist"));
        }
        Err(e) => return Err(AppCommandError::io(e)),
    }
    if source == root {
        return Err(AppCommandError::invalid_input("Cannot move workspace root"));
    }

    let dest = resolve_tree_path(&root, &dest_dir)?;
    if !dest.is_dir() {
        return Err(AppCommandError::invalid_input(
            "Destination is not a directory",
        ));
    }

    // Reject moving a directory into itself or one of its own descendants —
    // `starts_with` is component-wise, so `src` is not mistaken for `src-utils`.
    if dest == source || dest.starts_with(&source) {
        return Err(AppCommandError::invalid_input(
            "Cannot move a directory into itself",
        ));
    }

    let name = source
        .file_name()
        .ok_or_else(|| AppCommandError::invalid_input("Cannot move path without a name"))?;
    let target = dest.join(name);

    // Dropping onto the current parent is a no-op — report the unchanged path
    // rather than erroring so the UI can simply do nothing.
    if target == source {
        return Ok(source_path);
    }
    // Collision check via `symlink_metadata`: a same-name entry of ANY kind —
    // including a dangling symlink, which `Path::exists()` reports as absent —
    // must block the move so `fs::rename` can't silently clobber it.
    match std::fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(AppCommandError::already_exists(
                "An entry with this name already exists in the destination",
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppCommandError::io(e)),
    }

    std::fs::rename(&source, &target).map_err(AppCommandError::io)?;

    let rel = target
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_file_tree_entry(
    root_path: String,
    path: String,
) -> Result<(), AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    // `Path::exists` follows symlinks and silently returns false on a
    // dangling link or any I/O error along the resolve chain, which gave
    // us "Target file does not exist" toasts even for files that were
    // physically present (case-only mismatches against a case-preserving
    // FS, NFD/NFC mismatches on macOS, files under a non-traversable
    // ancestor). `symlink_metadata` only stats the leaf and surfaces the
    // real OS error code in `detail`, which is what we want to diagnose
    // those reports.
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppCommandError::not_found("Target file does not exist")
                .with_detail(format!("resolved={} relative={}", target.display(), path)));
        }
        Err(err) => {
            return Err(
                AppCommandError::io_error("Failed to stat target").with_detail(format!(
                    "resolved={} relative={} error={}",
                    target.display(),
                    path,
                    err
                )),
            );
        }
    };
    if target == root {
        return Err(AppCommandError::invalid_input(
            "Cannot delete workspace root",
        ));
    }
    if meta.is_dir() {
        std::fs::remove_dir_all(&target).map_err(AppCommandError::io)?;
    } else {
        std::fs::remove_file(&target).map_err(AppCommandError::io)?;
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_file_tree_entry(
    root_path: String,
    path: String,
    name: String,
    kind: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let validated_name = validate_new_name(&name)?;

    let parent_dir = if path.is_empty() {
        root.clone()
    } else {
        let resolved = resolve_tree_path(&root, &path)?;
        if !resolved.exists() {
            return Err(AppCommandError::not_found("Parent path does not exist"));
        }
        if resolved.is_file() {
            resolved.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
                AppCommandError::invalid_input("Cannot determine parent directory")
            })?
        } else {
            resolved
        }
    };

    let target = parent_dir.join(validated_name);
    if target.exists() {
        return Err(AppCommandError::already_exists(
            "A file or directory with this name already exists",
        ));
    }

    match kind.as_str() {
        "file" => {
            std::fs::File::create(&target).map_err(AppCommandError::io)?;
        }
        "dir" => {
            std::fs::create_dir(&target).map_err(AppCommandError::io)?;
        }
        _ => {
            return Err(AppCommandError::invalid_input(
                "Kind must be 'file' or 'dir'",
            ));
        }
    }

    let rel = target
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

#[cfg(all(test, unix))]
mod workspace_confinement_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[tokio::test]
    async fn reads_in_root_file() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"hello").expect("write");
        let b64 = read_workspace_file_base64(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            None,
        )
        .await
        .expect("should read in-root file");
        assert_eq!(b64, "aGVsbG8="); // base64("hello")
    }

    #[tokio::test]
    async fn accepts_workspace_symlink_pointing_outside() {
        // Workspace-internal symlinks that point at external paths are a
        // legitimate content pattern (shared dotfiles, cross-repo tool state,
        // git worktrees). The lexical `ensure_path_in_workspace` accepts them;
        // the write-side `symlink_metadata` defense continues to refuse writing
        // through the symlink leaf.
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("secret"), b"top").expect("write");
        symlink(outside.path().join("secret"), root.path().join("link")).expect("symlink");
        let content = read_file_for_edit(
            root.path().to_string_lossy().into_owned(),
            "link".to_string(),
        )
        .await
        .expect("editor should read through a workspace-internal symlink");
        assert_eq!(content.content, "top");

        // Writing through the symlink is still refused by the leaf check in
        // `save_file_content`.
        let write_res = save_file_content(
            root.path().to_string_lossy().into_owned(),
            "link".to_string(),
            "clobber".to_string(),
            None,
        )
        .await;
        let err = write_res.expect_err("writing to a symlink leaf must be refused");
        assert!(
            err.to_string().contains("symlink"),
            "error should mention symlink refusal, got: {err}",
        );
    }

    #[test]
    fn ensure_path_in_workspace_accepts_symlink() {
        // The physical-containment check was intentionally dropped: lexical
        // ownership is enough to gate API inputs, and refusing every workspace
        // symlink whose target lives outside broke editors on shared dotfile
        // trees. Write-side defenses still protect the symlink leaf.
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, b"x").expect("write");
        let link = root.path().join("asset.txt");
        symlink(&secret, &link).expect("symlink");
        assert!(ensure_path_in_workspace(root.path(), &link).is_ok());
    }

    #[tokio::test]
    async fn move_file_tree_entry_does_not_clobber_dangling_symlink() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"real").expect("write");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        // A dangling symlink occupies the destination name. `Path::exists()`
        // follows it and reports `false`, so the collision check must instead
        // use `symlink_metadata` or `fs::rename` would destroy the link.
        symlink(
            root.path().join("nonexistent-target"),
            root.path().join("sub/a.txt"),
        )
        .expect("symlink");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "sub".to_string(),
        )
        .await;
        assert!(
            res.is_err(),
            "must not clobber a dangling destination symlink"
        );
        assert!(
            std::fs::symlink_metadata(root.path().join("sub/a.txt")).is_ok(),
            "dangling symlink must remain intact",
        );
        assert!(root.path().join("a.txt").exists(), "source untouched");
    }

    #[tokio::test]
    async fn move_file_tree_entry_moves_a_symlink_entry() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("target.txt"), b"x").expect("write");
        symlink(root.path().join("target.txt"), root.path().join("link.txt")).expect("symlink");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");

        let new_rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "link.txt".to_string(),
            "sub".to_string(),
        )
        .await
        .expect("move symlink");
        assert_eq!(new_rel.replace('\\', "/"), "sub/link.txt");
        // The moved entry is still a symlink (the link itself moved, not its target).
        let meta =
            std::fs::symlink_metadata(root.path().join("sub/link.txt")).expect("moved link exists");
        assert!(meta.file_type().is_symlink(), "entry stays a symlink");
        assert!(!root.path().join("link.txt").exists(), "old link gone");
    }
}

#[cfg(all(test, unix))]
mod file_tree_symlink_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[tokio::test]
    async fn get_file_tree_classifies_symlink_to_dir_as_dir() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("nested.txt"), b"hi").expect("write");
        // Relative link target preserves the raw form in `linkTarget`.
        symlink(outside.path(), root.path().join("shared")).expect("symlink");

        let tree = get_file_tree(root.path().to_string_lossy().into_owned(), Some(2))
            .await
            .expect("tree");

        let shared = tree
            .iter()
            .find(|n| match n {
                FileTreeNode::Dir { name, .. } => name == "shared",
                FileTreeNode::File { name, .. } => name == "shared",
            })
            .expect("shared entry present");

        match shared {
            FileTreeNode::Dir {
                name,
                path,
                children,
                link_target,
                ..
            } => {
                assert_eq!(name, "shared");
                assert_eq!(path, "shared");
                // WalkDir does not follow directory symlinks; children arrive
                // via a re-rooted lazy expand call.
                assert!(children.is_empty(), "symlink dir children are lazy");
                assert!(
                    link_target.as_ref().is_some_and(|t| !t.is_empty()),
                    "directory symlink must expose linkTarget, got {link_target:?}",
                );
            }
            FileTreeNode::File { .. } => {
                panic!("directory symlink must be classified as Dir, not File")
            }
        }

        // Re-rooting on the symlink path lists the target's contents.
        let nested = get_file_tree(
            root.path().join("shared").to_string_lossy().into_owned(),
            Some(1),
        )
        .await
        .expect("re-rooted tree");
        assert!(
            nested.iter().any(|n| matches!(
                n,
                FileTreeNode::File { name, .. } if name == "nested.txt"
            )),
            "re-rooted walk should list target contents: {nested:?}",
        );
    }

    #[tokio::test]
    async fn get_file_tree_dangling_symlink_treated_as_file() {
        let root = tempfile::tempdir().expect("root");
        symlink(
            root.path().join("missing-target"),
            root.path().join("broken"),
        )
        .expect("dangling symlink");

        let tree = get_file_tree(root.path().to_string_lossy().into_owned(), Some(1))
            .await
            .expect("tree");

        let broken = tree
            .iter()
            .find(|n| match n {
                FileTreeNode::File { name, .. } | FileTreeNode::Dir { name, .. } => {
                    name == "broken"
                }
            })
            .expect("dangling symlink still appears as an entry");

        match broken {
            FileTreeNode::File {
                name, link_target, ..
            } => {
                assert_eq!(name, "broken");
                assert!(
                    link_target
                        .as_ref()
                        .is_some_and(|t| t.contains("missing-target")),
                    "dangling symlink still has a readable linkTarget, got {link_target:?}",
                );
            }
            FileTreeNode::Dir { .. } => {
                panic!("dangling symlink must be treated as File, not Dir")
            }
        }
    }

    #[tokio::test]
    async fn get_file_tree_symlink_to_file_stays_file() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("real.txt"), b"x").expect("write");
        symlink(
            outside.path().join("real.txt"),
            root.path().join("alias.txt"),
        )
        .expect("file symlink");

        let tree = get_file_tree(root.path().to_string_lossy().into_owned(), Some(1))
            .await
            .expect("tree");

        let alias = tree
            .iter()
            .find(|n| match n {
                FileTreeNode::File { name, .. } | FileTreeNode::Dir { name, .. } => {
                    name == "alias.txt"
                }
            })
            .expect("alias present");
        match alias {
            FileTreeNode::File {
                name, link_target, ..
            } => {
                assert_eq!(name, "alias.txt");
                assert!(link_target.is_some(), "file symlink exposes linkTarget");
            }
            FileTreeNode::Dir { .. } => panic!("file symlink must stay File"),
        }
    }

    #[tokio::test]
    async fn get_file_tree_looping_symlink_is_file_not_error() {
        let root = tempfile::tempdir().expect("root");
        let loop_path = root.path().join(".pi");
        symlink(".pi", &loop_path).expect("self-referential symlink");

        let started = std::time::Instant::now();
        let tree = get_file_tree(root.path().to_string_lossy().into_owned(), Some(2))
            .await
            .expect("tree must not fail on ELOOP");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "classifying a looping symlink must not follow the whole chain"
        );

        let pi = tree
            .iter()
            .find(|n| match n {
                FileTreeNode::File { name, .. } | FileTreeNode::Dir { name, .. } => name == ".pi",
            })
            .expect(".pi still listed");
        match pi {
            FileTreeNode::File {
                name, link_target, ..
            } => {
                assert_eq!(name, ".pi");
                assert_eq!(link_target.as_deref(), Some(".pi"));
            }
            FileTreeNode::Dir { .. } => {
                panic!("looping directory symlink must not be treated as an expandable dir")
            }
        }

        let rerooted = get_file_tree(loop_path.to_string_lossy().into_owned(), Some(1))
            .await
            .expect("re-rooting on a looping symlink must not fail");
        assert!(
            rerooted.is_empty(),
            "looping walk root has no readable children, got {rerooted:?}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(root: &std::path::Path, rel: &str, contents: &str) {
        let full = root.join(rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("create parent dirs");
        }
        std::fs::write(full, contents).expect("write file");
    }

    #[tokio::test]
    async fn get_file_tree_marks_gitignored_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write_file(root, ".git/info/exclude", "secret.txt\n");
        write_file(root, ".gitignore", "*.log\nout/\n!keep.log\n");
        for file in ["app.log", "keep.log", "secret.txt", "out/app.js"] {
            write_file(root, file, "");
        }
        write_file(root, "src/.gitignore", "gen.rs\n");
        for file in ["src/gen.rs", "src/main.rs", "src/debug.log"] {
            write_file(root, file, "");
        }

        fn ignored(nodes: &[FileTreeNode], out: &mut Vec<String>) {
            for node in nodes {
                match node {
                    FileTreeNode::File {
                        path,
                        ignored: true,
                        ..
                    } => out.push(path.clone()),
                    FileTreeNode::Dir {
                        path,
                        children,
                        ignored: is_ignored,
                        ..
                    } => {
                        if *is_ignored {
                            out.push(path.clone());
                        }
                        ignored(children, out);
                    }
                    FileTreeNode::File { .. } => {}
                }
            }
        }

        let tree = get_file_tree(root.to_string_lossy().into_owned(), Some(3))
            .await
            .expect("tree");
        let mut paths = Vec::new();
        ignored(&tree, &mut paths);
        paths.sort();
        assert_eq!(
            paths,
            [
                "app.log",
                "out",
                "out/app.js",
                "secret.txt",
                "src/debug.log",
                "src/gen.rs"
            ]
        );

        // 懒加载以子目录为根重走时，仓库根的规则仍然生效。
        let sub = get_file_tree(root.join("src").to_string_lossy().into_owned(), Some(1))
            .await
            .expect("subtree");
        let mut sub_paths = Vec::new();
        ignored(&sub, &mut sub_paths);
        sub_paths.sort();
        assert_eq!(sub_paths, ["debug.log", "gen.rs"]);
    }

    #[tokio::test]
    async fn get_file_tree_marks_nested_git_repo_dirs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        // 嵌套仓库：子目录含 .git（目录形式）。
        write_file(root, "subrepo/.git/config", "[core]");
        write_file(root, "subrepo/README.md", "nested repo");
        // submodule / linked worktree 形态：.git 是文件。
        write_file(
            root,
            "submod/.git",
            "gitdir: ../other/.git/worktrees/submod",
        );
        write_file(root, "submod/index.md", "submodule");
        // 普通目录不标记。
        write_file(root, "plain/note.txt", "plain");

        let tree = get_file_tree(root.to_string_lossy().into_owned(), Some(3))
            .await
            .expect("tree");

        let find_dir = |name: &str| -> bool {
            tree.iter().any(|node| match node {
                FileTreeNode::Dir {
                    name: n, is_repo, ..
                } => n == name && *is_repo,
                FileTreeNode::File { .. } => false,
            })
        };
        assert!(
            find_dir("subrepo"),
            "dir with .git directory must be a repo root"
        );
        assert!(find_dir("submod"), "dir with .git file must be a repo root");
        assert!(!find_dir("plain"), "plain dir must not be a repo root");

        // .git 元数据永不进入树（目录与文件形态都被过滤）。
        fn node_name(node: &FileTreeNode) -> &str {
            match node {
                FileTreeNode::Dir { name, .. } => name,
                FileTreeNode::File { name, .. } => name,
            }
        }
        fn has_dot_git_leaf(nodes: &[FileTreeNode]) -> bool {
            nodes.iter().any(|node| match node {
                FileTreeNode::Dir { children, .. } => {
                    node_name(node) == ".git" || has_dot_git_leaf(children)
                }
                FileTreeNode::File { .. } => node_name(node) == ".git",
            })
        }
        assert!(
            !has_dot_git_leaf(&tree),
            "no .git entry may appear in the tree"
        );
    }

    #[tokio::test]
    async fn list_workspace_files_includes_deep_and_prunes_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        // A file nested 12 levels deep — beyond the old hardcoded depth-10 cap
        // this command replaces. It must still be discovered (the core fix).
        let deep_rel = "a/b/c/d/e/f/g/h/i/j/k/deep.txt";
        write_file(root, deep_rel, "deep");

        // Gitignore rules must be honored even without a real git repo
        // (`require_git(false)`), pruning ignored trees during the walk.
        write_file(root, ".gitignore", "node_modules/\nignored.txt\n");
        write_file(root, "node_modules/pkg/index.js", "junk");
        write_file(root, "target/debug/app", "junk");
        write_file(root, ".next/cache/data", "junk");
        write_file(root, "ignored.txt", "junk");

        // The hardcoded ignores (mirroring WORKSPACE_IGNORED_DIRS) must be pruned.
        write_file(root, ".git/config", "[core]");
        write_file(root, "src/.DS_Store", "junk");
        write_file(root, "docs/~$report.docx", "lock");
        write_file(root, "docs/.~1-report.docx", "lock");
        write_file(root, "docs/.~lock.report.docx#", "lock");
        write_file(root, "docs/01-report.docx", "doc");

        // A normal file that must survive.
        write_file(root, "src/main.rs", "fn main() {}");

        let entries = list_workspace_files(root.to_string_lossy().to_string())
            .await
            .expect("list_workspace_files");
        let paths: std::collections::HashSet<&str> =
            entries.iter().map(|e| e.path.as_str()).collect();

        // Deep and normal files are reachable.
        assert!(
            paths.contains(deep_rel),
            "deep file must be listed, got {paths:?}"
        );
        assert!(paths.contains("src/main.rs"), "normal file must be listed");

        // Gitignored entries are pruned during traversal.
        assert!(
            !paths.iter().any(|p| p.starts_with("node_modules")),
            "gitignored node_modules must be pruned, got {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.starts_with("target")),
            "target must be pruned, got {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.starts_with(".next")),
            ".next must be pruned, got {paths:?}"
        );
        assert!(
            !paths.contains("ignored.txt"),
            "gitignored file must be pruned"
        );

        // Hardcoded ignores are pruned.
        // Precisely the `.git` dir / its contents — not `.gitignore`, which is
        // intentionally listed.
        assert!(
            !paths.iter().any(|p| *p == ".git" || p.starts_with(".git/")),
            ".git dir must be pruned, got {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.ends_with(".DS_Store")),
            ".DS_Store must be pruned"
        );
        assert!(
            !paths
                .iter()
                .any(|p| p.contains("/~$") || p.contains("/.~")),
            "Office lock files must be pruned, got {paths:?}"
        );
        assert!(
            paths.contains("docs/01-report.docx"),
            "the document itself must be listed"
        );

        // Intermediate directory entries are emitted alongside files — the
        // `@`-mention picker relies on directories being present.
        assert!(
            entries
                .iter()
                .any(|e| e.path == "a" && matches!(e.kind, WorkspaceEntryKind::Dir)),
            "directory entries must be present"
        );
    }

    #[tokio::test]
    async fn move_file_tree_entry_moves_file_into_subdir() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"x").expect("write");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");

        let new_rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "sub".to_string(),
        )
        .await
        .expect("move");

        assert_eq!(new_rel.replace('\\', "/"), "sub/a.txt");
        assert!(!root.path().join("a.txt").exists());
        assert!(root.path().join("sub/a.txt").exists());
    }

    #[tokio::test]
    async fn move_file_tree_entry_moves_back_to_root() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        std::fs::write(root.path().join("sub/a.txt"), b"x").expect("write");

        let new_rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "sub/a.txt".to_string(),
            String::new(),
        )
        .await
        .expect("move to root");

        assert_eq!(new_rel, "a.txt");
        assert!(root.path().join("a.txt").exists());
        assert!(!root.path().join("sub/a.txt").exists());
    }

    #[tokio::test]
    async fn move_file_tree_entry_rejects_move_into_own_descendant() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir_all(root.path().join("src/inner")).expect("mkdir");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "src".to_string(),
            "src/inner".to_string(),
        )
        .await;
        assert!(
            res.is_err(),
            "moving a dir into its own descendant must fail"
        );
        assert!(root.path().join("src/inner").is_dir(), "source untouched");
    }

    #[tokio::test]
    async fn move_file_tree_entry_rejects_existing_target() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"1").expect("write");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        std::fs::write(root.path().join("sub/a.txt"), b"2").expect("write");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "sub".to_string(),
        )
        .await;
        assert!(res.is_err(), "name collision in destination must fail");
        assert!(root.path().join("a.txt").exists(), "source untouched");
    }

    #[tokio::test]
    async fn move_file_tree_entry_same_parent_is_noop() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        std::fs::write(root.path().join("sub/a.txt"), b"x").expect("write");

        let rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "sub/a.txt".to_string(),
            "sub".to_string(),
        )
        .await
        .expect("no-op move");
        assert_eq!(rel, "sub/a.txt");
        assert!(root.path().join("sub/a.txt").exists());
    }

    #[tokio::test]
    async fn move_file_tree_entry_rejects_parent_escape() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"x").expect("write");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "../evil".to_string(),
        )
        .await;
        assert!(res.is_err(), "dest containing '..' must be rejected");
    }

    fn rel_paths(matches: &[WorkspaceReferenceMatch]) -> Vec<&str> {
        matches.iter().map(|m| m.rel_path.as_str()).collect()
    }

    async fn resolve(root: &std::path::Path, text: &str) -> Vec<WorkspaceReferenceMatch> {
        resolve_workspace_reference(root.to_string_lossy().to_string(), text.to_string())
            .await
            .expect("resolve_workspace_reference")
    }

    #[tokio::test]
    async fn resolve_exact_relative_match_beats_suffix_ambiguity() {
        let root = tempfile::tempdir().expect("root");
        write_file(root.path(), "src/pointer/menu.tsx", "x");
        write_file(root.path(), "vendor/src/pointer/menu.tsx", "x");

        // Full relative path: exact hit wins even though a suffix twin exists.
        let matches = resolve(root.path(), "src/pointer/menu.tsx").await;
        assert_eq!(rel_paths(&matches), vec!["src/pointer/menu.tsx"]);

        // Suffix-only reference (emitted relative to a subdirectory) resolves.
        let matches = resolve(root.path(), "pointer/menu.tsx").await;
        assert_eq!(
            rel_paths(&matches),
            vec!["src/pointer/menu.tsx", "vendor/src/pointer/menu.tsx"]
        );
    }

    #[tokio::test]
    async fn resolve_bare_filename_matches_all_carriers() {
        let root = tempfile::tempdir().expect("root");
        write_file(root.path(), "src/a/task.json", "{}");
        write_file(root.path(), "src/b/task.json", "{}");

        let matches = resolve(root.path(), "task.json").await;
        assert_eq!(
            rel_paths(&matches),
            vec!["src/a/task.json", "src/b/task.json"]
        );
    }

    #[tokio::test]
    async fn resolve_directory_reference() {
        let root = tempfile::tempdir().expect("root");
        write_file(root.path(), "src/components/launchbar/registry.tsx", "x");

        let matches = resolve(root.path(), "src/components/launchbar").await;
        assert_eq!(rel_paths(&matches), vec!["src/components/launchbar"]);
        assert_eq!(matches[0].kind, WorkspaceEntryKind::Dir);
    }

    #[tokio::test]
    async fn resolve_gitignored_file_still_resolves() {
        let root = tempfile::tempdir().expect("root");
        write_file(root.path(), ".gitignore", ".trellis\n");
        write_file(root.path(), ".trellis/tasks/09-05/task.json", "{}");

        let matches = resolve(root.path(), ".trellis/tasks/09-05/task.json").await;
        assert_eq!(rel_paths(&matches), vec![".trellis/tasks/09-05/task.json"]);
    }

    #[tokio::test]
    async fn resolve_absolute_reference_inside_and_outside_root() {
        let root = tempfile::tempdir().expect("root");
        write_file(root.path(), "src/main.rs", "fn main() {}");

        let abs = root.path().join("src/main.rs");
        let matches = resolve(root.path(), &abs.to_string_lossy()).await;
        assert_eq!(rel_paths(&matches), vec!["src/main.rs"]);
        assert_eq!(matches[0].kind, WorkspaceEntryKind::File);

        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("notes.md"), b"hi").expect("write");
        let matches = resolve(
            root.path(),
            &outside.path().join("notes.md").to_string_lossy(),
        )
        .await;
        // Outside the root there is no rel path; abs doubles as identity.
        assert_eq!(matches.len(), 1);
        assert!(matches[0].rel_path.contains("notes.md"));
    }

    #[tokio::test]
    async fn resolve_missing_and_buildproduct_references() {
        let root = tempfile::tempdir().expect("root");
        write_file(root.path(), "node_modules/pkg/index.js", "junk");

        assert!(resolve(root.path(), "does/not/exist.ts").await.is_empty());
        // Hardcoded build-product dirs stay pruned even without gitignore.
        assert!(resolve(root.path(), "pkg/index.js").await.is_empty());
    }

    #[tokio::test]
    async fn resolve_trailing_slash_and_backslashes() {
        let root = tempfile::tempdir().expect("root");
        write_file(root.path(), "src/components/launchbar/registry.tsx", "x");

        let matches = resolve(root.path(), "src/components/launchbar/").await;
        assert_eq!(rel_paths(&matches), vec!["src/components/launchbar"]);

        let matches = resolve(root.path(), "src\\components\\launchbar\\registry.tsx").await;
        assert_eq!(
            rel_paths(&matches),
            vec!["src/components/launchbar/registry.tsx"]
        );
    }
}
