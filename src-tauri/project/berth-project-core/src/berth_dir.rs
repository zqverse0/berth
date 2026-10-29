//! 项目里的 `.berth/` 工作流目录：任务、知识库（进 git）与本机运行态 `local/`（不进 git）。
//!
//! [`init`] 是它唯一的创建入口：CLI `berth init` 与 GUI「启用 Berth」都调这里，
//! 其他命令遇到未启用的项目只报错、不隐式创建。
//! 契约见 `.berth/tasks/10-04-berth-project-dir/prd.md` §4。

use std::fs;
use std::io;
use std::path::Path;

/// 骨架：相对 `.berth/` 的路径与文件内容；`None` 表示目录。
const LAYOUT: &[(&str, Option<&str>)] = &[
    (
        "README.md",
        Some(include_str!("../templates/berth-README.md")),
    ),
    ("tasks", None),
    (
        "knowledge/README.md",
        Some(include_str!("../templates/knowledge-README.md")),
    ),
    ("local/.gitignore", Some("*\n")),
    // 主项目标记：同一仓库的 worktree 都把实时状态、群放到这份 checkout（见 `tasks::main_project`）。
    ("local/hub.json", Some("{\"version\": 1}\n")),
];

/// 在 `root` 下补齐 `.berth/` 骨架，返回本次新建的相对路径。幂等：已有的不覆盖。
pub fn init(root: &Path) -> io::Result<Vec<String>> {
    if !root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} is not a directory", root.display()),
        ));
    }
    let base = root.join(".berth");
    if fs::symlink_metadata(&base).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is a symlink", base.display()),
        ));
    }
    if let Some(hub) = crate::tasks::hub_elsewhere(root) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "{} 已是本仓库的主项目（hub）：worktree 不需要 berth init，任务、知识库与运行态都用主项目的",
                hub.display()
            ),
        ));
    }
    let mut created = Vec::new();
    for (relative, content) in LAYOUT {
        let path = base.join(relative);
        if path.exists() {
            continue;
        }
        let dir = if content.is_some() {
            path.parent().unwrap_or(&base)
        } else {
            &path
        };
        fs::create_dir_all(dir)?;
        if let Some(text) = content {
            fs::write(&path, text)?;
        }
        created.push((*relative).to_owned());
    }
    Ok(created)
}

/// 从 `dir` 往上找含 `.berth/` 的项目根，到 git 仓库根为止。
/// 跳过家目录：`~/.berth` 是 Berth 全局目录，不是项目标记；否则家目录下没有 git 的项目
/// （含 sshfs 挂载的设备目录）都会归到家目录，读到别处的群和任务。
pub fn project_root(dir: &Path) -> Option<&Path> {
    project_root_with_home(dir, dirs::home_dir().as_deref())
}

fn project_root_with_home<'a>(dir: &'a Path, home: Option<&Path>) -> Option<&'a Path> {
    for dir in dir.ancestors() {
        if Some(dir) != home && dir.join(".berth").is_dir() {
            return Some(dir);
        }
        if dir.join(".git").exists() {
            return None;
        }
    }
    None
}

/// `dir` 所在项目是否已启用 Berth。
pub fn enabled_at(dir: &Path) -> bool {
    project_root(dir).is_some()
}

#[cfg(test)]
mod tests {
    use super::{enabled_at, init, project_root_with_home};
    use std::fs;

    #[test]
    fn init_creates_the_skeleton_once_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        assert!(!enabled_at(root.path()));
        let created = init(root.path()).unwrap();
        assert_eq!(
            created,
            [
                "README.md",
                "tasks",
                "knowledge/README.md",
                "local/.gitignore",
                "local/hub.json"
            ]
        );
        assert!(root.path().join(".berth/tasks").is_dir());
        assert!(enabled_at(&root.path().join(".berth/tasks")));

        let readme = root.path().join(".berth/knowledge/README.md");
        fs::write(&readme, "mine").unwrap();
        assert!(init(root.path()).unwrap().is_empty());
        assert_eq!(fs::read_to_string(readme).unwrap(), "mine");
    }

    #[test]
    fn lookup_stops_at_the_git_root() {
        let outer = tempfile::tempdir().unwrap();
        fs::create_dir(outer.path().join(".berth")).unwrap();
        let repo = outer.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        assert!(!enabled_at(&repo));
    }

    #[test]
    fn home_berth_dir_is_not_a_project_marker() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join(".berth")).unwrap();
        let mount = home.path().join(".berth-dev/remote/2/home");
        fs::create_dir_all(&mount).unwrap();
        assert_eq!(project_root_with_home(&mount, Some(home.path())), None);

        fs::create_dir(mount.join(".berth")).unwrap();
        assert_eq!(
            project_root_with_home(&mount.join("sub"), Some(home.path())),
            Some(mount.as_path())
        );
    }
}
