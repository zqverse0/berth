//! Agent CLI 的 hook 事件（`berth group hook <事件>`）：Agent 自己报告会话开始、一轮开始 / 结束、需要关注。
//!
//! - **状态写回 pane**：往 Agent 所在终端写 OSC 9;4 进度 / OSC 9 通知（[`signal`]），termd 据此给出
//!   working / idle / attention——GUI 状态点、群组送达看的是同一个来源，不再看屏幕输出猜。
//! - **会话开始**：记下这个终端的会话 id 与会话文件（[`watch::MemberState`]），`/clear` 再次触发即换绑。
//! - **一轮结束**：把回答贴回它回答的委托。
//!
//! 之后叫醒后台进程（[`watch::kick`]）投排队的消息。stdin 是 Claude Code / Codex 同形的 hook JSON
//! （`session_id`、`transcript_path`、`last_assistant_message`、`message`、`source`）；
//! 各 Agent 的 launch.js 把原生 hook 接到这几个事件上，Berth 不认 Agent 品牌。

use std::path::PathBuf;

use berth_project_core::tasks::group;
use serde_json::{json, Value};

use crate::term::{Sessions, Terminals};
use crate::{identity, text, watch, Ctx};

/// 汇报摘要里回复正文的长度；全文在事件 `text` 里。
const DIGEST_CHARS: usize = 800;
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

/// 处理一个 hook 事件的群组部分（状态已由调用方按 [`signal`] 写回 pane）。调用方 `ctx.caller` 是 Agent 所在终端。
pub fn handle(ctx: &Ctx, term: Option<&dyn Terminals>, sessions: &dyn Sessions, hook: Hook, payload: &Value) {
    let Some(caller) = ctx.caller.as_deref() else {
        return;
    };
    match hook {
        Hook::SessionStart => {
            session_start(ctx, term, caller, payload);
        }
        Hook::TurnEnd => turn_end(ctx, sessions, caller, payload),
        Hook::TurnStart => {
            // 启动时项目还没启用 Berth（或群账本被清过）的 Agent 没报告过会话，就一直进不了群：
            // 一轮开始时补记，叫醒后台进程让它入群。
            if session_start(ctx, term, caller, payload) {
                watch::kick(ctx);
            }
            turn_start(ctx, caller, payload);
        }
        Hook::Attention | Hook::Idle => {}
    }
    if matches!(hook, Hook::SessionStart | Hook::TurnEnd | Hook::Idle) {
        watch::kick(ctx);
    }
}

/// 记下终端的会话：成员名是终端的专家（没选专家的 Agent 不入群，也不记）。返回是否第一次记下。
fn session_start(ctx: &Ctx, term: Option<&dyn Terminals>, caller: &str, payload: &Value) -> bool {
    let Some(session_id) = text(payload, "session_id") else {
        return false;
    };
    let Some(member) = term
        .and_then(|term| term.probe(caller).ok())
        .and_then(|probe| identity::member_name(&probe))
    else {
        return false;
    };
    let main = &ctx.main;
    let mut state = watch::member_state(main, group::MAIN_GROUP, &member, caller).unwrap_or_default();
    let first = state.session_id.is_none();
    state.session_id = Some(session_id.to_owned());
    state.session_path = transcript(payload).or(state.session_path);
    watch::save_state(main, group::MAIN_GROUP, &member, caller, &state);
    first
}

/// 一轮开始：群成员拍下工作目录的改动快照，一轮结束时比出这一轮改了哪些文件（不论这轮是谁发起的）。
fn turn_start(ctx: &Ctx, caller: &str, payload: &Value) {
    let main = &ctx.main;
    let Ok(events) = group::events(main, group::MAIN_GROUP) else {
        return;
    };
    let Some(member) = group::member_of(&events, caller) else {
        return;
    };
    let Some(cwd) = text(payload, "cwd").or_else(|| member.body(caller)?.cwd.as_deref()) else {
        return;
    };
    let mut state = watch::member_state(main, group::MAIN_GROUP, &member.name, caller).unwrap_or_default();
    state.before = Some(watch::snapshot(std::path::Path::new(cwd)));
    watch::save_state(main, group::MAIN_GROUP, &member.name, caller, &state);
}

/// 会话文件路径解开软链：Agent 的临时配置目录（软链到真实会话目录）在会话结束后就删了。
fn transcript(payload: &Value) -> Option<PathBuf> {
    let path = PathBuf::from(text(payload, "transcript_path")?);
    Some(std::fs::canonicalize(&path).unwrap_or(path))
}

/// 已送达 `member` 的最近一条别人的消息（自动汇报不算提问）。还在排队的不算：它还没进这一轮。
fn last_ask<'a>(events: &'a [Value], member: &'a str, delivered: u64) -> Option<&'a Value> {
    group::messages_to(events, member)
        .filter(|event| text(event, "source") != Some("transcript"))
        .filter(|event| text(event, "author") != Some(member))
        .filter(|event| group::seq(event) <= delivered)
        .last()
}

/// 一轮结束：只汇报别人发来消息（已送达）之后的第一轮；用户直接在终端里驱动的轮次不贴。
fn turn_end(ctx: &Ctx, sessions: &dyn Sessions, caller: &str, payload: &Value) {
    let main = &ctx.main;
    let name = group::MAIN_GROUP;
    let Ok(events) = group::events(main, name) else {
        return;
    };
    let Some(member) = group::member_of(&events, caller) else {
        return;
    };
    let mut state = watch::member_state(main, name, &member.name, caller).unwrap_or_default();
    // 会话换过（恢复别的会话）时以 hook 为准。
    if let Some(id) = text(payload, "session_id").filter(|id| state.session_id.as_deref() != Some(*id)) {
        state.session_id = Some(id.to_owned());
        state.session_path = transcript(payload);
        watch::save_state(main, name, &member.name, caller, &state);
    }
    let delivered = group::delivered_seq(main, name, &member.name, caller);
    let Some(asked) = last_ask(&events, &member.name, delivered) else {
        return;
    };
    let asked_seq = group::seq(asked);
    if asked_seq <= state.reported_for {
        return;
    }
    let agent = member.body(caller).and_then(|body| body.agent.clone());
    // hook 没带回答（个别 Agent）时读会话文件里这一轮的最终回答。
    let reply = text(payload, "last_assistant_message")
        .map(str::to_owned)
        .or_else(|| sessions.turn_reply(agent.as_deref()?, state.session_path.as_deref()?))
        .map(|reply| reply.trim().to_owned())
        .filter(|reply| !reply.is_empty());
    let Some(reply) = reply else {
        return;
    };
    // 这一轮改了的文件（与一轮开始时的快照比）；路径相对 `root`。
    let targets = agent
        .as_deref()
        .zip(state.session_path.as_deref())
        .map(|(agent, path)| sessions.turn_targets(agent, path))
        .unwrap_or_default();
    let (root, files) = state
        .before
        .as_ref()
        .map(|before| watch::turn_files(before, &targets))
        .unwrap_or_default();
    let mut digest: String = reply.chars().take(DIGEST_CHARS).collect();
    if reply.chars().count() > DIGEST_CHARS {
        digest = format!("{}…（已截断，全文见群）", digest.trim_end());
    }
    let mut report = json!({
        "kind": "message", "author": member.name,
        "to": text(asked, "author").unwrap_or(group::USER),
        "source": "transcript", "text": reply, "digest": digest,
        // 出自哪个终端：卡片标明，回复它的委托也回到这个终端。
        "target_ref": caller, "agent": agent,
        // 结果指向它回答的委托。
        "reply_to": asked_seq,
        "session_id": state.session_id,
    });
    if !files.is_empty() {
        report["files"] = json!(files);
        report["root"] = json!(root.to_string_lossy());
    }
    if group::append(main, name, report).is_ok() {
        state.reported_for = asked_seq;
        watch::save_state(main, name, &member.name, caller, &state);
    }
}
