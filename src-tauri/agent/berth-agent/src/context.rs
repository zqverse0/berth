//! 上下文预算：每次调模型前把消息压进预算，以及存进历史前的清理。纯函数，不读写文件。
//!
//! 超预算时按这个顺序腾地方，直到降到预算的 [`TARGET_PERCENT`]（留出余量，免得之后每次调用都
//! 重新裁剪、把服务商的前缀缓存打掉）：
//! 1. 从最早的消息起，把工具输出和工具调用里的长参数换成占位（最近 [`KEEP_RECENT`] 条不动）；
//! 2. 还超就整轮丢掉最早的对话（一轮 = 一条用户消息到下一条之前），当前这一轮永远保留。
//!
//! 整轮丢弃，工具调用与它的结果总是一起走，不会留下孤立的 tool_use。

use genai::chat::{ChatMessage, ChatRole, ContentPart};
use serde_json::Value;

/// 消息部分的预算（估算 token）。系统提示词与工具定义另算，约几千。
// ponytail: 固定值按 64k 窗口的模型留余量；要按模型窗口定时从服务商模型清单读上下文长度。
pub const BUDGET: usize = 48_000;
/// 超预算时降到预算的这个百分比。
const TARGET_PERCENT: usize = 70;
/// 最近这么多条消息里的工具输出原样保留：模型刚看过、可能马上要用。
const KEEP_RECENT: usize = 6;
/// 短于这个字符数的工具输出与参数不值得换成占位。
const STUB_MIN_CHARS: usize = 400;

/// 粗估 token：ASCII 约 4 字符一个，其余（中文等）约 1 字符一个。
// ponytail: 估算；要更准时用服务商回报的 usage（`Tally::context`）校准系数。
pub fn estimate(messages: &[ChatMessage]) -> usize {
    messages.iter().map(estimate_one).sum()
}

fn estimate_one(message: &ChatMessage) -> usize {
    let json = serde_json::to_string(&message.content).unwrap_or_default();
    let (ascii, other) = json.chars().fold((0, 0), |(ascii, other), char| {
        if char.is_ascii() {
            (ascii + 1, other)
        } else {
            (ascii, other + 1)
        }
    });
    ascii / 4 + other + 4
}

/// 把 `messages` 压进 `budget`；没超就不动（保持前缀稳定，缓存才命中）。
pub fn fit(messages: &mut Vec<ChatMessage>, budget: usize) {
    let mut total = estimate(messages);
    if total <= budget {
        return;
    }
    let target = budget * TARGET_PERCENT / 100;

    let stubbable = messages.len().saturating_sub(KEEP_RECENT);
    for message in messages.iter_mut().take(stubbable) {
        if total <= target {
            return;
        }
        let before = estimate_one(message);
        stub(message);
        total = total - before + estimate_one(message);
    }

    // 当前这一轮从最后一条用户消息开始，不丢。
    while total > target {
        let Some(current) = last_user(messages) else {
            return;
        };
        let Some(first) = messages[..current]
            .iter()
            .position(|message| message.role == ChatRole::User)
        else {
            return;
        };
        let end = messages[first + 1..current]
            .iter()
            .position(|message| message.role == ChatRole::User)
            .map_or(current, |offset| first + 1 + offset);
        total -= estimate(&messages[first..end]);
        messages.drain(first..end);
    }
}

fn last_user(messages: &[ChatMessage]) -> Option<usize> {
    messages
        .iter()
        .rposition(|message| message.role == ChatRole::User)
}

/// 工具输出与工具调用里的长参数换成占位；文本不动。
fn stub(message: &mut ChatMessage) {
    for part in message.content.iter_mut() {
        match part {
            ContentPart::ToolResponse(response) => {
                let chars = response.content.chars().count();
                if chars >= STUB_MIN_CHARS {
                    response.content =
                        format!("[旧的工具输出已省略（{chars} 字符）；需要时重新执行]");
                }
            }
            ContentPart::ToolCall(call) => stub_value(&mut call.fn_arguments),
            _ => {}
        }
    }
}

fn stub_value(value: &mut Value) {
    match value {
        Value::String(text) => {
            let chars = text.chars().count();
            if chars >= STUB_MIN_CHARS {
                *text = format!("[已省略 {chars} 字符]");
            }
        }
        Value::Array(items) => items.iter_mut().for_each(stub_value),
        Value::Object(map) => map.values_mut().for_each(stub_value),
        _ => {}
    }
}

/// 一轮结束、存进历史前：去掉思考块与思考签名。之后可能换了模型或服务商，旧签名回放会被拒收；
/// 之前轮次的思考服务商本来也不要求带回。去掉后空了的消息一并丢掉。
pub fn for_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let parts: Vec<ContentPart> = message
                .content
                .parts()
                .iter()
                .filter(|part| {
                    !matches!(
                        part,
                        ContentPart::ThoughtSignature(_)
                            | ContentPart::ReasoningContent(_)
                            | ContentPart::Custom(_)
                    )
                })
                .cloned()
                .map(|part| match part {
                    ContentPart::ToolCall(mut call) => {
                        call.thought_signatures = None;
                        ContentPart::ToolCall(call)
                    }
                    other => other,
                })
                .collect();
            (!parts.is_empty()).then(|| ChatMessage::new(message.role.clone(), parts))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use genai::chat::{MessageContent, ToolCall, ToolResponse};
    use serde_json::json;

    fn call(id: &str, content: &str) -> ChatMessage {
        ChatMessage::assistant(MessageContent::from_parts(vec![ContentPart::ToolCall(
            ToolCall {
                call_id: id.into(),
                fn_name: "write".into(),
                fn_arguments: json!({"path": "a", "content": content}),
                thought_signatures: Some(vec!["sig".into()]),
            },
        )]))
    }

    fn output(id: &str, content: &str) -> ChatMessage {
        vec![ToolResponse::new(id, content)].into()
    }

    /// 一轮：提问、一次工具调用与输出、回答。
    fn turn(n: usize, size: usize) -> Vec<ChatMessage> {
        let id = format!("c{n}");
        vec![
            ChatMessage::user(format!("ask {n}")),
            call(&id, "x"),
            output(&id, &"o".repeat(size)),
            ChatMessage::assistant(format!("answer {n}")),
        ]
    }

    fn tool_output(message: &ChatMessage) -> &str {
        &message.content.tool_responses()[0].content
    }

    #[test]
    fn leaves_messages_alone_under_budget() {
        let mut messages = turn(1, 1000);
        let before = serde_json::to_string(&messages).unwrap();
        fit(&mut messages, 10_000);
        assert_eq!(serde_json::to_string(&messages).unwrap(), before);
    }

    #[test]
    fn stubs_old_tool_output_first_and_keeps_recent_messages() {
        let mut messages = [turn(1, 8000), turn(2, 8000), turn(3, 8000)].concat();
        let budget = estimate(&messages) - 1;
        fit(&mut messages, budget);
        // 省略第一轮的输出就降到目标以下：不丢轮，第二轮的输出也不动。
        assert_eq!(messages.len(), 12);
        assert!(tool_output(&messages[2]).starts_with("[旧的工具输出已省略"));
        assert_eq!(tool_output(&messages[6]).len(), 8000);
        assert_eq!(tool_output(&messages[10]).len(), 8000);
    }

    #[test]
    fn stubs_long_tool_arguments() {
        let mut messages = vec![ChatMessage::user("go"), call("c1", &"y".repeat(9000))];
        messages.extend((0..KEEP_RECENT).map(|_| ChatMessage::assistant("pad")));
        fit(&mut messages, 500);
        let args = &messages[1].content.tool_calls()[0].fn_arguments;
        assert_eq!(args["content"], "[已省略 9000 字符]");
        assert_eq!(args["path"], "a");
    }

    #[test]
    fn drops_whole_old_turns_but_never_the_current_one() {
        let mut messages = [turn(1, 100), turn(2, 100), turn(3, 9000)].concat();
        let current = messages.len() - 4;
        let current_turn = serde_json::to_string(&messages[current..]).unwrap();
        fit(&mut messages, 10);
        // 只剩当前一轮，且原样保留；没有孤立的工具调用或输出。
        assert_eq!(serde_json::to_string(&messages).unwrap(), current_turn);
    }

    #[test]
    fn history_drops_thinking_and_signatures() {
        let thinking = ChatMessage::assistant(MessageContent::from_parts(vec![
            ContentPart::ReasoningContent("hmm".into()),
            ContentPart::ThoughtSignature("sig".into()),
        ]));
        let cleaned = for_history(&[ChatMessage::user("q"), thinking, call("c1", "x")]);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[1].content.tool_calls()[0].thought_signatures, None);
    }
}
