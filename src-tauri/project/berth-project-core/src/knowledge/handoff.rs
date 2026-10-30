//! 会话交接：每个会话一份 `.berth/knowledge/交接/<专家>/<月-日>-<会话前 8 位>.md`，同目录 `索引.md`
//! 放最近一次的「最后的状态」和历次列表（新的在前）。Agent 需要时才读，不注入上下文。
//!
//! Berth 自己拼的：提问清单（每问第一行）、这个会话写进 `记录/` 的条目、同期提交、会话 id。
//! Jev 只挑原文、不改写：回答各段问「做了什么」（最近 [`DONE_TURNS`] 问）和「待办」（最后一问），
//! 两题与会话分类放在同一个请求里。原文照写，不做脱敏（内容由用户自己查看）。阈值来自 10-14 对 A5 三个会话的实测。
//!
//! 每个会话只覆盖自己那份；索引里同一会话那一行原地换掉，别的会话不动。
//! `交接/索引.md` 是项目的固定入口：每个专家一行（最近一次会话），Agent 不用知道自己的专家名。

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::classifier::{own_words, Segment, ANSWER};
use super::journal::{self, HANDOFF_DIR};
use super::service::VAULT_DIR;

pub const INDEX: &str = "索引.md";
/// 「做了什么」从最近这么多问里挑。
pub const DONE_TURNS: usize = 3;
const DONE: &str = "done";
const TODO: &str = "todo";
const THRESHOLD: f64 = 0.85;
const PROMPT_CHARS: usize = 80;
const RECORD_CHARS: usize = 60;
const TITLE_CHARS: usize = 30;
const ASKED_CHARS: usize = 300;

/// 一问里 Jev 挑出的段（原文）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Picked {
    #[serde(default)]
    pub done: Vec<String>,
    #[serde(default)]
    pub todo: Vec<String>,
}

/// 交接题：`from_end`（距会话末尾第几问，最后一问为 0）在最近几问内的回答段问「做了什么」，最后一问再问「待办」。
pub fn questions(segments: &[Segment], from_end: usize) -> Map<String, Value> {
    let mut questions = Map::new();
    for segment in segments.iter().filter(|segment| segment.field == ANSWER) {
        let mut ask = |id: &str, question: &str, yes: &str, no: &str| {
            questions.insert(
                format!("{}.{id}", segment.key),
                json!({
                    "type": "noul",
                    "instructions": format!("只看 `segments.{}` 这一段。{question}", segment.key),
                    "criteria": {"true": yes, "false": no},
                }),
            );
        };
        if from_end < DONE_TURNS {
            ask(
                DONE,
                "这一段是不是在**总结这次已经完成的工作**：做了哪些改动、结果如何、验证情况？",
                "汇报已完成的改动、实现或结论，读者不看会话也能知道做成了什么。",
                "只是过程说明、提问、方案讨论、计划，或者只有一句状态。",
            );
        }
        if from_end == 0 {
            // 实测「没做完」与「下一步」几乎总是同时高分，合成一题。
            ask(
                TODO,
                "这一段是不是在说明**还没做完、需要用户确认或接下来要做的事**：未完成项、未验证、待决定、下一步？",
                "明确列出没做完、未验证、需要用户拍板的事项，或写出下一步要做什么。",
                "说的是已完成的工作、已有结论，或者只是普通的解释。",
            );
        }
    }
    questions
}

/// 按 Jev 答案挑段；同一段两题都过阈值时算待办。
pub fn pick(segments: &[Segment], scores: &BTreeMap<String, f64>) -> Picked {
    let passed = |segment: &Segment, id: &str| scores.get(&format!("{}.{id}", segment.key)).is_some_and(|score| *score >= THRESHOLD);
    let mut picked = Picked::default();
    for segment in segments.iter().filter(|segment| segment.field == ANSWER) {
        if passed(segment, TODO) {
            picked.todo.push(segment.text.clone());
        } else if passed(segment, DONE) {
            picked.done.push(segment.text.clone());
        }
    }
    picked
}

/// 写一份交接需要的会话信息。
pub struct Session<'a> {
    /// 专家名；没选专家时是 Agent 的工具 id。
    pub folder: &'a str,
    pub agent: &'a str,
    pub session_id: &'a str,
    pub title: Option<&'a str>,
    pub started: DateTime<Utc>,
    pub ended: DateTime<Utc>,
    /// 有回答的各问：（第几问，提问原文）。
    pub prompts: Vec<(usize, Option<&'a str>)>,
    /// 第几问 → Jev 挑出的段。
    pub picks: &'a BTreeMap<usize, Picked>,
    /// 会话期间所在目录的提交（`hash 标题`）。
    pub commits: Vec<String>,
    /// 写交接时所在目录未提交的改动（`git status --short`）。
    pub uncommitted: Vec<String>,
    /// 待办取自第几问：最后一个有实质回答的问（「10」「好的」这类短答不算，免得顶掉真正的待办）。
    pub state_turn: usize,
    /// 那一问回答的结尾一段：Jev 没挑出待办时照抄它（待办多写在结尾，宁可多给不能漏）。
    pub last_answer: Option<String>,
}

/// 第一行（去掉标题的 `#`），超长截断。
fn first_line(text: &str, limit: usize) -> String {
    let line = text.trim().lines().next().unwrap_or_default().trim_start_matches('#').trim();
    let short: String = line.chars().take(limit).collect();
    if short.len() < line.len() {
        format!("{short}…")
    } else {
        short
    }
}

fn local(at: DateTime<Utc>) -> String {
    at.with_timezone(&Local).format("%m-%d %H:%M").to_string()
}

/// 「最后的状态」一节（会话文件与索引共用）。
fn state_section(session: &Session) -> String {
    let answered: Vec<usize> = session.prompts.iter().map(|(index, _)| *index).collect();
    let last = session.state_turn;
    let mut text = String::from("### 做了什么（Jev 从最近几问的回答里挑的原文）\n\n");
    let recent = &answered[answered.len().saturating_sub(DONE_TURNS)..];
    let mut any = false;
    for index in recent {
        for part in session.picks.get(index).map(|picked| picked.done.as_slice()).unwrap_or_default() {
            text.push_str(&format!("**第 {index} 问**\n\n{}\n\n", part.trim()));
            any = true;
        }
    }
    if !any {
        text.push_str("最近几问的回答里没有完成汇报，看下面的提问清单。\n\n");
    }
    text.push_str(&format!("### 待办（第 {last} 问）\n\n"));
    // 用户在那一问提的条件（「先别提交」）只读索引也要看得到。
    let asked = session.prompts.iter().find(|(index, _)| *index == last).and_then(|(_, prompt)| *prompt).map(own_words);
    if let Some(asked) = asked.filter(|asked| !asked.is_empty()) {
        let short: String = asked.chars().take(ASKED_CHARS).collect();
        text.push_str(&format!("> 用户：{}\n\n", short.replace('\n', " ")));
    }
    match session.picks.get(&last).map(|picked| picked.todo.as_slice()).filter(|todo| !todo.is_empty()) {
        Some(todo) => {
            for part in todo {
                text.push_str(&format!("{}\n\n", part.trim()));
            }
        }
        None => match session.last_answer.as_deref() {
            Some(end) => text.push_str(&format!("Jev 没挑出待办，这是最后一问回答的结尾原文：\n\n{}\n\n", end.trim())),
            None => text.push_str(&format!("第 {last} 问没有回答。\n\n")),
        },
    }
    if !session.uncommitted.is_empty() {
        text.push_str("### 未提交的改动（写交接时所在目录）\n\n```\n");
        for line in &session.uncommitted {
            text.push_str(&format!("{line}\n"));
        }
        text.push_str("```\n\n");
    }
    text
}

fn session_file(session: &Session) -> String {
    let short: String = session.session_id.chars().take(8).collect();
    format!("{}-{short}.md", session.started.with_timezone(&Local).format("%m-%d"))
}

/// 问数按最后一问的编号（与会话页、提问清单一致；没回答的问也算）。
fn count(session: &Session) -> usize {
    session.prompts.last().map_or(0, |(index, _)| *index)
}

fn session_text(main: &Path, session: &Session) -> io::Result<String> {
    let short: String = session.session_id.chars().take(8).collect();
    let mut text = format!(
        "# 交接：{} · 会话 {short}\n\n{} · {} – {} · {} 问\n\n## 最后的状态\n\n{}",
        session.folder,
        session.agent,
        local(session.started),
        local(session.ended),
        count(session),
        state_section(session),
    );
    text.push_str("## 这次问了什么\n\n");
    for (index, prompt) in &session.prompts {
        if let Some(prompt) = prompt.map(own_words).filter(|prompt| !prompt.is_empty()) {
            text.push_str(&format!("- 第 {index} 问：{}\n", first_line(prompt, PROMPT_CHARS)));
        }
    }
    let records: Vec<_> = journal::read_log(main)?
        .into_iter()
        .filter(|entry| entry.session_id == session.session_id && !entry.undone)
        .collect();
    if !records.is_empty() {
        text.push_str("\n## 记下的纠正、坑、决定\n\n");
        for entry in records {
            let file = entry.file.strip_prefix(&format!("{VAULT_DIR}/")).unwrap_or(&entry.file);
            text.push_str(&format!(
                "- {} · 第 {} 问：{} → [{file}](../../{file})\n",
                entry.name,
                entry.turn,
                first_line(&entry.text, RECORD_CHARS)
            ));
        }
    }
    if !session.commits.is_empty() {
        // 同一目录里别的 Agent 的提交也会算进来，所以不叫「本会话提交」。
        text.push_str("\n## 同期提交（会话期间所在目录）\n\n");
        for commit in &session.commits {
            text.push_str(&format!("- {commit}\n"));
        }
    }
    text.push_str(&format!(
        "\n---\n会话 `{}`（{}），原文在 Berth 会话页；「第 N 问」与会话页一致。\n",
        session.session_id, session.agent
    ));
    Ok(text)
}

fn index_line(session: &Session, file: &str) -> String {
    let short: String = session.session_id.chars().take(8).collect();
    let title = session
        .title
        .map(str::to_owned)
        .or_else(|| session.prompts.iter().find_map(|(_, prompt)| prompt.map(own_words).filter(|prompt| !prompt.is_empty()).map(str::to_owned)))
        .map(|title| format!(" · 「{}」", first_line(&title, TITLE_CHARS)))
        .unwrap_or_default();
    let commits = match session.commits.len() {
        0 => String::new(),
        count => format!(" · {count} 个同期提交"),
    };
    format!(
        "- {} · {} · 会话 {short} · {} 问{commits}{title} → [{file}]({file})",
        local(session.ended),
        session.agent,
        count(session)
    )
}

const HISTORY: &str = "## 历次（新的在前，每个会话一行）";

fn index_text(old: &str, session: &Session, file: &str) -> String {
    let link = format!("]({file})");
    let mut lines = vec![index_line(session, file)];
    if let Some((_, history)) = old.split_once(HISTORY) {
        lines.extend(
            history
                .lines()
                .filter(|line| line.starts_with("- ") && !line.ends_with(&link))
                .map(str::to_owned),
        );
    }
    let short: String = session.session_id.chars().take(8).collect();
    format!(
        "# 交接：{}\n\nBerth 按会话自动写的交接；需要了解之前做了什么时再读，不够再打开某一次的详情。\n\n\
         ## 当前状态（最近更新的会话 {short}，详情 [{file}]({file})）\n\n{}{HISTORY}\n\n{}\n",
        session.folder,
        state_section(session),
        lines.join("\n")
    )
}

/// 写这个会话的交接并更新索引，返回会话文件（主项目相对路径）。
pub fn write(main: &Path, session: &Session) -> io::Result<String> {
    if session.folder.is_empty() || session.folder.starts_with('.') || session.folder.contains(['/', '\\']) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("不能用作目录名：{}", session.folder)));
    }
    let dir = format!("{VAULT_DIR}/{HANDOFF_DIR}/{}", session.folder);
    let file = session_file(session);
    journal::write_file(&main.join(&dir).join(&file), &session_text(main, session)?)?;
    let index = main.join(&dir).join(INDEX);
    let old = fs::read_to_string(&index).unwrap_or_default();
    journal::write_file(&index, &index_text(&old, session, &file))?;
    write_overview(&main.join(VAULT_DIR).join(HANDOFF_DIR))?;
    Ok(format!("{dir}/{file}"))
}

/// 项目总索引：各专家目录的最近一次会话（取其索引历次的第一行），最近更新的在前。
fn write_overview(root: &Path) -> io::Result<()> {
    let mut rows = Vec::new();
    for entry in fs::read_dir(root)?.flatten() {
        let index = entry.path().join(INDEX);
        let Ok(text) = fs::read_to_string(&index) else {
            continue;
        };
        let folder = entry.file_name().to_string_lossy().into_owned();
        let Some(latest) = text.split_once(HISTORY).and_then(|(_, history)| history.lines().find(|line| line.starts_with("- ")))
        else {
            continue;
        };
        // 行内链接改成相对总索引的路径。
        let latest = latest.trim_start_matches("- ").replace("](", &format!("]({folder}/"));
        let modified = fs::metadata(&index).and_then(|meta| meta.modified()).ok();
        rows.push((modified, format!("- **{folder}**（[索引]({folder}/{INDEX})）：{latest}")));
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.0));
    let lines: Vec<_> = rows.into_iter().map(|(_, line)| line).collect();
    journal::write_file(
        &root.join(INDEX),
        &format!(
            "# 交接\n\n各专家最近一次会话，最近更新的在前；打开对应专家的索引看当前状态与历次。\n\n{}\n",
            lines.join("\n")
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::classifier::PROMPT;

    fn segment(key: &str, field: &'static str, text: &str) -> Segment {
        Segment { key: key.into(), field, text: text.into() }
    }

    #[test]
    fn asks_done_on_recent_answers_and_todo_on_the_last() {
        let segments = [segment("prompt", PROMPT, "修一下选区报错"), segment("answer1", ANSWER, "已修复")];
        let last: Vec<_> = questions(&segments, 0).keys().cloned().collect();
        assert_eq!(last, ["answer1.done", "answer1.todo"]);
        assert_eq!(questions(&segments, 2).len(), 1);
        assert!(questions(&segments, DONE_TURNS).is_empty());

        let scores = BTreeMap::from([("answer1.done".to_owned(), 0.9), ("answer1.todo".to_owned(), 0.95)]);
        assert_eq!(pick(&segments, &scores), Picked { done: vec![], todo: vec!["已修复".into()] });
    }

    #[test]
    fn writes_session_file_and_keeps_other_sessions_in_index() {
        let main = tempfile::tempdir().unwrap();
        let main = main.path();
        let at = |minute: u32| chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 10, 14, 13, minute, 0).unwrap();
        let picks = BTreeMap::from([
            (1, Picked { done: vec!["已改好选区，单测通过。".into()], todo: vec![] }),
            (2, Picked { done: vec![], todo: vec!["请在 dev 实例里验证，不改代码".into()] }),
        ]);
        let session = |id: &'static str| Session {
            folder: "dev-expert",
            agent: "pi",
            session_id: id,
            title: None,
            started: at(0),
            ended: at(20),
            prompts: vec![(1, Some("修选区\n细节…")), (2, Some("可以"))],
            picks: &picks,
            commits: vec!["7ede706 fix(pdf): 选区报错".into()],
            uncommitted: vec!["R  greet.sh -> scripts/greet.sh".into()],
            state_turn: 2,
            last_answer: None,
        };
        let file = write(main, &session("aaaaaaaa11")).unwrap();
        write(main, &session("bbbbbbbb22")).unwrap();
        // 同一会话再写：只换自己那一行。
        write(main, &session("aaaaaaaa11")).unwrap();

        let text = fs::read_to_string(main.join(&file)).unwrap();
        assert!(text.contains("**第 1 问**\n\n已改好选区，单测通过。"));
        assert!(text.contains("### 待办（第 2 问）\n\n> 用户：可以\n\n请在 dev 实例里验证，不改代码"));
        assert!(text.contains("- 第 1 问：修选区\n"));
        assert!(text.contains("- 7ede706 fix(pdf): 选区报错"));
        assert!(text.contains("### 未提交的改动（写交接时所在目录）\n\n```\nR  greet.sh -> scripts/greet.sh\n```"));

        let index = fs::read_to_string(main.join(".berth/knowledge/交接/dev-expert/索引.md")).unwrap();
        let history: Vec<_> = index.lines().filter(|line| line.starts_with("- ")).collect();
        assert_eq!(history.len(), 2);
        assert!(history[0].contains("会话 aaaaaaaa") && history[1].contains("会话 bbbbbbbb"));
        assert!(index.contains("当前状态（最近更新的会话 aaaaaaaa"));
        let overview = fs::read_to_string(main.join(".berth/knowledge/交接/索引.md")).unwrap();
        assert!(overview.contains("- **dev-expert**（[索引](dev-expert/索引.md)）：10-14"));
        assert!(overview.contains("会话 aaaaaaaa · 2 问 · 1 个同期提交 · 「修选区」 → [10-14-aaaaaaaa.md](dev-expert/10-14-aaaaaaaa.md)"));

        // Jev 没挑出待办：照抄最后一问回答的结尾，不说「没有待办」。
        let picks = BTreeMap::new();
        let quiet = Session { picks: &picks, last_answer: Some("确认没问题就说一声，我再提交。".into()), ..session("cccccccc33") };
        let file = write(main, &quiet).unwrap();
        assert!(fs::read_to_string(main.join(file)).unwrap().contains("结尾原文：\n\n确认没问题就说一声，我再提交。"));
    }
}
