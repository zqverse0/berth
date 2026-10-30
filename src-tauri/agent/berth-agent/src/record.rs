//! 一轮的完整记录（[`crate::Agent::last_turn`]）→ 便于显示的条目，界面不必认识 genai 的消息结构。

use genai::chat::{ChatMessage, ChatRole, ContentPart};
use serde_json::{json, Value};

/// 会话文件的一行（[`crate::session`]）→ 对话记录里的一轮：原有字段（提问序号、时间、用量等）照搬，
/// `messages` 换成提问正文 `text` 与便于显示的 `items`。
pub fn turn(line: &Value) -> Value {
    let messages: Vec<ChatMessage> =
        serde_json::from_value(line["messages"].clone()).unwrap_or_default();
    let mut view = line.clone();
    if let Some(map) = view.as_object_mut() {
        map.remove("messages");
        let ask = messages
            .iter()
            .find(|message| message.role == ChatRole::User)
            .and_then(|message| message.content.first_text());
        map.insert("text".into(), json!(ask));
        map.insert("items".into(), Value::Array(readable(&messages)));
    }
    view
}

/// 依次为模型的话 `{ kind: "text", text }` 与工具调用
/// `{ kind: "tool", name, args, output, failed }`（结果按调用 id 配上；没有结果时 `output` 为 null）。
/// 开头那条提问不在其中。
pub fn readable(messages: &[ChatMessage]) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    for message in messages {
        for part in message.content.parts() {
            match (&message.role, part) {
                (ChatRole::Assistant, ContentPart::Text(text)) if !text.trim().is_empty() => {
                    items.push(json!({ "kind": "text", "text": text }));
                }
                (ChatRole::Assistant, ContentPart::ToolCall(call)) => items.push(json!({
                    "kind": "tool", "id": call.call_id, "name": call.fn_name,
                    "args": call.fn_arguments, "output": null, "failed": false,
                })),
                (ChatRole::Tool, ContentPart::ToolResponse(response)) => {
                    if let Some(item) = items
                        .iter_mut()
                        .rev()
                        .find(|item| item["id"] == response.call_id.as_str())
                    {
                        item["output"] = json!(response.content);
                        item["failed"] = json!(response.content.starts_with("Error: "));
                    }
                }
                _ => {}
            }
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use genai::chat::{MessageContent, ToolCall, ToolResponse};

    #[test]
    fn a_session_line_becomes_a_record_turn() {
        let line = json!({
            "ask": 7, "complete": true,
            "messages": [ChatMessage::user("how many?"), ChatMessage::assistant("six")],
        });
        let view = turn(&line);
        assert_eq!(view["ask"], 7);
        assert_eq!(view["text"], "how many?");
        assert_eq!(view["items"], json!([{"kind": "text", "text": "six"}]));
        assert!(view.get("messages").is_none());
    }

    #[test]
    fn pairs_tool_calls_with_their_results() {
        let call = |id: &str| {
            ContentPart::ToolCall(ToolCall {
                call_id: id.into(),
                fn_name: "read".into(),
                fn_arguments: json!({"path": id}),
                thought_signatures: None,
            })
        };
        let messages = vec![
            ChatMessage::user("ask"),
            ChatMessage::assistant(MessageContent::from_parts(vec![
                ContentPart::Text("looking".into()),
                call("a"),
                call("b"),
            ])),
            vec![
                ToolResponse::new("b", "Error: missing"),
                ToolResponse::new("a", "content"),
            ]
            .into(),
            ChatMessage::assistant("done"),
        ];
        let items = readable(&messages);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0], json!({"kind": "text", "text": "looking"}));
        assert_eq!(items[1]["output"], "content");
        assert_eq!(items[1]["failed"], false);
        assert_eq!(items[2]["args"], json!({"path": "b"}));
        assert_eq!(items[2]["failed"], true);
        assert_eq!(items[3]["text"], "done");
    }
}
