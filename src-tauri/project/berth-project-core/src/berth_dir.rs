//! 空间目录骨架：任务、知识库与运行态 `local/`。解析范围时（[`crate::tasks::resolve`]）用 [`ensure_space`] 补齐。

use std::fs;
use std::io;
use std::path::Path;

/// 骨架：相对空间目录的路径与文件内容；`None` 表示目录。
const LAYOUT: &[(&str, Option<&str>)] = &[
    ("tasks", None),
    (
        "knowledge/README.md",
        Some(include_str!("../templates/knowledge-README.md")),
    ),
    ("local", None),
];

/// 补齐空间目录骨架，返回本次新建的相对路径。幂等：已有的不覆盖。
pub fn ensure_space(base: &Path) -> io::Result<Vec<String>> {
    let mut created = Vec::new();
    for (relative, content) in LAYOUT {
        let path = base.join(relative);
        if path.exists() {
            continue;
        }
        let dir = if content.is_some() {
            path.parent().unwrap_or(base)
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

#[cfg(test)]
mod tests {
    use super::ensure_space;
    use std::fs;

    #[test]
    fn ensure_space_creates_the_skeleton_once_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let created = ensure_space(root.path()).unwrap();
        assert_eq!(created, ["tasks", "knowledge/README.md", "local"]);

        let readme = root.path().join("knowledge/README.md");
        fs::write(&readme, "mine").unwrap();
        assert!(ensure_space(root.path()).unwrap().is_empty());
        assert_eq!(fs::read_to_string(readme).unwrap(), "mine");
    }
}
