//! `berth session last|list|show`：按 Tool Asset 的 `sessions.json` 读 Agent 原生会话。
//! 文件读取在 `berth_tool_core::session_files`（与桌面会话视图共用），这里只管命令与输出。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub(crate) use berth_tool_core::session_files::readable_spec as spec_for;
use berth_tool_core::session_files::{
    check_spec, entries, find_session, last_text, recent_sessions, sessions_in, startup_context,
    title, Entry,
};
use berth_tool_core::sessions::{estimate_tokens, load_session_spec, SessionSpec};
use berth_project_core::tasks::session_links::{session_links, Origin, SessionLinks};
use serde_json::json;

use crate::{CliError, EXIT_REJECTED, EXIT_TARGET_NOT_FOUND, EXIT_USER_ERROR};

#[derive(Debug, PartialEq)]
struct LastReply {
    session_id: Option<String>,
    path: PathBuf,
    updated_at: u64,
    text: String,
}

fn failure(code: u8, kind: &str, message: String, json_mode: bool) -> CliError {
    CliError {
        exit_code: code,
        json_message: json_mode
            .then(|| json!({ "error": { "kind": kind, "message": message } }).to_string()),
        message,
    }
}

pub(crate) fn last(
    agent: &str,
    cwd: &Path,
    max_bytes: Option<usize>,
    json_mode: bool,
) -> Result<(), CliError> {
    // 无声明 / 声明无法读取 / 存储不是 JSONL 或 JSON 文档统一为 unsupported（退出码 7），调用方据此改走手动回报。
    let unsupported = |message: String| failure(EXIT_REJECTED, "unsupported", message, json_mode);
    let asset = berth_tool_core::repository::load_tool_asset(agent)
        .map_err(|error| {
            failure(
                EXIT_USER_ERROR,
                "invalid_params",
                error.to_string(),
                json_mode,
            )
        })?
        .ok_or_else(|| unsupported(format!("tool {agent:?} is not installed")))?;
    let spec = load_session_spec(agent, &asset)
        .map_err(|error| unsupported(format!("{agent}: {error}")))?
        .ok_or_else(|| unsupported(format!("{agent} declares no sessions.json")))?;
    let cwd = cwd.canonicalize().map_err(|error| {
        failure(
            EXIT_USER_ERROR,
            "invalid_params",
            format!("{}: {error}", cwd.display()),
            json_mode,
        )
    })?;
    let reply = find_last(&spec, &cwd)
        .map_err(|message| unsupported(format!("{agent}: {message}")))?
        .ok_or_else(|| {
            failure(
                EXIT_TARGET_NOT_FOUND,
                "not_found",
                format!("no {agent} session for {}", cwd.display()),
                json_mode,
            )
        })?;
    let mut text = reply.text;
    let truncated = max_bytes.is_some_and(|max| text.len() > max);
    if let Some(max) = max_bytes.filter(|_| truncated) {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    if json_mode {
        println!(
            "{}",
            json!({
                "agent": agent,
                "session_id": reply.session_id,
                "path": reply.path,
                "updated_at": reply.updated_at,
                "text": text,
                "truncated": truncated,
            })
        );
    } else {
        println!("{text}");
    }
    Ok(())
}

/// 按 mtime 从新到旧找第一个会话记录 project（canonicalize 后）等于 `cwd` 的文件。
fn find_last(spec: &SessionSpec, cwd: &Path) -> Result<Option<LastReply>, String> {
    check_spec(spec)?;
    let Some(file) = sessions_in(spec, cwd, 0).into_iter().next() else {
        return Ok(None);
    };
    Ok(Some(LastReply {
        text: last_text(spec, &file.path).unwrap_or_default(),
        session_id: file.session_id,
        path: file.path,
        updated_at: file.updated_at,
    }))
}

/// 一轮：一条用户发言及其后的助手正文与工具调用。`n` 从 1 起；用户发言之前的内容记为第 0 轮。
#[derive(Debug, PartialEq)]
struct Turn {
    n: usize,
    user: Option<String>,
    reply: Vec<String>,
}

fn turns(entries: impl Iterator<Item = Entry>) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut n = 0;
    for entry in entries {
        match entry {
            Entry::User(text) => {
                n += 1;
                turns.push(Turn {
                    n,
                    user: Some(text),
                    reply: Vec::new(),
                });
            }
            Entry::Text(line) | Entry::Tool(line) => {
                if turns.is_empty() {
                    turns.push(Turn {
                        n: 0,
                        user: None,
                        reply: Vec::new(),
                    });
                }
                turns.last_mut().unwrap().reply.push(line);
            }
        }
    }
    turns
}

fn render(turn: &Turn, user_only: bool) -> String {
    let mut out = String::new();
    if let Some(user) = &turn.user {
        out.push_str(&format!("## #{} 用户\n{}\n", turn.n, user.trim_end()));
    }
    if !user_only && !turn.reply.is_empty() {
        out.push_str(&format!("## #{} 助手\n{}\n", turn.n, turn.reply.join("\n")));
    }
    out
}

pub(crate) struct ShowOptions {
    pub(crate) tail: Option<usize>,
    pub(crate) user_only: bool,
    pub(crate) grep: Option<String>,
    pub(crate) max_bytes: usize,
    /// 输出启动输入而不是对话。
    pub(crate) context: bool,
}

#[derive(Debug, PartialEq)]
struct Selection {
    text: String,
    /// 超出字节上限而没输出的较早轮数。
    omitted: usize,
    /// 只剩一轮仍超上限，被截断。
    truncated: bool,
}

/// 按 grep → tail → 字节上限依次筛选；超上限时丢最早的轮次，保留最近的。
fn select(turns: &[Turn], options: &ShowOptions) -> Selection {
    let needle = options.grep.as_deref().map(str::to_lowercase);
    let mut blocks: Vec<String> = turns
        .iter()
        .map(|turn| render(turn, options.user_only))
        .filter(|block| !block.is_empty())
        .filter(|block| {
            needle
                .as_deref()
                .is_none_or(|needle| block.to_lowercase().contains(needle))
        })
        .collect();
    if let Some(tail) = options.tail {
        blocks.drain(..blocks.len().saturating_sub(tail));
    }
    let mut omitted = 0;
    // 轮与轮之间空一行。
    let size = |blocks: &[String]| blocks.iter().map(|block| block.len() + 1).sum::<usize>();
    while blocks.len() > 1 && size(&blocks) > options.max_bytes {
        blocks.remove(0);
        omitted += 1;
    }
    let mut text = blocks.join("\n");
    let truncated = text.len() > options.max_bytes;
    if truncated {
        let mut end = options.max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    Selection {
        text,
        omitted,
        truncated,
    }
}

/// 要查的 Agent：指定的那个，或全部声明了可读会话的已安装工具。
fn readable_agents(agent: Option<&str>, json_mode: bool) -> Result<Vec<(String, SessionSpec)>, CliError> {
    match agent {
        Some(agent) => spec_for(agent)
            .map(|spec| vec![(agent.to_owned(), spec)])
            .map_err(|message| failure(EXIT_REJECTED, "unsupported", message, json_mode)),
        None => Ok(berth_tool_core::repository::list_installed_tool_asset_ids()
            .into_iter()
            .filter_map(|agent| spec_for(&agent).ok().map(|spec| (agent, spec)))
            .collect()),
    }
}

/// 当前项目的群目录、会话来源与在跑（群账本推导）。
fn project_links(json_mode: bool) -> Result<SessionLinks, CliError> {
    let invalid = |message: String| failure(EXIT_USER_ERROR, "invalid_params", message, json_mode);
    let cwd = std::env::current_dir().map_err(|error| invalid(error.to_string()))?;
    let main = berth_project_core::tasks::main_project(&cwd).map_err(|error| invalid(error.to_string()))?;
    session_links(&main).map_err(|error| invalid(error.to_string()))
}

pub(crate) struct ListOptions {
    pub(crate) agent: Option<String>,
    /// 群名或群目录名。
    pub(crate) group: Option<String>,
    pub(crate) live: bool,
    pub(crate) limit: usize,
}

/// `berth session list`：当前项目（各群目录及子目录，含已删的 worktree）的会话，最近活动在前。
pub(crate) fn list(options: &ListOptions, json_mode: bool) -> Result<(), CliError> {
    let links = project_links(json_mode)?;
    // 群目录名可能重名（同名目录的旧 worktree），按名字筛选时全部算上，与列表显示一致。
    let groups: Option<Vec<&str>> = options.group.as_deref().map(|wanted| {
        links
            .groups
            .iter()
            .map(|(name, _)| name.as_str())
            .filter(|name| *name == wanted || links.group_label(name).as_deref() == Some(wanted))
            .collect()
    });
    if groups.as_ref().is_some_and(Vec::is_empty) {
        let wanted = options.group.as_deref().unwrap_or_default();
        return Err(failure(EXIT_USER_ERROR, "invalid_params", format!("no group {wanted}"), json_mode));
    }
    let mut rows = Vec::new();
    for (agent, spec) in readable_agents(options.agent.as_deref(), json_mode)? {
        // 筛选在前、取够 limit 条就停：多深都能找到，不再只看最新的一批文件。
        let matching = recent_sessions(&spec, 0, |cwd| links.group_of(cwd).is_some()).filter_map(|session| {
            let in_group = links.group_of(&session.cwd).unwrap_or_default().to_owned();
            let live = links.live(session.session_id.as_deref());
            if groups.as_ref().is_some_and(|groups| !groups.contains(&in_group.as_str()))
                || (options.live && !live)
            {
                return None;
            }
            let origin = links.origin(session.session_id.as_deref(), session.updated_at);
            Some((agent.clone(), session, in_group, origin, live))
        });
        rows.extend(matching.take(options.limit));
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.1.updated_at));
    // 标题要读到第一条用户发言，截断后再读。
    rows.truncate(options.limit);
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let mut sessions = Vec::new();
    for (agent, session, group, origin, live) in rows {
        let spec = spec_for(&agent).map_err(|message| failure(EXIT_REJECTED, "unsupported", message, json_mode))?;
        let title = title(&spec, &session.path).unwrap_or_default();
        let group_name = links.group_label(&group).unwrap_or_else(|| group.clone());
        if json_mode {
            sessions.push(json!({
                "agent": agent, "session_id": session.session_id, "cwd": session.cwd,
                "path": session.path, "updated_at": session.updated_at, "title": title,
                "group": group, "group_name": group_name,
                "origin": origin.as_str(), "live": live,
            }));
        } else {
            let origin = match origin {
                Origin::Berth => "Berth",
                Origin::External => "外部",
                Origin::Unknown => "未知",
            };
            println!(
                "{}\t{}\t{}\t{}\t{}{}\t{}",
                ago(now.saturating_sub(session.updated_at)),
                agent,
                session.session_id.as_deref().unwrap_or("-"),
                group_name,
                origin,
                if live { " · 在跑" } else { "" },
                title
            );
        }
    }
    if json_mode {
        println!("{}", json!({ "sessions": sessions }));
    }
    Ok(())
}

fn ago(ms: u64) -> String {
    let minutes = ms / 60_000;
    match minutes {
        0 => "刚刚".into(),
        1..60 => format!("{minutes} 分钟前"),
        60..1440 => format!("{} 小时前", minutes / 60),
        _ => format!("{} 天前", minutes / 1440),
    }
}

/// `berth session show`：按会话 id 输出用户与助手文本，工具调用折叠为一行。
pub(crate) fn show(
    id: &str,
    agent: Option<&str>,
    options: &ShowOptions,
    json_mode: bool,
) -> Result<(), CliError> {
    let (agent, spec, path, project) = readable_agents(agent, json_mode)?
        .into_iter()
        .find_map(|(agent, spec)| {
            let (path, project) = find_session(&spec, id)?;
            Some((agent, spec, path, project))
        })
        .ok_or_else(|| {
            failure(
                EXIT_TARGET_NOT_FOUND,
                "not_found",
                format!("no session {id}"),
                json_mode,
            )
        })?;
    if options.context {
        print_context(&agent, id, project.as_deref(), &spec, &path, json_mode);
        return Ok(());
    }
    let turns = turns(entries(&spec, &path));
    let selection = select(&turns, options);
    let total = turns.iter().filter(|turn| turn.user.is_some()).count();
    if json_mode {
        println!(
            "{}",
            json!({
                "agent": agent, "session_id": id, "cwd": project, "path": path,
                "turns": total, "omitted": selection.omitted,
                "truncated": selection.truncated, "text": selection.text,
            })
        );
        return Ok(());
    }
    let cwd = project.as_deref().map(|cwd| cwd.display().to_string()).unwrap_or_default();
    println!("# {agent} {id} · {cwd} · 共 {total} 轮");
    if selection.omitted > 0 {
        println!(
            "（较早的 {} 轮超出 {} 字节未输出；用 --tail N 或 --grep <词> 缩小范围）",
            selection.omitted, options.max_bytes
        );
    }
    if selection.truncated {
        println!("（这一轮超出 {} 字节，已截断）", options.max_bytes);
    }
    println!("\n{}", selection.text);
    Ok(())
}

/// `show --context`：启动输入按估算 token 从大到小，加首次请求的精确总量与会话文件里没记下的差额。
fn print_context(
    agent: &str,
    id: &str,
    project: Option<&Path>,
    spec: &SessionSpec,
    path: &Path,
    json_mode: bool,
) {
    let (items, first_request) = startup_context(spec, path);
    let mut items: Vec<_> = items
        .into_iter()
        .map(|item| (estimate_tokens(&item.text), item))
        .collect();
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let listed: u64 = items.iter().map(|(tokens, _)| tokens).sum();
    let unlisted = first_request.map(|total| total.saturating_sub(listed));
    if json_mode {
        let items: Vec<_> = items
            .iter()
            .map(|(tokens, item)| {
                json!({
                    "source": item.source, "name": item.name, "path": item.path,
                    "tokens_estimate": tokens, "text": item.text,
                })
            })
            .collect();
        println!(
            "{}",
            json!({
                "agent": agent, "session_id": id, "cwd": project, "path": path,
                "first_request_tokens": first_request, "listed_tokens_estimate": listed,
                "unlisted_tokens_estimate": unlisted, "items": items,
            })
        );
        return;
    }
    let cwd = project.map(|cwd| cwd.display().to_string()).unwrap_or_default();
    println!("# {agent} {id} · {cwd} · 启动输入 {} 项", items.len());
    match first_request {
        Some(total) => println!("首次请求 {total} token（API 报回，精确）；各项为估算"),
        None => println!("会话文件没有用量记录；各项为估算，合计 ≈{listed}"),
    }
    for (tokens, item) in &items {
        let label = item.path.as_deref().or(item.name.as_deref()).unwrap_or("");
        println!("≈{tokens:>7}  {:<12} {label}", item.source);
    }
    if let Some(unlisted) = unlisted.filter(|unlisted| *unlisted > 0) {
        println!("≈{unlisted:>7}  未记在会话文件里（工具定义、首个提问等）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use berth_tool_core::session_files::{message_entries, turn_reply};
    use berth_tool_core::sessions::MessageRecord;
    use serde_json::Value;
    use std::fs;

    fn spec(shape: &str, root: &Path) -> SessionSpec {
        let path = root.to_string_lossy();
        // 与 ~/.berth-dev/tools/{pi,codex}/sessions.json 同形。
        let value = match shape {
            "pi" => json!({
                "storage": "jsonl", "path": path, "files": "**/*.jsonl",
                "session": {"record": "session", "id": "/id", "project": "/cwd", "time": "/timestamp"},
                "message": {"record": "message", "value": "/message", "role": "/role", "content": "/content"}
            }),
            _ => json!({
                "storage": "jsonl", "path": path, "files": "**/*.jsonl",
                "session": {"record": "session_meta", "id": ["/payload/id", "/payload/session_id"], "project": "/payload/cwd"},
                "message": {
                    "record": "response_item", "value": "/payload", "variant": "/type", "role": "/role",
                    "roleMap": {"function_call": "assistant", "reasoning": "assistant", "function_call_output": "tool"},
                    "content": ["/content", "/summary"],
                    "injected": {"textPrefixes": ["<environment_context>"]}
                }
            }),
        };
        serde_json::from_value(value).unwrap()
    }

    fn write(path: &Path, lines: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body: Vec<String> = lines.iter().map(Value::to_string).collect();
        fs::write(path, body.join("\n") + "\n").unwrap();
    }

    fn options(tail: Option<usize>, user_only: bool, grep: Option<&str>, max_bytes: usize) -> ShowOptions {
        ShowOptions {
            tail,
            user_only,
            grep: grep.map(str::to_owned),
            max_bytes,
            context: false,
        }
    }

    /// claude 形状：会话记录就是第一条 user 记录；工具结果是只有 tool_result 的 user 记录。
    fn claude_session(root: &Path, work: &Path) -> (SessionSpec, PathBuf) {
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "jsonl", "path": root.to_string_lossy(), "files": "**/*.jsonl",
            "session": {"record": "user", "id": "/sessionId", "project": "/cwd"},
            "message": {"value": "/message", "role": "/role", "content": "/content",
                "injected": {"flag": "/isMeta"}}
        }))
        .unwrap();
        let line = |kind: &str, role: &str, content: Value| {
            json!({"type": kind, "sessionId": "c-1", "cwd": work, "message": {"role": role, "content": content}})
        };
        let path = root.join("proj/c-1.jsonl");
        write(
            &path,
            &[
                line("user", "user", json!("修 worktree 路径")),
                line("assistant", "assistant", json!([
                    {"type": "thinking", "thinking": "想想"},
                    {"type": "text", "text": "先看代码"},
                    {"type": "tool_use", "name": "Bash", "input": {"description": "列目录", "command": "ls src\nmore"}}
                ])),
                line("user", "user", json!([{"type": "tool_result", "content": "a.rs"}])),
                line("assistant", "assistant", json!([{"type": "text", "text": "改好了"}])),
                line("user", "user", json!("再跑测试")),
                line("assistant", "assistant", json!([{"type": "tool_use", "name": "Edit", "input": {"content": "x", "file_path": "/w/a.rs"}}])),
                line("assistant", "assistant", json!("测试通过")),
            ],
        );
        (spec, path)
    }

    #[test]
    fn show_folds_tool_calls_and_skips_tool_results_and_thinking() {
        let temp = tempfile::tempdir().unwrap();
        let work = temp.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let (spec, path) = claude_session(&temp.path().join("sessions"), &work);
        let turns = turns(entries(&spec, &path));
        assert_eq!(
            turns,
            vec![
                Turn {
                    n: 1,
                    user: Some("修 worktree 路径".into()),
                    reply: vec!["先看代码".into(), "→ Bash ls src".into(), "改好了".into()],
                },
                Turn {
                    n: 2,
                    user: Some("再跑测试".into()),
                    reply: vec!["→ Edit /w/a.rs".into(), "测试通过".into()],
                },
            ]
        );
        assert_eq!(
            find_session(&spec, "c-1"),
            Some((path.clone(), Some(work.canonicalize().unwrap())))
        );
        assert_eq!(find_session(&spec, "missing"), None);
    }

    #[test]
    fn codex_function_call_folds_json_string_arguments() {
        let record = MessageRecord {
            nested: Some(json!({"type": "function_call", "name": "shell",
                "arguments": "{\"command\":[\"bash\",\"-lc\",\"cargo test\"]}"})),
            variant: Some(json!("function_call")),
            role: Some(json!("assistant")),
            content: None,
        };
        assert_eq!(
            message_entries(&record),
            vec![Entry::Tool("→ shell bash -lc cargo test".into())]
        );
    }

    #[test]
    fn select_applies_grep_then_tail_then_byte_limit() {
        let turn = |n: usize, user: &str, reply: &str| Turn {
            n,
            user: Some(user.into()),
            reply: vec![reply.into()],
        };
        let turns = vec![
            turn(1, "worktree 一", "a"),
            turn(2, "二", "WorkTree 回复"),
            turn(3, "三", "c"),
            turn(4, "worktree 四", "d"),
        ];
        let all = select(&turns, &options(None, false, None, 16 * 1024));
        assert_eq!((all.omitted, all.truncated), (0, false));
        assert!(all.text.starts_with("## #1 用户\nworktree 一\n## #1 助手\na\n\n## #2"));

        let tail = select(&turns, &options(Some(2), false, None, 16 * 1024));
        assert!(tail.text.starts_with("## #3 用户") && tail.text.contains("## #4 助手"));

        // grep 不区分大小写，命中用户或助手都算；tail 在 grep 之后取。
        let grep = select(&turns, &options(Some(2), false, Some("WORKTREE"), 16 * 1024));
        assert!(grep.text.starts_with("## #2 用户") && grep.text.contains("## #4"));
        assert!(!grep.text.contains("## #1") && !grep.text.contains("## #3"));

        let users = select(&turns, &options(None, true, None, 16 * 1024));
        assert!(!users.text.contains("助手") && users.text.contains("## #4 用户"));

        // 超上限丢最早的轮次；只剩一轮仍超上限则截断。
        let block = render(&turns[3], false).len() + 1;
        let limited = select(&turns, &options(None, false, None, block));
        assert_eq!((limited.omitted, limited.truncated), (3, false));
        assert!(limited.text.starts_with("## #4 用户"));
        let cut = select(&turns, &options(None, false, None, 10));
        assert_eq!((cut.omitted, cut.truncated), (3, true));
        assert!(cut.text.len() <= 10);
    }

    #[test]
    fn pi_shape_returns_last_assistant_text_for_exact_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let work = temp.path().join("work");
        let other = temp.path().join("work-other");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&other).unwrap();
        let message = |role: &str, content: Value| json!({"type": "message", "message": {"role": role, "content": content}});
        write(
            &root.join("a/1.jsonl"),
            &[
                json!({"type": "session", "id": "s1", "cwd": work}),
                message("user", json!([{"type": "text", "text": "do it"}])),
                message(
                    "assistant",
                    json!([{"type": "text", "text": "first"}, {"type": "toolCall", "name": "bash"}]),
                ),
                message("toolResult", json!([{"type": "text", "text": "tool out"}])),
                message(
                    "assistant",
                    json!([{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "done: branch x"}]),
                ),
                message("assistant", json!([{"type": "toolCall", "name": "bash"}])),
            ],
        );
        // 更新的文件属于别的目录（前缀相同），不得命中。
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(
            &root.join("b/2.jsonl"),
            &[
                json!({"type": "session", "id": "s2", "cwd": other}),
                message("assistant", json!([{"type": "text", "text": "other"}])),
            ],
        );
        let reply = find_last(&spec("pi", &root), &work.canonicalize().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(reply.session_id.as_deref(), Some("s1"));
        assert_eq!(reply.text, "done: branch x");
        assert!(reply.path.ends_with("a/1.jsonl"));
        let missing = temp.path().join("none");
        fs::create_dir_all(&missing).unwrap();
        assert_eq!(find_last(&spec("pi", &root), &missing).unwrap(), None);
    }

    #[test]
    fn turn_reply_waits_until_the_turn_ends_with_text() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("s.jsonl");
        let pi = spec("pi", temp.path());
        let message = |role: &str, content: Value| json!({"type": "message", "message": {"role": role, "content": content}});
        let session = json!({"type": "session", "id": "s1", "cwd": "/w"});
        let opening = message(
            "assistant",
            json!([{"type": "text", "text": "先读文件"}, {"type": "toolCall", "name": "bash"}]),
        );
        let result = message("toolResult", json!([{"type": "text", "text": "out"}]));
        let thinking = message(
            "assistant",
            json!([{"type": "thinking", "thinking": "hmm"}]),
        );
        let final_text = message("assistant", json!([{"type": "text", "text": "最终结论"}]));
        let prompt = message("user", json!([{"type": "text", "text": "下一条"}]));
        let ask = message("user", json!([{"type": "text", "text": "do it"}]));

        // 开头一句之后还在调工具 / 等工具结果：没结束。
        write(&path, &[session.clone(), ask.clone(), opening.clone()]);
        assert_eq!(turn_reply(&pi, &path), None);
        write(
            &path,
            &[
                session.clone(),
                ask.clone(),
                opening.clone(),
                result.clone(),
            ],
        );
        assert_eq!(turn_reply(&pi, &path), None);
        // 最后是 assistant 纯文本：结束；思考过程不影响。
        let ended = [
            session.clone(),
            ask.clone(),
            opening,
            result,
            final_text,
            thinking,
        ];
        write(&path, &ended);
        assert_eq!(turn_reply(&pi, &path).as_deref(), Some("最终结论"));
        // 新的用户消息开始了下一轮。
        let mut next = ended.to_vec();
        next.push(prompt);
        write(&path, &next);
        assert_eq!(turn_reply(&pi, &path), None);

        // codex：没有正文的 function_call 也是工具调用。
        let codex = spec("codex", temp.path());
        let item = |payload: Value| json!({"type": "response_item", "payload": payload});
        let meta = json!({"type": "session_meta", "payload": {"id": "c1", "cwd": "/w"}});
        let answer = item(
            json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "答复"}]}),
        );
        write(&path, &[meta.clone(), answer.clone()]);
        assert_eq!(turn_reply(&codex, &path).as_deref(), Some("答复"));
        write(
            &path,
            &[
                meta,
                answer,
                item(json!({"type": "function_call", "name": "shell", "arguments": "{}"})),
            ],
        );
        assert_eq!(turn_reply(&codex, &path), None);
    }

    #[test]
    fn codex_shape_skips_reasoning_tool_calls_and_picks_newest_session() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let work = temp.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let item = |payload: Value| json!({"type": "response_item", "payload": payload});
        write(
            &root.join("2026/10/01/old.jsonl"),
            &[
                json!({"type": "session_meta", "payload": {"id": "old", "cwd": work}}),
                item(
                    json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "old reply"}]}),
                ),
            ],
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(
            &root.join("2026/10/01/new.jsonl"),
            &[
                json!({"type": "session_meta", "payload": {"id": "new", "cwd": format!("{}/", work.display())}}),
                item(
                    json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>x"}]}),
                ),
                item(
                    json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "final answer"}]}),
                ),
                item(
                    json!({"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]}),
                ),
                item(json!({"type": "function_call", "name": "shell", "arguments": "{}"})),
                json!({"type": "event_msg", "payload": {"type": "agent_message", "message": "event"}}),
            ],
        );
        let reply = find_last(&spec("codex", &root), &work.canonicalize().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(reply.session_id.as_deref(), Some("new"));
        assert_eq!(reply.text, "final answer");
    }

    #[test]
    fn json_document_sessions_read_the_session_from_a_sibling_document() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("sessions");
        let work = temp.path().join("work");
        fs::create_dir_all(&work).unwrap();
        // 一个会话一个目录：`<id>.json` 记会话（含 cwd），`<id>.messages.json` 记消息数组。
        let dir = root.join("s1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("s1.json"),
            json!({"session_id": "s1", "cwd": work}).to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("s1.messages.json"),
            json!({"messages": [
                {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "hmm"},
                    {"type": "text", "text": "hello from a document"},
                    {"type": "tool_use", "name": "run"}
                ]},
                {"role": "user", "content": [{"type": "tool_result", "content": "out"}]}
            ]})
            .to_string(),
        )
        .unwrap();
        let spec: SessionSpec = serde_json::from_value(json!({
            "storage": "json", "path": root, "files": "**/*.messages.json",
            "records": "/messages", "sessionDocument": "{@path.parent.name}.json",
            "session": {"id": "/session_id", "project": "/cwd"},
            "message": {"role": "/role", "content": "/content"}
        }))
        .unwrap();
        let reply = find_last(&spec, &work.canonicalize().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(reply.session_id.as_deref(), Some("s1"));
        assert_eq!(reply.text, "hello from a document");
        assert!(reply.path.ends_with("s1/s1.messages.json"));

        let mut recordless = spec.clone();
        recordless.records = None;
        assert!(find_last(&recordless, &work).is_err());
    }

    #[test]
    fn sqlite_or_projectless_declarations_are_unsupported() {
        let temp = tempfile::tempdir().unwrap();
        let mut sqlite = spec("pi", temp.path());
        sqlite.storage = "sqlite".into();
        assert!(find_last(&sqlite, temp.path()).is_err());
        let mut projectless = spec("pi", temp.path());
        projectless.session.project = None;
        assert!(find_last(&projectless, temp.path()).is_err());
    }
}
