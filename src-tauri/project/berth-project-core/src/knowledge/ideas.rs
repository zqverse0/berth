//! 想法：用户随手记的想法 / 问题，一条一个文件 `<vault>/想法/<创建时间>.md`。
//! 固定三块：用户原话 / `## 讨论` / `## 结论`。原话不改；讨论与结论由 Agent 填，结论落到笔记、任务或提交。
//! 不进知识笔记的扫描（不算孤立、不判过期），由面板「想法」与 `berth knowledge idea` 读写。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::Local;

use super::model::Idea;
use super::parser::{parse_markdown, split_frontmatter};
use super::service::{invalid, is_markdown, modified_secs, replace_status, VAULT_DIR};

pub(super) const IDEAS_DIR: &str = "想法";
/// 已落地 / 已放下的想法移到这里，面板默认不列，像任务归档一样不干扰阅读。
const ARCHIVE_DIR: &str = "归档";
const CLOSED: [&str; 2] = ["已落地", "已放下"];
pub const IDEA_STATUSES: [&str; 4] = ["待讨论", "讨论中", "已落地", "已放下"];
const MAX_IDEA_BYTES: usize = 16 * 1024;

fn ideas_dir(project_root: &Path) -> PathBuf {
    project_root.join(VAULT_DIR).join(IDEAS_DIR)
}

/// 全部想法（含归档），新的在前。
pub fn list(project_root: &Path) -> io::Result<Vec<Idea>> {
    let dir = ideas_dir(project_root);
    let mut ideas = [dir.clone(), dir.join(ARCHIVE_DIR)]
        .iter()
        .filter_map(|dir| fs::read_dir(dir).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_markdown(path))
        .filter_map(|path| read(project_root, &path).ok())
        .collect::<Vec<_>>();
    ideas.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(ideas)
}

/// 记一条想法；正文里的 `#标签` 收进 `tags`。
pub fn add(project_root: &Path, text: &str) -> io::Result<Idea> {
    let text = text.trim();
    if text.is_empty() || text.len() > MAX_IDEA_BYTES {
        return Err(invalid("Idea text must be 1-16384 bytes"));
    }
    if !project_root.join(VAULT_DIR).is_dir() {
        return Err(invalid(
            "Knowledge base is not enabled; run `berth init` first",
        ));
    }
    let dir = ideas_dir(project_root);
    fs::create_dir_all(&dir)?;
    let stamp = Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    let path = (1..)
        .map(|n| match n {
            1 => dir.join(format!("{stamp}.md")),
            n => dir.join(format!("{stamp}-{n}.md")),
        })
        .find(|path| !path.exists())
        .expect("unbounded");
    let tags = hashtags(text);
    let tags = if tags.is_empty() {
        String::new()
    } else {
        format!("tags: [{}]\n", tags.join(", "))
    };
    fs::write(
        &path,
        format!("---\ntype: 想法\nstatus: 待讨论\n{tags}---\n\n{text}\n\n## 讨论\n\n## 结论\n"),
    )?;
    read(project_root, &path)
}

/// 想法全文；`id` 是文件名（不含 `.md`）。
pub fn show(project_root: &Path, id: &str) -> io::Result<Option<String>> {
    match file(project_root, id) {
        Some(path) => fs::read_to_string(path).map(Some),
        None => Ok(None),
    }
}

pub fn set_status(project_root: &Path, id: &str, status: &str) -> io::Result<Idea> {
    if !IDEA_STATUSES.contains(&status) {
        return Err(invalid(&format!(
            "Unsupported idea status; use one of {}",
            IDEA_STATUSES.join(" | ")
        )));
    }
    let path = file(project_root, id).ok_or_else(|| invalid("Idea not found"))?;
    let content = fs::read_to_string(&path)?;
    fs::write(&path, replace_status(&content, status))?;
    read(project_root, &place(project_root, &path, status)?)
}

/// 关闭的放进归档，重新打开的移回来；返回移动后的路径。
fn place(project_root: &Path, path: &Path, status: &str) -> io::Result<PathBuf> {
    let dir = ideas_dir(project_root);
    let target = if CLOSED.contains(&status) { dir.join(ARCHIVE_DIR) } else { dir };
    if path.parent() == Some(target.as_path()) {
        return Ok(path.to_path_buf());
    }
    fs::create_dir_all(&target)?;
    let moved = target.join(path.file_name().unwrap_or_default());
    fs::rename(path, &moved)?;
    Ok(moved)
}

/// 想法的结论：落到笔记 / 任务 / 提交算已落地，放下要写理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conclusion {
    Note(String),
    Task(String),
    Commit(String),
    Drop(String),
}

/// 在 `## 讨论` 下追加 `- MM-DD 作者：一句话`；待讨论的随之改为讨论中。
pub fn discuss(project_root: &Path, id: &str, author: &str, text: &str) -> io::Result<Idea> {
    let text = one_line(text)?;
    let author = author.trim();
    if author.is_empty() {
        return Err(invalid("Author must not be empty"));
    }
    let path = file(project_root, id).ok_or_else(|| invalid("Idea not found"))?;
    let content = fs::read_to_string(&path)?;
    let date = Local::now().format("%m-%d");
    let mut next = append_line(&content, "讨论", &format!("- {date} {author}：{text}"));
    if parse_markdown(&content).status.as_deref().unwrap_or("待讨论") == "待讨论" {
        next = replace_status(&next, "讨论中");
    }
    fs::write(&path, next)?;
    read(project_root, &path)
}

/// 在 `## 结论` 下写结论并关闭：放下 → 已放下，其余 → 已落地。
pub fn close(project_root: &Path, id: &str, conclusion: &Conclusion) -> io::Result<Idea> {
    let (line, status) = match conclusion {
        Conclusion::Note(title) => (format!("→ [[{}]]", one_line(title)?), "已落地"),
        Conclusion::Task(slug) => (format!("→ 任务 {}", one_line(slug)?), "已落地"),
        Conclusion::Commit(sha) => (format!("→ 提交 {}", one_line(sha)?), "已落地"),
        Conclusion::Drop(reason) => (format!("放下：{}", one_line(reason)?), "已放下"),
    };
    let path = file(project_root, id).ok_or_else(|| invalid("Idea not found"))?;
    let content = fs::read_to_string(&path)?;
    fs::write(&path, replace_status(&append_line(&content, "结论", &line), status))?;
    read(project_root, &place(project_root, &path, status)?)
}

/// 想法的（原话，讨论各行）：升级成任务时带进任务的「背景」。
pub fn background(project_root: &Path, id: &str) -> io::Result<Option<(String, String)>> {
    let Some(path) = file(project_root, id) else {
        return Ok(None);
    };
    let content = fs::read_to_string(&path)?;
    let text = read(project_root, &path)?.text;
    let discussion = section(split_frontmatter(&content).1, "讨论");
    Ok(Some((text, discussion)))
}

/// `## <heading>` 小节的正文（去掉首尾空行）。
fn section(body: &str, heading: &str) -> String {
    let marker = format!("\n## {heading}\n");
    let padded = format!("\n{body}");
    let Some(start) = padded.find(&marker) else {
        return String::new();
    };
    let rest = &padded[start + marker.len()..];
    rest[..rest.find("\n## ").unwrap_or(rest.len())].trim().to_owned()
}

fn one_line(text: &str) -> io::Result<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.len() > MAX_IDEA_BYTES {
        return Err(invalid("Text must be 1-16384 bytes"));
    }
    Ok(text)
}

/// 把一行追加到 `## <heading>` 小节末尾；旧文件没有这一节就补在文末。
fn append_line(content: &str, heading: &str, line: &str) -> String {
    let marker = format!("\n## {heading}\n");
    let Some(start) = content.find(&marker) else {
        return format!("{}\n\n## {heading}\n\n{line}\n", content.trim_end());
    };
    let body = start + marker.len();
    let end = content[body..].find("\n## ").map_or(content.len(), |at| body + at);
    let section = content[body..end].trim_end();
    let (head, rest) = (&content[..body], &content[end..]);
    if section.trim().is_empty() {
        format!("{head}\n{line}\n{rest}")
    } else {
        format!("{head}{section}\n{line}\n{rest}")
    }
}

fn file(project_root: &Path, id: &str) -> Option<PathBuf> {
    let id = id.trim_end_matches(".md");
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return None;
    }
    let dir = ideas_dir(project_root);
    [dir.clone(), dir.join(ARCHIVE_DIR)]
        .into_iter()
        .map(|dir| dir.join(format!("{id}.md")))
        .find(|path| is_markdown(path))
}

fn read(project_root: &Path, path: &Path) -> io::Result<Idea> {
    let content = fs::read_to_string(path)?;
    let parsed = parse_markdown(&content);
    let body = split_frontmatter(&content).1;
    // 用户原话：第一个二级标题（`## 讨论` 等）之前。
    let text = body
        .split("\n## ")
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(Idea {
        id: path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned(),
        path: path
            .strip_prefix(project_root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/"),
        status: parsed.status.unwrap_or_else(|| "待讨论".into()),
        tags: parsed.tags,
        text,
        modified_at: modified_secs(&fs::metadata(path)?),
    })
}

fn hashtags(text: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for word in text.split_whitespace() {
        let Some(tag) = word.strip_prefix('#') else {
            continue;
        };
        // 标签到第一个标点为止：`#性能，想想` → `性能`。
        let tag: String = tag
            .chars()
            .take_while(|c| c.is_alphanumeric() || "-_/".contains(*c))
            .collect();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_list_show_and_set_status() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(add(root, "x").is_err(), "需要已启用的知识库");
        fs::create_dir_all(root.join(VAULT_DIR)).unwrap();
        assert!(add(root, "  ").is_err());

        let first = add(root, "切项目太慢 #性能，想想缓存 #性能 #UI").unwrap();
        let second = add(root, "第二条").unwrap();
        assert_eq!(first.tags, ["性能", "UI"]);
        assert_eq!(first.status, "待讨论");
        assert!(first.path.starts_with(".berth/knowledge/想法/"));
        let content = fs::read_to_string(root.join(&second.path)).unwrap();
        assert!(content.ends_with("---\n\n第二条\n\n## 讨论\n\n## 结论\n"), "固定三块：{content}");
        assert_ne!(first.id, second.id, "同一秒也不覆盖");

        // Agent 追加的讨论不算原话；第一次讨论把待讨论改成讨论中。
        let discussed = discuss(root, &first.id, "Agent", "先测量\n再说").unwrap();
        assert_eq!(discussed.status, "讨论中");
        discuss(root, &first.id, "用户", "同意").unwrap();
        let content = fs::read_to_string(root.join(&first.path)).unwrap();
        let date = Local::now().format("%m-%d");
        assert!(
            content.contains(&format!("## 讨论\n\n- {date} Agent：先测量 再说\n- {date} 用户：同意\n\n## 结论\n")),
            "{content}"
        );
        assert!(discuss(root, &first.id, " ", "x").is_err());
        let ideas = list(root).unwrap();
        assert_eq!(ideas.len(), 2);
        let listed = ideas.iter().find(|idea| idea.id == first.id).unwrap();
        assert_eq!(listed.text, "切项目太慢 #性能，想想缓存 #性能 #UI");

        let idea = close(root, &first.id, &Conclusion::Task("10-17-cache".into())).unwrap();
        assert_eq!(idea.status, "已落地");
        assert!(idea.path.starts_with(".berth/knowledge/想法/归档/"), "关闭即归档：{}", idea.path);
        assert!(!root.join(&first.path).exists());
        let content = fs::read_to_string(root.join(&idea.path)).unwrap();
        assert!(content.ends_with("## 结论\n\n→ 任务 10-17-cache\n"), "{content}");
        let dropped = close(root, &second.id, &Conclusion::Drop("不需要".into())).unwrap();
        assert_eq!(dropped.status, "已放下");
        // 改回待讨论就移出归档；列表仍含归档里的。
        let reopened = set_status(root, &second.id, "待讨论").unwrap();
        assert_eq!(reopened.path, second.path);
        assert_eq!(list(root).unwrap().len(), 2);
        // 旧文件没有骨架：补上小节。
        let old = root.join(VAULT_DIR).join(IDEAS_DIR).join("2026-01-01-000000.md");
        fs::write(&old, "---\ntype: 想法\nstatus: 讨论中\n---\n\n旧想法\n").unwrap();
        close(root, "2026-01-01-000000", &Conclusion::Note("某决策".into())).unwrap();
        let archived = root.join(VAULT_DIR).join(IDEAS_DIR).join(ARCHIVE_DIR).join("2026-01-01-000000.md");
        assert!(fs::read_to_string(&archived).unwrap().ends_with("旧想法\n\n## 结论\n\n→ [[某决策]]\n"));
        assert!(show(root, &first.id).unwrap().unwrap().contains("## 讨论"));
        assert!(set_status(root, &first.id, "已确认").is_err());
        assert!(show(root, "../x").unwrap().is_none());
        // 想法不算知识笔记。
        assert!(crate::knowledge::snapshot(root)
            .unwrap()
            .documents
            .is_empty());
    }
}
