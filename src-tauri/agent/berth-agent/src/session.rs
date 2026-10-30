//! 会话文件：一个会话一个 `<名字>.jsonl`，一轮一行，放在调用方给的目录里；名字最大的是当前会话。
//! 每行至少有 `messages`（这一轮的完整消息，可原样交给 [`crate::Agent::restore`]），其余字段由调用方定。

use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ChatMessage;

const EXTENSION: &str = "jsonl";

/// 目录里的会话名，新的在前。目录不存在为空。
pub fn list(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension()? == EXTENSION)
                .then(|| path.file_stem()?.to_str().map(str::to_owned))?
        })
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    names
}

pub fn path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.{EXTENSION}"))
}

/// 当前会话；还没有就以 `name` 新建（空文件）。
pub fn current_or_create(dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    match list(dir).first() {
        Some(current) => Ok(path(dir, current)),
        None => create(dir, name),
    }
}

/// 新建一个空会话（已存在就沿用）。
pub fn create(dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let file = path(dir, name);
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)?;
    Ok(file)
}

/// 追加一轮。
pub fn append(file: &Path, line: &Value) -> std::io::Result<()> {
    let mut text = serde_json::to_string(line)?;
    text.push('\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?
        .write_all(text.as_bytes())
}

/// 会话的各轮（读不了的行跳过：写到一半断电之类）。
pub fn lines(file: &Path) -> Vec<Value> {
    fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// 会话的第一轮（列会话时取标题用，不读整个文件）。
pub fn first(file: &Path) -> Option<Value> {
    let mut line = String::new();
    std::io::BufReader::new(fs::File::open(file).ok()?)
        .read_line(&mut line)
        .ok()?;
    serde_json::from_str(&line).ok()
}

/// 会话里全部轮次的消息，按顺序接起来。
pub fn messages(file: &Path) -> Vec<ChatMessage> {
    lines(file)
        .into_iter()
        .filter_map(|mut line| {
            serde_json::from_value::<Vec<ChatMessage>>(line["messages"].take()).ok()
        })
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_newest_session_is_current_and_keeps_its_turns_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("project");
        let first = current_or_create(&sessions, "20261029-100000").unwrap();
        assert_eq!(list(&sessions), ["20261029-100000"]);

        let turn = |ask: &str, answer: &str| json!({ "messages": [ChatMessage::user(ask), ChatMessage::assistant(answer)] });
        append(&first, &turn("q1", "a1")).unwrap();
        append(&first, &turn("q2", "a2")).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&first)
            .unwrap()
            .write_all(b"{broken\n")
            .unwrap();
        assert_eq!(
            super::first(&first).unwrap()["messages"][0],
            json!(ChatMessage::user("q1"))
        );
        let restored = messages(&first);
        assert_eq!(restored.len(), 4);
        assert_eq!(restored[2].content.first_text(), Some("q2"));

        // /new：新会话成为当前，旧会话还在。
        let second = create(&sessions, "20261030-090000").unwrap();
        assert_eq!(current_or_create(&sessions, "ignored").unwrap(), second);
        assert_eq!(list(&sessions), ["20261030-090000", "20261029-100000"]);
        assert!(messages(&second).is_empty());
    }
}
