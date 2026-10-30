//! 群里的内置成员 Berth：不开终端、由宿主进程直接跑模型（`berth-agent`）。
//! 本模块只管账本这一侧：执行过程的日志行、回答写成群消息、哪些提问已回答。
//! 对话上下文不从账本取（宿主的会话文件，见 `berth_member`）。

use berth_project_core::tasks::group;
use serde_json::{json, Value};

use crate::text;

/// 内置成员的名字（账本里的 author / to）。
pub const BERTH: &str = "berth";

/// 回答摘要的长度，同 Agent 一轮结束的汇报。
const DIGEST_CHARS: usize = 800;

/// 发给 Berth、已有回答（Berth 的消息 `reply_to` 指向它）的消息序号。
pub fn answered(events: &[Value]) -> std::collections::HashSet<u64> {
    events
        .iter()
        .filter(|event| {
            text(event, "kind") == Some("message") && text(event, "author") == Some(BERTH)
        })
        .filter_map(|event| event.get("reply_to").and_then(Value::as_u64))
        .collect()
}

/// 一轮执行过程最多记这么多行（进回答事件，账本有大小上限）。
pub const STEP_LINES: usize = 200;
/// 一行日志的最多字符数。
const LINE_CHARS: usize = 120;

/// 执行过程的一行，与前端会话日志（`sessionLog`）同形：`{ text, error? }`。
/// 工具调用：`→ 工具名 对象`（命令或路径，取参数的第一行）。
pub fn tool_line(name: &str, args: &str) -> Value {
    let args: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    let target = ["command", "path"]
        .iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .map(|target| first_line(target, 80))
        .unwrap_or_default();
    let text = if target.is_empty() {
        format!("→ {name}")
    } else {
        format!("→ {name} {target}")
    };
    json!({ "text": text })
}

/// 工具报错：`✗ 输出的第一行`。
pub fn error_line(output: &str) -> Value {
    let output = output.strip_prefix("Error: ").unwrap_or(output);
    json!({ "text": format!("✗ {}", first_line(output, LINE_CHARS)), "error": true })
}

/// 模型说的话：取第一行；空的不记。
pub fn text_line(text: &str) -> Option<Value> {
    let line = first_line(text, LINE_CHARS);
    (!line.is_empty()).then(|| json!({ "text": line }))
}

fn first_line(text: &str, max: usize) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .take(max)
        .collect()
}

/// Berth 对 `asked` 的回答，写成与 Agent 汇报同形的群消息；`steps` 是这一轮的执行过程，
/// `usage` 是这一轮的用量（没有为 null，不写）。
pub fn reply_event(
    asked: &Value,
    reply: &str,
    model: &str,
    steps: &[Value],
    usage: &Value,
) -> Value {
    let reply = reply.trim();
    let mut digest: String = reply.chars().take(DIGEST_CHARS).collect();
    if reply.chars().count() > DIGEST_CHARS {
        digest = format!("{}…（已截断，全文见群）", digest.trim_end());
    }
    let mut event = json!({
        "kind": "message", "author": BERTH,
        "to": text(asked, "author").unwrap_or(group::USER),
        "source": "transcript", "text": reply, "digest": digest,
        "agent": BERTH, "model": model,
        "reply_to": group::seq(asked),
        "steps": &steps[steps.len().saturating_sub(STEP_LINES)..],
    });
    if !usage.is_null() {
        event["usage"] = usage.clone();
    }
    event
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(seq: u64, author: &str, to: &str, text: &str) -> Value {
        json!({"seq": seq, "kind": "message", "author": author, "to": to, "text": text})
    }

    #[test]
    fn builtin_answered_collects_reply_targets() {
        let asked = message(1, "user", "berth", "go");
        let mut reply = reply_event(&asked, "ok", "m", &[], &Value::Null);
        reply["seq"] = json!(2);
        let events = vec![asked, reply, message(3, "user", "berth", "pending")];
        assert_eq!(answered(&events), [1].into_iter().collect());
    }

    #[test]
    fn builtin_log_lines_match_the_session_log_shape() {
        assert_eq!(
            tool_line("bash", r#"{"command": "berth tools list\necho done"}"#),
            json!({"text": "→ bash berth tools list"})
        );
        assert_eq!(
            tool_line("write", r#"{"path": "a.json", "content": "x"}"#),
            json!({"text": "→ write a.json"})
        );
        assert_eq!(
            error_line("Error: old_text not found in a.json"),
            json!({"text": "✗ old_text not found in a.json", "error": true})
        );
        assert_eq!(
            text_line("\n  Let me check.\nmore"),
            Some(json!({"text": "Let me check."}))
        );
        assert_eq!(text_line("  \n"), None);
    }

    #[test]
    fn builtin_reply_answers_the_asker_and_points_at_the_ask() {
        let asked = message(7, "user", "berth", "go");
        let reply = reply_event(
            &asked,
            &"x".repeat(900),
            "deepseek-flash",
            &[tool_line("read", "{}")],
            &json!({"calls": 2}),
        );
        assert_eq!(reply["author"], BERTH);
        assert_eq!(reply["to"], "user");
        assert_eq!(reply["reply_to"], 7);
        assert_eq!(reply["model"], "deepseek-flash");
        assert_eq!(reply["steps"], json!([{"text": "→ read"}]));
        assert_eq!(reply["usage"]["calls"], 2);
        assert!(reply["digest"]
            .as_str()
            .unwrap()
            .ends_with("（已截断，全文见群）"));
    }
}
