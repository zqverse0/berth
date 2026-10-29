//! 按 `sessions.json` 读 Agent 原生会话文件（JSONL / JSON 文档）：找文件、会话头、可读内容。
//! CLI `berth session` 与桌面会话视图共用；桌面 transcript 阅读器仍走 GUI 的声明式 reader。

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::sessions::{
    context_items, expand_path, file_extension, json_document_records, load_session_spec,
    matches_file_pattern, message_record, parse_usage, push_context, record_matches, select_json,
    select_json_with_path, select_relative, session_index_record, value_string, ContextItem,
    MessageRecord, SessionSpec,
};

const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// 只读 JSONL / JSON 文档且声明了 project 与 message 选择器的会话才能按目录取回复。
pub fn check_spec(spec: &SessionSpec) -> Result<(), String> {
    if file_extension(&spec.storage).is_none() {
        // ponytail: CLI 只读 JSONL 与 JSON 文档；SQLite 声明（opencode 等）有需要再接 rusqlite。
        return Err(format!("storage {:?} is not supported", spec.storage));
    }
    if spec.session_index.is_some() && spec.storage != "jsonl" {
        return Err("sessionIndex is only supported with jsonl storage".into());
    }
    if spec.storage == "json" && spec.records.is_none() {
        return Err("sessions.json has no records selector".into());
    }
    if spec.session.project.is_none() {
        return Err("sessions.json has no session.project selector".into());
    }
    if spec.message.is_none() {
        return Err("sessions.json has no message declaration".into());
    }
    Ok(())
}

/// Agent 的会话声明；不支持按目录读会话时返回原因（CLI 报 unsupported，群组收集器与会话列表据此跳过）。
pub fn readable_spec(agent: &str) -> Result<SessionSpec, String> {
    let asset = crate::repository::load_tool_asset(agent)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("tool {agent:?} is not installed"))?;
    let spec = load_session_spec(agent, &asset)
        .map_err(|error| format!("{agent}: {error}"))?
        .ok_or_else(|| format!("{agent} declares no sessions.json"))?;
    check_spec(&spec).map_err(|message| format!("{agent}: {message}"))?;
    Ok(spec)
}

/// 会话文件的记录流：JSONL 逐行；JSON 文档按声明展开成同形记录（会话记录在前）。
pub fn records(spec: &SessionSpec, path: &Path) -> Box<dyn Iterator<Item = Value>> {
    if spec.storage == "json" {
        return Box::new(
            json_document_records(spec, path)
                .unwrap_or_default()
                .into_iter(),
        );
    }
    // `sessionIndex`：会话记录来自 SQLite 那一行，放在文件记录之前（与 JSON 文档的会话记录同位）。
    let index = session_index_record(spec, path);
    Box::new(
        index.into_iter().chain(
            fs::File::open(path)
                .ok()
                .into_iter()
                .flat_map(|file| BufReader::new(file).split(b'\n'))
                .map_while(Result::ok)
                .filter(|line| line.len() <= MAX_LINE_BYTES)
                .filter_map(|line| serde_json::from_slice::<Value>(&line).ok()),
        ),
    )
}

/// 文件的会话记录：（canonicalize 后的 project，会话 id）；没有会话记录返回 `None`。
pub fn header(spec: &SessionSpec, path: &Path) -> Option<(Option<PathBuf>, Option<String>)> {
    let value = records(spec, path).find(|value| record_matches(value, &spec.session))?;
    let field =
        |selector| select_json_with_path(&value, selector, path).and_then(|v| value_string(&v));
    let project = spec
        .session
        .project
        .as_ref()
        .and_then(field)
        // 目录已删（收尾的 worktree）时保留原路径，旧会话仍能归到它的群。
        .map(|project| {
            let project = PathBuf::from(project);
            project.canonicalize().unwrap_or(project)
        });
    Some((project, spec.session.id.as_ref().and_then(field)))
}

/// 会话的启动输入（`context` 声明）与首次请求报回的输入 token（精确总量，没有用量记录时为空）。
pub fn startup_context(spec: &SessionSpec, path: &Path) -> (Vec<ContextItem>, Option<u64>) {
    let mut items = Vec::new();
    let mut first_request = None;
    // 只算首次请求之前的记录；之后的注入不属于启动。不记用量的会话仍按整个文件收集。
    for value in records(spec, path) {
        for item in context_items(&spec.context, &value) {
            push_context(&mut items, item);
        }
        if let Some(message) = spec.message.as_ref().filter(|message| record_matches(&value, message)) {
            let nested = message.value.as_ref().and_then(|selector| select_json(&value, selector));
            first_request = select_relative(nested.as_ref(), &value, message.usage.as_ref())
                .as_ref()
                .and_then(parse_usage)
                .map(|usage| usage.context());
            if first_request.is_some() {
                break;
            }
        }
    }
    (items, first_request)
}

/// 会话 id 对应的文件和它的 project。声明了 `locate` 只看路径对得上的文件（只比路径，不读内容）；
/// 没声明就看全部会话文件，文件名含 id 的排前。候选按修改时间从新到旧，用文件头里的 id 核对，
/// 没有会话记录的文件按文件名核对。
pub fn find_session(spec: &SessionSpec, id: &str) -> Option<(PathBuf, Option<PathBuf>)> {
    let root = expand_path(&spec.path);
    let extension = file_extension(&spec.storage)?;
    let mut files = Vec::new();
    if root.is_file() {
        files.push((0, root.clone()));
    } else {
        let pattern = match spec.locate.as_deref() {
            // 带路径分隔符或花括号的 id 不代入模式，免得改变模式结构。
            Some(_) if id.contains(['/', '\\', '{', '}']) => return None,
            Some(locate) => Some(locate.replace("{id}", id)),
            None => spec.files.clone(),
        };
        collect_files(&root, &root, extension, pattern.as_deref(), &mut files);
    }
    files.sort_by_key(|(updated_at, path)| {
        let named = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.contains(id));
        (!named, std::cmp::Reverse(*updated_at))
    });
    files.into_iter().find_map(|(_, path)| {
        let (project, session_id) = header(spec, &path).unwrap_or_default();
        let stem = path.file_stem().and_then(|stem| stem.to_str());
        (session_id.as_deref() == Some(id) || stem == Some(id)).then_some((path, project))
    })
}

/// 会话里的一条可读内容：用户发言、助手正文、折叠成一行的工具调用。
#[derive(Debug, PartialEq)]
pub enum Entry {
    User(String),
    Text(String),
    Tool(String),
}

/// 会话记录起（含）的可读内容；工具结果、思考过程、系统注入都不输出。
pub fn entries<'a>(spec: &'a SessionSpec, path: &Path) -> impl Iterator<Item = Entry> + 'a {
    let mut started = false;
    records(spec, path).flat_map(move |value| {
        started = started || record_matches(&value, &spec.session);
        match spec.message.as_ref() {
            Some(message_spec) if started && record_matches(&value, message_spec) => {
                message_entries(&message_record(message_spec, &value))
            }
            _ => Vec::new(),
        }
    })
}

pub fn message_entries(record: &MessageRecord) -> Vec<Entry> {
    let role = record.role.as_ref().and_then(value_string);
    let variant = record.variant.as_ref().and_then(value_string);
    if variant.as_deref() == Some("reasoning") {
        return Vec::new();
    }
    match (role.as_deref(), record.content.as_ref()) {
        // 只有工具结果的 user 记录没有正文，不算一轮。
        (Some("user"), content) => content
            .and_then(plain_text)
            .map(Entry::User)
            .into_iter()
            .collect(),
        (Some("assistant"), Some(Value::String(text))) if !text.trim().is_empty() => {
            vec![Entry::Text(text.clone())]
        }
        (Some("assistant"), Some(Value::Array(items))) => items
            .iter()
            .filter_map(|item| match item.get("type").and_then(Value::as_str) {
                Some("text" | "output_text") => item
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .map(|text| Entry::Text(text.to_owned())),
                Some("thinking" | "redacted_thinking") => None,
                _ => tool_line(item).map(Entry::Tool),
            })
            .collect(),
        // 没有正文的 assistant 记录本身就是工具调用（如 codex 的 function_call）。
        (Some("assistant"), None) => record
            .nested
            .as_ref()
            .and_then(tool_line)
            .map(Entry::Tool)
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

pub fn plain_text(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("text" | "input_text" | "output_text")
                )
            })
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// 工具调用折叠为「→ 工具名 目标」；键名探测与桌面 reader 的 `tool_call_block` 一致。
fn tool_line(item: &Value) -> Option<String> {
    let name = ["name", "toolName", "tool_name"]
        .iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))?;
    let input = item.get("arguments").or_else(|| item.get("input"));
    // codex 的 arguments 是 JSON 字符串。
    let parsed = input
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let target = parsed.as_ref().or(input).and_then(tool_target);
    let target = target
        .as_deref()
        .and_then(|text| text.lines().find(|line| !line.trim().is_empty()))
        .map(|line| clip(line.trim(), 120));
    Some(match target {
        Some(target) => format!("→ {name} {target}"),
        None => format!("→ {name}"),
    })
}

/// 工具参数里最能说明「对谁做」的一项：常见参数名优先，否则取第一个字符串参数。
fn tool_target(input: &Value) -> Option<String> {
    let text = |value: &Value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        _ => None,
    };
    match input {
        Value::Object(map) => [
            "command",
            "cmd",
            "file_path",
            "path",
            "pattern",
            "url",
            "query",
        ]
        .iter()
        .find_map(|key| map.get(*key).and_then(text))
        .or_else(|| map.values().find_map(text)),
        other => text(other),
    }
}

pub fn clip(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

/// 递归收集扩展名为 `extension` 的会话文件（不跟随符号链接），附毫秒 mtime。
pub fn collect_files(
    root: &Path,
    dir: &Path,
    extension: &str,
    pattern: Option<&str>,
    out: &mut Vec<(u64, PathBuf)>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_files(root, &path, extension, pattern, out);
        } else if kind.is_file()
            && path.extension().and_then(|ext| ext.to_str()) == Some(extension)
            && pattern.is_none_or(|pattern| matches_file_pattern(root, &path, pattern))
        {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |elapsed| elapsed.as_millis() as u64);
            out.push((modified, path));
        }
    }
}

/// 一个会话文件的概况。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentSession {
    pub path: PathBuf,
    pub session_id: Option<String>,
    /// 会话目录（能 canonicalize 时为真实路径；目录已删时保留原值）。
    pub cwd: PathBuf,
    /// 毫秒 mtime。
    pub updated_at: u64,
}

/// mtime 不早于 `since_ms`、会话目录满足 `keep` 的会话文件，按 mtime 新到旧惰性产出：
/// 调用方取够就停，越早的文件越晚读文件头。
pub fn recent_sessions<'a>(
    spec: &'a SessionSpec,
    since_ms: u64,
    keep: impl Fn(&Path) -> bool + 'a,
) -> impl Iterator<Item = RecentSession> + 'a {
    let root = expand_path(&spec.path);
    let mut files = Vec::new();
    if let Some(extension) = file_extension(&spec.storage) {
        collect_files(&root, &root, extension, spec.files.as_deref(), &mut files);
    }
    files.retain(|file| file.0 >= since_ms);
    files.sort_by_key(|file| std::cmp::Reverse(file.0));
    // 同一会话 id 只出最新的一个文件：声明的 `files` 过宽（如把子 Agent 文件也匹配进来）时不出重复会话。
    let mut seen = std::collections::HashSet::new();
    files.into_iter().filter_map(move |(updated_at, path)| {
        let (Some(cwd), session_id) = header(spec, &path)? else {
            return None;
        };
        if session_id
            .as_ref()
            .is_some_and(|id| !seen.insert(id.clone()))
        {
            return None;
        }
        keep(&cwd).then_some(RecentSession {
            path,
            session_id,
            cwd,
            updated_at,
        })
    })
}

/// 会话标题：第一条用户发言的标题行（≤ 80 字）。
pub fn title(spec: &SessionSpec, path: &Path) -> Option<String> {
    entries(spec, path).find_map(|entry| match entry {
        Entry::User(text) => headline(&text),
        _ => None,
    })
}

/// 第一个非空行；整行是 `[…]` / `<…>` 的包装头（群投递的「[berth 频道 … · 来自 …]」、
/// `<user_info>` 之类）跳过，全是包装头时才用第一行。不截断（桌面标题要先折叠引用链接再截）。
pub fn headline_line(text: &str) -> Option<&str> {
    let wrapper = |line: &&str| {
        (line.starts_with('[') && line.ends_with(']'))
            || (line.starts_with('<') && line.ends_with('>'))
    };
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let first = lines.clone().next()?;
    Some(lines.find(|line| !wrapper(line)).unwrap_or(first))
}

fn headline(text: &str) -> Option<String> {
    headline_line(text).map(|line| clip(line, 80))
}

#[cfg(test)]
mod tests {
    use super::headline;

    #[test]
    fn headline_skips_wrapper_lines() {
        assert_eq!(
            headline("[berth 频道 main · 来自 user]\n\n修一下标题").as_deref(),
            Some("修一下标题")
        );
        assert_eq!(
            headline("<user_info>\nOS: linux").as_deref(),
            Some("OS: linux")
        );
        assert_eq!(headline("  \n直接提问").as_deref(), Some("直接提问"));
        assert_eq!(headline("[只有头]").as_deref(), Some("[只有头]"));
        assert_eq!(headline(" \n "), None);
    }

    /// 启动输入去重；首次请求取第一条带用量的消息（OpenAI 口径拆出缓存后输入 + 缓存 = 上下文）。
    #[test]
    fn startup_context_dedupes_items_and_reads_first_request() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("s.jsonl");
        let lines = [
            serde_json::json!({"type": "snapshot", "system": "sys"}),
            serde_json::json!({"type": "snapshot", "system": "sys"}),
            serde_json::json!({"type": "message", "message": {"role": "user", "content": "hi"}}),
            serde_json::json!({"type": "message", "message": {"role": "assistant",
                "usage": {"input_tokens": 30, "cached_input_tokens": 20, "output_tokens": 1}}}),
            serde_json::json!({"type": "message", "message": {"role": "assistant", "usage": {"input_tokens": 99}}}),
            serde_json::json!({"type": "snapshot", "system": "later"}),
        ];
        std::fs::write(&path, lines.map(|line| line.to_string()).join("\n")).unwrap();
        let spec: crate::sessions::SessionSpec = serde_json::from_value(serde_json::json!({
            "storage": "jsonl", "path": temp.path(),
            "message": {"record": "message", "value": "/message", "role": "/role", "usage": "/usage"},
            "context": [{"source": "system", "record": "snapshot", "text": "/system"}]
        }))
        .unwrap();
        let (items, first_request) = super::startup_context(&spec, &path);
        assert_eq!(items.len(), 1);
        assert_eq!(first_request, Some(30));
    }

    /// `sessionIndex`：会话信息在 SQLite 表里（agy 形态），按路径里的 id 查出那一行作为会话记录；
    /// 查不到时只剩 `@path` 回退；`|file_path` 把 file URI 转成本地路径。
    #[test]
    fn session_index_supplies_the_session_record_from_sqlite() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("summaries.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT, raw BLOB);
                 INSERT INTO conversation_summaries VALUES ('c1', '修标题', '[\"file:///w/my%20repo\"]', x'00');",
            )
            .unwrap();
        drop(connection);
        let transcript = |id: &str| {
            let dir = temp.path().join(format!("brain/{id}/.system_generated/logs"));
            std::fs::create_dir_all(&dir).unwrap();
            let lines = [
                serde_json::json!({"source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "hi"}),
                serde_json::json!({"source": "MODEL", "type": "PLANNER_RESPONSE", "content": "hello"}),
            ];
            std::fs::write(dir.join("transcript.jsonl"), lines.map(|line| line.to_string()).join("\n")).unwrap();
            dir.join("transcript.jsonl")
        };
        let spec: crate::sessions::SessionSpec = serde_json::from_value(serde_json::json!({
            "storage": "jsonl", "path": temp.path().join("brain"), "files": "**/.system_generated/logs/transcript.jsonl",
            "locate": "{id}/.system_generated/logs/transcript.jsonl",
            "sessionIndex": {"path": db, "table": "conversation_summaries", "key": "conversation_id",
                             "match": "@path.parent.parent.parent.name"},
            "session": {"id": ["conversation_id", "@path.parent.parent.parent.name"],
                        "project": "workspace_uris#/0|file_path", "title": "title"},
            "message": {"variant": "/type", "roleMap": {"USER_INPUT": "user", "PLANNER_RESPONSE": "assistant"},
                        "content": "/content"}
        }))
        .unwrap();
        super::check_spec(&spec).unwrap();
        let found = transcript("c1");
        assert_eq!(
            super::header(&spec, &found),
            Some((Some(std::path::PathBuf::from("/w/my repo")), Some("c1".into())))
        );
        assert_eq!(super::last_text(&spec, &found).as_deref(), Some("hello"));
        // 索引里没有这一行：没有项目，id 回退到路径。
        let orphan = transcript("c2");
        assert_eq!(super::header(&spec, &orphan), Some((None, Some("c2".into()))));
        assert_eq!(super::find_session(&spec, "c1").map(|(path, _)| path), Some(found));
    }

    /// `locate` 只核对路径对得上的文件；没声明时文件名含 id 的先看，仍以文件头 id 为准。
    #[test]
    fn find_session_uses_locate_and_checks_the_header_id() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("2026/10");
        std::fs::create_dir_all(&dir).unwrap();
        let session = |id: &str| serde_json::json!({"type": "meta", "id": id, "cwd": "/w"}).to_string();
        std::fs::write(dir.join("rollout-1-abc.jsonl"), session("abc")).unwrap();
        // 文件名带 id 但头里是别的会话（如分叉出来的文件）
        std::fs::write(dir.join("rollout-2-abc-fork.jsonl"), session("other")).unwrap();
        std::fs::write(dir.join("rollout-3-xyz.jsonl"), session("xyz")).unwrap();
        let spec = |locate: Option<&str>| -> crate::sessions::SessionSpec {
            serde_json::from_value(serde_json::json!({
                "storage": "jsonl", "path": temp.path(), "files": "**/*.jsonl", "locate": locate,
                "session": {"record": "meta", "id": "/id", "project": "/cwd"}
            }))
            .unwrap()
        };
        let found = |spec: &crate::sessions::SessionSpec, id| {
            super::find_session(spec, id).map(|(path, _)| path.file_name().unwrap().to_owned())
        };
        let located = spec(Some("**/*-{id}.jsonl"));
        assert_eq!(found(&located, "abc").unwrap(), "rollout-1-abc.jsonl");
        assert_eq!(found(&located, "missing"), None);
        assert_eq!(found(&located, "../abc"), None);
        assert_eq!(found(&spec(None), "xyz").unwrap(), "rollout-3-xyz.jsonl");
    }

    /// 冷门项目的旧会话排在大量新文件之后也要找得到；同一会话 id 只出最新文件；`since` 之前的不读。
    #[test]
    fn recent_sessions_reach_old_files_and_dedupe_ids() {
        use super::{recent_sessions, sessions_in};
        use std::fs::{self, File};
        use std::time::{Duration, UNIX_EPOCH};

        let temp = tempfile::tempdir().unwrap();
        let busy = temp.path().join("busy");
        let cold = temp.path().join("cold");
        fs::create_dir_all(&busy).unwrap();
        fs::create_dir_all(&cold).unwrap();
        let root = temp.path().join("sessions");
        fs::create_dir_all(&root).unwrap();
        let write = |name: &str, id: &str, cwd: &std::path::Path, secs: u64| {
            let path = root.join(name);
            let line = serde_json::json!({"id": id, "cwd": cwd});
            fs::write(&path, format!("{line}\n")).unwrap();
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_secs(secs))
                .unwrap();
        };
        for index in 0..250 {
            write(
                &format!("busy-{index}.jsonl"),
                &format!("b{index}"),
                &busy,
                10_000 + index,
            );
        }
        write("cold-old.jsonl", "c1", &cold, 1_000);
        write("cold-sub.jsonl", "c1", &cold, 2_000);
        let spec: crate::sessions::SessionSpec = serde_json::from_value(serde_json::json!({
            "storage": "jsonl", "path": root, "files": "*.jsonl",
            "session": {"id": "/id", "project": "/cwd"},
            "message": {"role": "/role"}
        }))
        .unwrap();

        let cold = cold.canonicalize().unwrap();
        let found: Vec<_> = recent_sessions(&spec, 0, |cwd| cwd == cold).collect();
        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with("cold-sub.jsonl"));
        assert!(sessions_in(&spec, &cold, 3_000_000).is_empty());
    }
}

/// 一个会话文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionFile {
    pub path: PathBuf,
    pub session_id: Option<String>,
    /// 毫秒 mtime。
    pub updated_at: u64,
}

/// `cwd`（已 canonicalize）下、mtime 不早于 `since_ms` 的会话文件，新到旧。
pub fn sessions_in(spec: &SessionSpec, cwd: &Path, since_ms: u64) -> Vec<SessionFile> {
    recent_sessions(spec, since_ms, |project| project == cwd)
        .map(|session| SessionFile {
            path: session.path,
            session_id: session.session_id,
            updated_at: session.updated_at,
        })
        .collect()
}

/// 会话文件里最后一条 assistant 纯文本（会话记录之前的消息不算）。
pub fn last_text(spec: &SessionSpec, path: &Path) -> Option<String> {
    let message_spec = spec.message.as_ref()?;
    let mut started = false;
    let mut text = None;
    for value in records(spec, path) {
        if !started {
            started = record_matches(&value, &spec.session);
            continue;
        }
        if !record_matches(&value, message_spec) {
            continue;
        }
        if let Some(reply) = assistant_text(&message_record(message_spec, &value)) {
            text = Some(reply);
        }
    }
    text
}

/// 最后一条用户发言之后（这一轮）各工具调用的目标（路径、命令等，见 `tool_target`），按出现顺序。
pub fn turn_tool_targets(spec: &SessionSpec, path: &Path) -> Vec<String> {
    let mut targets = Vec::new();
    for entry in entries(spec, path) {
        match entry {
            Entry::User(_) => targets.clear(),
            Entry::Tool(line) => {
                // `→ 工具名 目标`：目标是工具名之后的部分。
                if let Some((_, target)) = line.trim_start_matches("→ ").split_once(' ') {
                    targets.push(target.to_owned());
                }
            }
            Entry::Text(_) => {}
        }
    }
    targets
}

/// 这一轮已结束时的最终回答：最后一条有效记录是 assistant 纯文本。之后还有工具调用、工具结果
/// 或新的用户消息，说明这一轮没结束，返回 `None`。系统注入、思考过程、没有角色的记录不影响判断。
pub fn turn_reply(spec: &SessionSpec, path: &Path) -> Option<String> {
    let message_spec = spec.message.as_ref()?;
    let mut started = false;
    let mut reply = None;
    for value in records(spec, path) {
        if !started {
            started = record_matches(&value, &spec.session);
            continue;
        }
        if !record_matches(&value, message_spec) {
            continue;
        }
        let record = message_record(message_spec, &value);
        let role = record.role.as_ref().and_then(value_string);
        let variant = record.variant.as_ref().and_then(value_string);
        if matches!(role.as_deref(), None | Some("system"))
            || variant.as_deref() == Some("reasoning")
        {
            continue;
        }
        if role.as_deref() != Some("assistant") {
            reply = None;
            continue;
        }
        let items = record.content.as_ref().and_then(Value::as_array);
        let calls_tool = items.is_some_and(|items| {
            items.iter().any(|item| {
                !matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("text" | "output_text" | "thinking" | "redacted_thinking")
                )
            })
        });
        if calls_tool {
            reply = None;
        } else if let Some(text) = assistant_text(&record) {
            reply = Some(text);
        } else if items.is_none() && !record.content.as_ref().is_some_and(Value::is_string) {
            // 没有正文的 assistant 记录是工具调用（如 codex 的 function_call）。
            reply = None;
        }
    }
    reply
}

/// assistant 记录的纯文本；reasoning、工具调用与注入（已降为 system）都不算回复。
fn assistant_text(record: &MessageRecord) -> Option<String> {
    let role = record.role.as_ref().and_then(value_string);
    let variant = record.variant.as_ref().and_then(value_string);
    if role.as_deref() != Some("assistant") || variant.as_deref() == Some("reasoning") {
        return None;
    }
    let text = match record.content.as_ref()? {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("text" | "output_text")
                )
            })
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}
