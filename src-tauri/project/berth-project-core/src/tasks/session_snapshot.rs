//! 任务归档时关联它的会话：有 `berth task create|promote|start|step|finish <任务>` 命令或提交尾注
//! `Task: <任务> S<n>` 的才算，只提到任务名的不算。各 Agent 的差异都在 `sessions.json` 里，这里不分 Agent。
//! 会话可能被 Agent 清理，对话文本另存快照 `.berth/local/task-sessions/<任务>/`（不进 git）。

use std::fs;
use std::path::{Path, PathBuf};

use berth_tool_core::session_files::{messages, recent_sessions, title, transcript};
use berth_tool_core::sessions::SessionSpec;
use serde_json::Value;

use super::file::{self, FileSession};
use super::fsutil;
use super::hub::local_dir;
use super::session_links::session_links;
use super::{TaskError, TaskResult};

const TASK_VERBS: [&str; 5] = ["create", "promote", "start", "step", "finish"];

/// 任务名去掉 `MM-DD-` 前缀；命令里可以只写它。
fn slug_of(name: &str) -> &str {
    name.splitn(3, '-').nth(2).unwrap_or(name)
}

/// 这行命令是不是 `berth … task [--flag] <动词> … <任务>`。
fn is_task_command(line: &str, name: &str) -> bool {
    line.split(['&', ';', '|']).any(|command| {
        let words: Vec<&str> = command
            .split_whitespace()
            .map(|word| word.trim_matches(['"', '\'', '`', '(', ')']))
            .collect();
        let Some(berth) = words.iter().position(|word| *word == "berth" || word.ends_with("/berth")) else {
            return false;
        };
        let Some(task) = words[berth..].iter().position(|word| *word == "task") else {
            return false;
        };
        let mut rest = words[berth + task + 1..].iter().skip_while(|word| word.starts_with('-'));
        rest.next().is_some_and(|verb| TASK_VERBS.contains(verb))
            && rest.any(|word| *word == name || *word == slug_of(name))
    })
}

/// 这段命令是不是带任务尾注的提交。
fn is_task_commit(text: &str, name: &str) -> bool {
    let trailer = format!("Task: {name} S");
    text.contains("commit")
        && text.match_indices(&trailer).any(|(at, _)| {
            text[at + trailer.len()..].starts_with(|ch: char| ch.is_ascii_digit())
        })
}

/// 工具调用参数里的所有字符串（命令可能是任意键）；不是 JSON 就按原文。
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings(item, out)),
        _ => {}
    }
}

fn belongs_to_task(spec: &SessionSpec, path: &Path, name: &str) -> bool {
    // ponytail: 读全部会话很慢，先按原文筛掉没出现 slug 的文件（一次归档只跑一遍，够用）。
    let raw = fs::read(path).unwrap_or_default();
    if !String::from_utf8_lossy(&raw).contains(slug_of(name)) {
        return false;
    }
    messages(spec, path).iter().any(|message| {
        let calls = message.get("tool_calls").and_then(Value::as_array);
        calls.into_iter().flatten().any(|call| {
            let arguments = call.pointer("/function/arguments").and_then(Value::as_str).unwrap_or_default();
            let mut texts = Vec::new();
            match serde_json::from_str::<Value>(arguments) {
                Ok(value) => strings(&value, &mut texts),
                Err(_) => texts.push(arguments.to_owned()),
            }
            texts.iter().any(|text| {
                is_task_commit(text, name) || text.lines().any(|line| is_task_command(line, name))
            })
        })
    })
}

fn snapshots_dir(main: &Path) -> PathBuf {
    local_dir(main).join("task-sessions")
}

/// 一个会话的快照文件。id 来自会话文件，不可信的字符换掉。
pub(super) fn snapshot_path(main: &Path, task: &str, agent: &str, id: &str) -> PathBuf {
    let safe = |text: &str| -> String {
        text.chars()
            .map(|ch| if ch.is_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
            .collect()
    };
    snapshots_dir(main).join(task).join(format!("{}-{}.md", safe(agent), safe(id)))
}

/// 扫描本项目（各群目录及子目录）的会话，给匹配的存快照。
pub(super) fn scan(
    main: &Path,
    name: &str,
    agents: &[(String, SessionSpec)],
) -> TaskResult<Vec<FileSession>> {
    fs::create_dir_all(snapshots_dir(main)).map_err(|error| {
        TaskError::new("io_error", format!("{}: {error}", snapshots_dir(main).display()))
    })?;
    let links = session_links(main)?;
    let mut found = Vec::new();
    for (agent, spec) in agents {
        for session in recent_sessions(spec, 0, |cwd| links.group_of(cwd).is_some()) {
            if !belongs_to_task(spec, &session.path, name) {
                continue;
            }
            let id = session.session_id.clone().unwrap_or_else(|| {
                session.path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default()
            });
            let header = format!("# {agent} {id} · {}\n\n", session.cwd.display());
            fsutil::atomic_write(
                &snapshot_path(main, name, agent, &id),
                format!("{header}{}", transcript(spec, &session.path)).as_bytes(),
            )?;
            found.push(FileSession {
                agent: agent.clone(),
                id,
                title: title(spec, &session.path).unwrap_or_default(),
                cwd: session.cwd.to_string_lossy().into_owned(),
            });
        }
    }
    Ok(found)
}

/// 单测不扫本机真实的 Agent 会话。
#[cfg(not(test))]
fn readable_agents() -> Vec<(String, SessionSpec)> {
    berth_tool_core::repository::list_installed_tool_asset_ids()
        .into_iter()
        .filter_map(|agent| berth_tool_core::session_files::readable_spec(&agent).ok().map(|spec| (agent, spec)))
        .collect()
}

#[cfg(test)]
fn readable_agents() -> Vec<(String, SessionSpec)> {
    Vec::new()
}

/// 关联会话并写进（已归档的）任务文件，返回本次关联到几个。
pub(super) fn link(main: &Path, name: &str, task_file: &Path) -> TaskResult<usize> {
    let found = scan(main, name, &readable_agents())?;
    let count = found.len();
    file::add_sessions(task_file, found)?;
    Ok(count)
}
