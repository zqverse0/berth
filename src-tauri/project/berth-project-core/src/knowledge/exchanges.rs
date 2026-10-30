//! 会话按「一问一答」分组，规则与会话页 `src/sessions/exchanges.ts` 一致（两边共用
//! `src/sessions/exchanges.fixture.json` 的测试样例，改规则要两边一起改）：
//! - 提问 = 含文本或图片的 user 轮；只带工具结果的 user 轮属于过程；
//! - 回答 = 本段最后一个 assistant 文本块；
//! - 过程 = 其余块：说明文字（assistant 文本块）、工具调用与结果、思考。
//!
//! 输入是各 Agent 会话经 `sessions.json` 读取后的统一格式（`MessageTurn` 的 JSON），只取用到的字段。

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Turn {
    pub role: String,
    pub blocks: Vec<Block>,
    pub timestamp: DateTime<Utc>,
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
    },
    Image {},
    ToolUse {
        #[serde(default)]
        tool_use_id: Option<String>,
        tool_name: String,
        #[serde(default)]
        input_preview: Option<String>,
    },
    ToolResult {
        #[serde(default)]
        tool_use_id: Option<String>,
        #[serde(default)]
        output_preview: Option<String>,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

/// 出错的工具调用。
#[derive(Debug, Clone, PartialEq)]
pub struct ToolError {
    pub tool: String,
    pub input: String,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Exchange {
    /// 从 1 开始，与会话页「第 N 问」一致；0 是首个提问之前的开场内容。
    pub index: usize,
    /// 提问的文本（图片不计）；开场段为 `None`。
    pub prompt: Option<String>,
    /// 过程里的说明文字，按出现顺序。
    pub steps: Vec<String>,
    pub errors: Vec<ToolError>,
    pub answer: Option<String>,
    /// 这一问里最晚的时间（各轮 `completed_at` / `timestamp`）。
    pub latest: DateTime<Utc>,
}

fn text(block: &Block) -> Option<&str> {
    match block {
        Block::Text { text } if !text.trim().is_empty() => Some(text.trim()),
        _ => None,
    }
}

fn is_prompt(turn: &Turn) -> bool {
    turn.role == "user" && turn.blocks.iter().any(|block| text(block).is_some() || matches!(block, Block::Image {}))
}

fn build(index: usize, prompt: Option<&Turn>, body: &[&Turn]) -> Exchange {
    // 回答 = 最后一个 assistant 文本块的位置。
    let answer_at = body.iter().enumerate().rev().find_map(|(t, turn)| {
        (turn.role == "assistant")
            .then(|| turn.blocks.iter().rposition(|block| text(block).is_some()).map(|b| (t, b)))
            .flatten()
    });
    let mut steps = Vec::new();
    let mut errors = Vec::new();
    let mut calls: HashMap<&str, (&str, &str)> = HashMap::new();
    for (t, turn) in body.iter().enumerate() {
        for (b, block) in turn.blocks.iter().enumerate() {
            match block {
                Block::Text { .. } if turn.role == "assistant" && answer_at != Some((t, b)) => {
                    steps.extend(text(block).map(str::to_owned));
                }
                Block::ToolUse { tool_use_id: Some(id), tool_name, input_preview } => {
                    calls.insert(id, (tool_name, input_preview.as_deref().unwrap_or_default()));
                }
                Block::ToolResult { tool_use_id, output_preview, is_error: true } => {
                    let (tool, input) = tool_use_id.as_deref().and_then(|id| calls.get(id).copied()).unwrap_or(("?", ""));
                    errors.push(ToolError {
                        tool: tool.to_owned(),
                        input: input.to_owned(),
                        output: output_preview.clone().unwrap_or_default(),
                    });
                }
                _ => {}
            }
        }
    }
    let latest = prompt
        .into_iter()
        .chain(body.iter().copied())
        .map(|turn| turn.completed_at.unwrap_or(turn.timestamp).max(turn.timestamp))
        .max()
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
    Exchange {
        index,
        prompt: prompt.map(|turn| turn.blocks.iter().filter_map(text).collect::<Vec<_>>().join("\n")),
        steps,
        errors,
        answer: answer_at.and_then(|(t, b)| text(&body[t].blocks[b])).map(str::to_owned),
        latest,
    }
}

pub fn exchanges(turns: &[Turn]) -> Vec<Exchange> {
    let mut result = Vec::new();
    let mut prompt: Option<&Turn> = None;
    let mut body: Vec<&Turn> = Vec::new();
    let mut prompts = 0;
    let mut close = |prompt: Option<&Turn>, body: &[&Turn], prompts: usize| {
        if prompt.is_some() || body.iter().any(|turn| !turn.blocks.is_empty()) {
            result.push(build(if prompt.is_some() { prompts } else { 0 }, prompt, body));
        }
    };
    for turn in turns {
        if is_prompt(turn) {
            close(prompt, &body, prompts);
            prompts += 1;
            prompt = Some(turn);
            body.clear();
        } else {
            body.push(turn);
        }
    }
    close(prompt, &body, prompts);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// 与前端 `exchanges.test.ts` 共用的样例：同一份会话，两边分出同样的问答。
    #[test]
    fn matches_the_shared_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../../../src/sessions/exchanges.fixture.json")).unwrap();
        let turns: Vec<Turn> = serde_json::from_value(fixture["turns"].clone()).unwrap();
        let got: Vec<Value> = exchanges(&turns)
            .into_iter()
            .map(|exchange| {
                serde_json::json!({
                    "index": exchange.index,
                    "prompt": exchange.prompt,
                    "steps": exchange.steps,
                    "errors": exchange.errors.iter().map(|error| &error.tool).collect::<Vec<_>>(),
                    "answer": exchange.answer,
                })
            })
            .collect();
        assert_eq!(Value::Array(got), fixture["expected"]);
    }
}
