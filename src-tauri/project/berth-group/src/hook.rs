//! Agent CLI 的 hook 事件（`berth group hook <事件>`）：Agent 自己报告会话开始、一轮开始 / 结束、需要关注。
//!
//! 只做一件事：往 Agent 所在终端写 OSC 9;4 进度 / OSC 9 通知（[`signal`]），termd 据此给出
//! working / idle / attention，GUI 状态点看的就是它。终端里的 Agent 不进群（群成员走 ACP）。
//! stdin 是 Claude Code / Codex 同形的 hook JSON；各 Agent 的 launch.js 把原生 hook 接到这几个事件上，Berth 不认 Agent 品牌。

use serde_json::Value;

use crate::text;

/// 写回 pane 的通知文本长度上限。
const NOTICE_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hook {
    /// 会话开始（启动、恢复、`/clear`；压缩上下文后的重新开始不改状态）。
    SessionStart,
    /// 一轮开始（提交了提示）。
    TurnStart,
    /// 一轮结束，带最终回答。
    TurnEnd,
    /// 一轮中需要用户处理（授权、选择）。
    Attention,
    /// 一轮被打断或出错结束，没有回答。
    Idle,
}

impl Hook {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "session-start" => Self::SessionStart,
            "turn-start" => Self::TurnStart,
            "turn-end" => Self::TurnEnd,
            "attention" => Self::Attention,
            "idle" => Self::Idle,
            _ => return None,
        })
    }
}

/// 写回 pane 的终端序列（OSC 9;4 进度 / OSC 9 通知）；`None` 表示不改状态。
pub fn signal(hook: Hook, payload: &Value) -> Option<String> {
    match hook {
        // 压缩上下文发生在一轮中间：不能借此报空闲。
        Hook::SessionStart => (text(payload, "source") != Some("compact")).then(|| "\x1b]9;4;0\x07".to_owned()),
        Hook::TurnStart => Some("\x1b]9;4;3\x07".to_owned()),
        Hook::TurnEnd | Hook::Idle => Some("\x1b]9;4;0\x07".to_owned()),
        Hook::Attention => Some(format!("\x1b]9;{}\x07", notice(payload))),
    }
}

/// 通知文本：Agent 给的提示，没有时按授权的工具名；去掉控制字符，避免被当成 `4;` 进度信号。
fn notice(payload: &Value) -> String {
    let text = text(payload, "message")
        .map(str::to_owned)
        .or_else(|| text(payload, "tool_name").map(|tool| format!("需要授权：{tool}")))
        .unwrap_or_else(|| "需要你处理".to_owned());
    let clean: String = text
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .take(NOTICE_CHARS)
        .collect();
    if clean.starts_with("4;") {
        format!(" {clean}")
    } else {
        clean
    }
}
