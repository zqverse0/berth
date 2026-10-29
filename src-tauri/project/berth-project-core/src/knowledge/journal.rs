//! Jev 写入：会话分类命中的原文直接追加进 `.berth/knowledge/记录/<类名>.md`（纠正 / 坑 / 决定），
//! 不经候选与审核；这些是线索，由 Agent 按知识库维护流程整理成笔记。
//!
//! 每条一个 `<!-- jev:<id> -->…<!-- /jev -->` 块，撤销 / 改类按 id 找块。
//! 每次写入记一行 `.berth/local/jev/log.jsonl`，「记忆 → Jev 动态」从这里列出。

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::classifier::{Config, Hit};
use super::service::VAULT_DIR;

pub(super) const RECORD_DIR: &str = "记录";
/// 会话交接目录（[`super::handoff`] 写），不算知识笔记。
pub(super) const HANDOFF_DIR: &str = "交接";
const LOG: &str = ".berth/local/jev/log.jsonl";

/// 命中来自哪个会话。
#[derive(Debug, Clone)]
pub struct Source {
    pub expert: String,
    pub agent: String,
    pub session_id: String,
    pub task: Option<String>,
}

/// 一次写入（日志一行）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub at: String,
    pub category: String,
    /// 类名（写入时的），文件与界面显示用
    pub name: String,
    pub score: f64,
    pub text: String,
    pub expert: String,
    pub agent: String,
    pub session_id: String,
    /// 第几问，与会话页一致（从 1 起，0 是开场）
    pub turn: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    /// 写到的文件，主项目相对路径
    pub file: String,
    /// 已撤销：块已从文件删掉，日志留着供查看
    #[serde(default)]
    pub undone: bool,
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// 原文的哈希前 8 位：同一段原文只记一次（不论哪一类）。
fn entry_id(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(4).map(|byte| format!("{byte:02x}")).collect()
}

/// 类名用作文件名，不能带路径分隔符等。
fn file_component(name: &str) -> io::Result<&str> {
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(invalid(format!("不能用作文件名：{name}")));
    }
    Ok(name)
}

/// 这一类命中写到哪个文件（主项目相对）。
fn target(name: &str) -> io::Result<String> {
    Ok(format!("{VAULT_DIR}/{RECORD_DIR}/{}.md", file_component(name)?))
}

fn header(file: &str) -> String {
    let title = Path::new(file).file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    format!(
        "# {title}\n\nBerth 会话分类（Jev）从专家会话里自动记下的原文，按时间追加；撤销、改类在「记忆 → Jev 动态」，也可以直接改这个文件。\n"
    )
}

fn block(entry: &Entry) -> String {
    let at = entry.at.get(5..16).unwrap_or(&entry.at).replace('T', " ");
    let session: String = entry.session_id.chars().take(8).collect();
    format!(
        "\n<!-- jev:{} -->\n**{at} · {}** · {:.2} · {} · 会话 {session} 第 {} 问\n\n{}\n<!-- /jev -->\n",
        entry.id,
        entry.name,
        entry.score,
        entry.expert,
        entry.turn,
        entry.text.trim(),
    )
}

pub(super) fn write_file(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    crate::tasks::fsutil::atomic_write(path, text.as_bytes()).map_err(|error| io::Error::other(error.message))
}

fn append_block(main: &Path, entry: &Entry) -> io::Result<()> {
    let path = main.join(&entry.file);
    let mut text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => header(&entry.file),
        Err(error) => return Err(error),
    };
    text.push_str(&block(entry));
    write_file(&path, &text)
}

/// 从文件里删掉某条的块；文件或块不在（用户手动删过）时什么都不做。
fn remove_block(main: &Path, entry: &Entry) -> io::Result<()> {
    let path = main.join(&entry.file);
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let open = format!("\n<!-- jev:{} -->\n", entry.id);
    let Some(start) = text.find(&open) else {
        return Ok(());
    };
    let close = "<!-- /jev -->\n";
    let end = text[start + open.len()..].find(close).map_or(text.len(), |at| start + open.len() + at + close.len());
    write_file(&path, &format!("{}{}", &text[..start], &text[end..]))
}

/// 全部写入记录，旧的在前；坏行跳过。
pub(super) fn read_log(main: &Path) -> io::Result<Vec<Entry>> {
    match fs::read_to_string(main.join(LOG)) {
        Ok(text) => Ok(text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn write_log(main: &Path, entries: &[Entry]) -> io::Result<()> {
    let mut text = String::new();
    for entry in entries {
        text.push_str(&serde_json::to_string(entry)?);
        text.push('\n');
    }
    write_file(&main.join(LOG), &text)
}

/// 把一轮的命中写进文件；同一类同一句已记过（未撤销）的跳过。返回实际写入的。
// ponytail: 读改写整文件、无锁；同一项目只有一个 GUI 写入，多实例同时分类再加锁。
pub fn write(main: &Path, config: &Config, source: &Source, turn: usize, at: &str, hits: &[Hit]) -> io::Result<Vec<Entry>> {
    let mut log = read_log(main)?;
    let mut written = Vec::new();
    for hit in hits {
        let Some(category) = config.categories.iter().find(|category| category.id == hit.category) else {
            continue;
        };
        let id = entry_id(&hit.text);
        if log.iter().any(|entry| entry.id == id && !entry.undone) {
            continue;
        }
        let entry = Entry {
            id,
            at: at.to_owned(),
            category: category.id.clone(),
            name: category.name.clone(),
            score: hit.score,
            text: hit.text.clone(),
            expert: source.expert.clone(),
            agent: source.agent.clone(),
            session_id: source.session_id.clone(),
            turn,
            task: source.task.clone(),
            file: target(&category.name)?,
            undone: false,
        };
        append_block(main, &entry)?;
        log.retain(|old| old.id != entry.id);
        log.push(entry.clone());
        written.push(entry);
    }
    if !written.is_empty() {
        write_log(main, &log)?;
    }
    Ok(written)
}

/// 最近的写入，新的在前。
pub fn recent(main: &Path, limit: usize) -> io::Result<Vec<Entry>> {
    let mut log = read_log(main)?;
    log.reverse();
    log.truncate(limit);
    Ok(log)
}

/// 撤销：从文件删掉这条，日志里标记已撤销。
pub fn undo(main: &Path, id: &str) -> io::Result<Entry> {
    let mut log = read_log(main)?;
    let entry = log
        .iter_mut()
        .find(|entry| entry.id == id && !entry.undone)
        .ok_or_else(|| invalid(format!("没有这条写入：{id}")))?;
    remove_block(main, entry)?;
    entry.undone = true;
    let undone = entry.clone();
    write_log(main, &log)?;
    Ok(undone)
}

/// 改类：从原文件删掉，按新类别写到对应文件；日志里原条目换成新的。
pub fn recategorize(main: &Path, config: &Config, id: &str, category: &str) -> io::Result<Entry> {
    let mut log = read_log(main)?;
    let index = log
        .iter()
        .position(|entry| entry.id == id && !entry.undone)
        .ok_or_else(|| invalid(format!("没有这条写入：{id}")))?;
    let next = config
        .categories
        .iter()
        .find(|item| item.id == category)
        .ok_or_else(|| invalid(format!("没有这个类别：{category}")))?;
    let old = log[index].clone();
    let entry = Entry {
        category: next.id.clone(),
        name: next.name.clone(),
        file: target(&next.name)?,
        ..old.clone()
    };
    remove_block(main, &old)?;
    append_block(main, &entry)?;
    log[index] = entry.clone();
    write_log(main, &log)?;
    Ok(entry)
}

/// 这个文件是 Berth 自动写的（`记录/`、`交接/`），不算知识笔记。
pub(super) fn is_journal(vault_root: &Path, path: &Path) -> bool {
    path.starts_with(vault_root.join(RECORD_DIR)) || path.starts_with(vault_root.join(HANDOFF_DIR))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(category: &str, text: &str) -> Hit {
        Hit { category: category.into(), text: text.into(), score: 0.93 }
    }

    #[test]
    fn writes_records_then_undoes_and_moves() {
        let main = tempfile::tempdir().unwrap();
        let main = main.path();
        let config = Config::default();
        let source = Source { expert: "dev-expert".into(), agent: "claude".into(), session_id: "abcdef123".into(), task: None };
        let written = write(
            main,
            &config,
            &source,
            2,
            "2026-10-14T13:26:00Z",
            &[hit("correction", "以后只用 bash"), hit("pitfall", "报错 E0369：缺 PartialEq，改用 matches!")],
        )
        .unwrap();
        assert_eq!(written[0].file, ".berth/knowledge/记录/纠正.md");
        assert_eq!(written[1].file, ".berth/knowledge/记录/坑.md");
        let record = fs::read_to_string(main.join(&written[0].file)).unwrap();
        assert!(record.starts_with("# 纠正\n"));
        assert!(record.contains("**10-14 13:26 · 纠正** · 0.93 · dev-expert · 会话 abcdef12 第 2 问\n\n以后只用 bash\n"));

        // 同一段原文不重复记，换一类也不记。
        assert!(write(main, &config, &source, 3, "t", &[hit("decision", "以后只用 bash")]).unwrap().is_empty());

        let moved = recategorize(main, &config, &written[0].id, "decision").unwrap();
        assert_eq!(moved.file, ".berth/knowledge/记录/决定.md");
        assert!(!fs::read_to_string(main.join(&written[0].file)).unwrap().contains("以后只用 bash"));
        assert!(fs::read_to_string(main.join(&moved.file)).unwrap().contains("以后只用 bash"));

        undo(main, &moved.id).unwrap();
        assert!(!fs::read_to_string(main.join(&moved.file)).unwrap().contains("以后只用 bash"));
        let log = recent(main, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert!(log.iter().any(|entry| entry.undone && entry.category == "decision"));
        assert!(undo(main, &moved.id).is_err());

        // 撤销后可以重新记。
        assert_eq!(write(main, &config, &source, 4, "t", &[hit("decision", "以后只用 bash")]).unwrap().len(), 1);
    }
}
