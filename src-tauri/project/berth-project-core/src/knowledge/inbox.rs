//! 待入库清单 `.berth/knowledge/待入库/`：任务、想法归档时各生成一个文件，等用户说要维护时再逐条处理。
//! 处理后移到 `待入库/已处理/` 并写明结果；计数只算未处理的。这个目录不算笔记（见 `service::is_note`）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::parser::split_frontmatter;
use super::service::VAULT_DIR;
use crate::tasks::fsutil;

pub const DIR: &str = "待入库";
const DONE_DIR: &str = "已处理";
const KINDS: [&str; 2] = ["任务", "想法"];
const RESULTS: [&str; 3] = ["已完成", "已放弃", "已放下"];
const SOURCE_MAX: usize = 128;

/// 一条未处理的待入库。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// 项目相对路径。
    pub path: String,
    pub kind: String,
    /// 来源任务名或想法 id，也是文件名。
    pub source: String,
    pub title: String,
    pub result: String,
    pub archived_at: String,
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn checked_source(source: &str) -> io::Result<String> {
    fsutil::safe_component(source, "inbox source", SOURCE_MAX).map_err(|error| invalid(error.message))
}

fn inbox_dir(main: &Path) -> PathBuf {
    main.join(VAULT_DIR).join(DIR)
}

/// 待入库目录（项目相对），已存在时才有。
pub(super) fn existing_dir(main: &Path) -> Option<String> {
    let dir = inbox_dir(main);
    dir.is_dir().then(|| relative(main, &dir))
}

fn relative(main: &Path, path: &Path) -> String {
    path.strip_prefix(main).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn write(path: &Path, text: &str) -> io::Result<()> {
    fsutil::atomic_write(path, text.as_bytes()).map_err(|error| io::Error::other(error.message))
}

fn compose(map: &serde_yaml::Mapping, body: &str) -> io::Result<String> {
    let frontmatter = serde_yaml::to_string(map).map_err(io::Error::other)?;
    Ok(format!("---\n{frontmatter}---\n\n{}\n", body.trim()))
}

fn parse(main: &Path, path: &Path) -> Option<InboxItem> {
    let text = fs::read_to_string(path).ok()?;
    let frontmatter = split_frontmatter(&text).0?;
    let map: serde_yaml::Mapping = serde_yaml::from_str(frontmatter).ok()?;
    let field = |key: &str| map.get(key).and_then(|value| value.as_str()).unwrap_or_default().to_owned();
    Some(InboxItem {
        path: relative(main, path),
        kind: field("kind"),
        source: field("source"),
        title: field("title"),
        result: field("result"),
        archived_at: field("archived_at"),
    })
}

/// 未处理的待入库，新归档的在前；没有目录时为空，读不了的文件跳过。
pub fn list(main: &Path) -> io::Result<Vec<InboxItem>> {
    let entries = match fs::read_dir(inbox_dir(main)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut items: Vec<InboxItem> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "md"))
        .filter_map(|path| parse(main, &path))
        .collect();
    items.sort_by(|a, b| (&b.archived_at, &a.source).cmp(&(&a.archived_at, &b.source)));
    Ok(items)
}

/// 生成一条待入库；同一来源再次归档时覆盖。
pub fn add(
    main: &Path,
    kind: &str,
    source: &str,
    title: &str,
    result: &str,
    body: &str,
) -> io::Result<InboxItem> {
    let source = checked_source(source)?;
    if !KINDS.contains(&kind) {
        return Err(invalid(format!("Invalid inbox kind: {kind}")));
    }
    if !RESULTS.contains(&result) {
        return Err(invalid(format!("Invalid inbox result: {result}")));
    }
    let mut map = serde_yaml::Mapping::new();
    map.insert("kind".into(), kind.into());
    map.insert("source".into(), source.as_str().into());
    map.insert("title".into(), title.into());
    map.insert("result".into(), result.into());
    map.insert("archived_at".into(), chrono::Local::now().format("%Y-%m-%d").to_string().into());
    let path = inbox_dir(main).join(format!("{source}.md"));
    write(&path, &compose(&map, body)?)?;
    parse(main, &path).ok_or_else(|| io::Error::other("Inbox file is unreadable"))
}

/// 移除一条未处理的待入库（重开时）；已处理的记录不动。返回是否有这一条。
pub fn remove(main: &Path, source: &str) -> io::Result<bool> {
    let path = inbox_dir(main).join(format!("{}.md", checked_source(source)?));
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// 标记处理完：写明结果，移到 `已处理/`（同名的不覆盖），返回新路径（项目相对）。
pub fn done(main: &Path, source: &str, outcome: &str) -> io::Result<String> {
    let source = checked_source(source)?;
    let outcome = outcome.trim();
    if outcome.is_empty() {
        return Err(invalid("Outcome is required".to_owned()));
    }
    let from = inbox_dir(main).join(format!("{source}.md"));
    let text = fs::read_to_string(&from).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => invalid(format!("No inbox item: {source}")),
        _ => error,
    })?;
    let (frontmatter, body) = split_frontmatter(&text);
    let mut map: serde_yaml::Mapping =
        serde_yaml::from_str(frontmatter.unwrap_or_default()).map_err(io::Error::other)?;
    map.insert("processed_at".into(), chrono::Local::now().format("%Y-%m-%d").to_string().into());
    let dir = inbox_dir(main).join(DONE_DIR);
    let mut to = dir.join(format!("{source}.md"));
    let mut index = 2;
    while to.exists() {
        to = dir.join(format!("{source}-{index}.md"));
        index += 1;
    }
    write(&to, &compose(&map, &format!("{}\n\n## 处理结果\n\n{outcome}", body.trim()))?)?;
    fs::remove_file(&from)?;
    Ok(relative(main, &to))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_count_until_processed_and_removal_spares_processed_records() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path();
        assert!(list(main).unwrap().is_empty());
        let item = add(main, "想法", "2026-11-07-101500", "标题: 带冒号", "已放下", "正文").unwrap();
        assert_eq!(item.path, ".berth/knowledge/待入库/2026-11-07-101500.md");
        assert_eq!(item.title, "标题: 带冒号");
        add(main, "任务", "11-07-demo", "T", "已完成", "").unwrap();
        assert_eq!(list(main).unwrap().len(), 2);

        let processed = done(main, "11-07-demo", "写入 [[决策A]]").unwrap();
        assert_eq!(processed, ".berth/knowledge/待入库/已处理/11-07-demo.md");
        let text = fs::read_to_string(main.join(&processed)).unwrap();
        assert!(text.contains("processed_at:") && text.ends_with("## 处理结果\n\n写入 [[决策A]]\n"), "{text}");
        assert_eq!(list(main).unwrap().len(), 1, "已处理的不计数");

        // 重开只移除未处理的。再归档、再处理时不覆盖旧记录。
        assert!(!remove(main, "11-07-demo").unwrap());
        assert!(main.join(&processed).is_file());
        add(main, "任务", "11-07-demo", "T", "已完成", "").unwrap();
        assert!(remove(main, "11-07-demo").unwrap());
        add(main, "任务", "11-07-demo", "T", "已完成", "").unwrap();
        assert!(done(main, "11-07-demo", "不入库").unwrap().ends_with("11-07-demo-2.md"));
    }

    #[test]
    fn rejects_unknown_values_and_unsafe_sources() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(add(tmp.path(), "别的", "a", "t", "已完成", "").is_err());
        assert!(add(tmp.path(), "任务", "a", "t", "完成", "").is_err());
        assert!(add(tmp.path(), "任务", "../x", "t", "已完成", "").is_err());
        assert!(remove(tmp.path(), "../x").is_err());
        assert!(done(tmp.path(), "missing", "x").is_err());
        add(tmp.path(), "任务", "a", "t", "已完成", "").unwrap();
        assert!(done(tmp.path(), "a", "  ").is_err());
    }
}
