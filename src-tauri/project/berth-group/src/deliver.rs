//! 送达：把发给某成员、还没送到的消息投进它的 pane。
//!
//! 只投给 hook 报告过会话、且不在一轮里的终端（[`watch::deliverable`]）：括号粘贴正文 + Enter；
//! 正文超长或含控制字符时只投一行「去读」指针。群账本 jsonl 是事实源，投递标记只记已送达的最大 seq。

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::time::Duration;

use berth_project_core::tasks::group::{self, Member};
use serde_json::{json, Value};

use crate::term::{self, Fail, Terminals};
use crate::{text, watch, Ctx};
use crate::term::Input;

/// 正文超过该字节数只投指针。
const DELIVER_MAX_BYTES: usize = 4000;
const QUOTE_MAX_CHARS: usize = 300;

/// 同一 (群, 成员) 同时只允许一个投递者（不论投给它的哪个终端）；拿不到说明别的进程正在投。
pub(crate) fn slot(main: &Path, name: &str, participant: &str) -> Option<File> {
    let path = group::delivery_path(main, name, participant, "").with_extension("lock");
    std::fs::create_dir_all(path.parent()?).ok()?;
    let handle = OpenOptions::new().create(true).append(true).open(&path).ok()?;
    handle.try_lock().ok()?;
    Some(handle)
}

/// 消息指定由成员的哪个终端接：消息自己带的 `target_ref`（spawn 给新终端的任务），
/// 否则是它回复的那条结果出自的终端（同一条委托链回到原来的终端）。那个终端已不在群时不指定。
fn preferred<'a>(events: &'a [Value], member: &Member, message: &'a Value) -> Option<&'a str> {
    let pinned = text(message, "target_ref").or_else(|| {
        let quoted = message.get("reply_to").and_then(Value::as_u64)?;
        let quoted = events.iter().find(|event| group::seq(event) == quoted)?;
        (text(quoted, "author") == Some(member.name.as_str())).then(|| text(quoted, "target_ref"))?
    })?;
    member.body(pinned).map(|_| pinned)
}

/// 该由 `target_ref` 这个终端接、还没投出去的消息。成员的消息按顺序投：
/// 已投到的位置取它各终端（本次入群以来）投递标记的最大值，起点是上次全部离群处（离线时发的回来照投）；遇到指定给别的在群终端的就停，免得乱序。
pub(crate) fn pending<'a>(main: &Path, name: &str, events: &'a [Value], member: &'a Member, target_ref: &str) -> Vec<&'a Value> {
    let after = events
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("joined"))
        .filter(|event| text(event, "author") == Some(member.name.as_str()) && group::seq(event) >= member.joined_seq)
        .filter_map(|event| text(event, "target_ref"))
        .map(|body| group::delivered_seq(main, name, &member.name, body))
        .fold(group::delivery_floor(events, member), u64::max);
    group::messages_to(events, &member.name)
        .filter(|event| group::seq(event) > after)
        .take_while(|event| preferred(events, member, event).is_none_or(|pinned| pinned == target_ref))
        .collect()
}

/// 待投递消息拼成正文；超长或含控制字符（换行、制表除外）返回 `None`，改投指针。
/// 引用回复（`reply_to`）带上被引消息的摘录，收件方不用翻账本就知道在回哪条。
pub(crate) fn body(name: &str, messages: &[&Value], events: &[Value]) -> Option<String> {
    let body = messages
        .iter()
        .map(|event| {
            let quoted = event
                .get("reply_to")
                .and_then(Value::as_u64)
                .and_then(|seq| events.iter().find(|event| group::seq(event) == seq))
                .map(|quoted| {
                    let excerpt: String = text(quoted, "digest")
                        .or_else(|| text(quoted, "text"))
                        .unwrap_or("")
                        .chars()
                        .take(QUOTE_MAX_CHARS)
                        .collect();
                    let lines: Vec<String> = excerpt.lines().map(|line| format!("> {line}")).collect();
                    format!(
                        "> 引用 #{} {}：\n{}\n",
                        group::seq(quoted),
                        text(quoted, "author").unwrap_or("?"),
                        lines.join("\n")
                    )
                })
                .unwrap_or_default();
            format!(
                "[berth 群 {name} · 来自 {}]\n{quoted}{}",
                text(event, "author").unwrap_or("?"),
                text(event, "digest").or_else(|| text(event, "text")).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let unsafe_char = body.chars().any(|ch| {
        (ch < ' ' && ch != '\n' && ch != '\t') || ('\u{7f}'..='\u{9f}').contains(&ch)
    });
    (!unsafe_char && body.len() <= DELIVER_MAX_BYTES).then_some(body)
}

/// shell 安全的单个参数（与 `shlex.quote` 同规则）。
fn quote(arg: &str) -> String {
    let safe = !arg.is_empty()
        && arg
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "@%+=:,./-_".contains(ch));
    if safe {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', "'\"'\"'"))
    }
}

/// 给 Agent 粘贴的 `berth group` 命令；`--workspace` 写主项目绝对路径，worktree 里也回到同一群。
pub(crate) fn command(ctx: &Ctx, args: &[&str]) -> String {
    let exe = ctx.cli.to_string_lossy();
    let main = ctx.main.to_string_lossy();
    let mut parts = vec![exe.as_ref(), "group", "--json", "--workspace", &main];
    parts.extend_from_slice(args);
    parts.iter().map(|part| quote(part)).collect::<Vec<_>>().join(" ")
}

fn pointer(ctx: &Ctx, name: &str, participant: &str) -> String {
    format!(
        "[berth] 群 {name} 有给你的新消息：{}",
        command(ctx, &["read", name, "--to", participant])
    )
}

/// 粘贴与回车之间留一点间隔：有的 TUI 把紧跟在粘贴后的回车当成正文里的换行。
const ENTER_AFTER_PASTE: Duration = Duration::from_millis(150);

/// 投递 `participant` 该由这个终端接的未送达消息（[`pending`]）。调用方持有投递锁并已确认终端可投。
/// 括号粘贴正文（超长或含控制字符时粘贴指针行）再回车；终端没开括号粘贴（termd 拒绝）时返回 `waiting`，稍后重试。
pub(crate) fn ring(ctx: &Ctx, term: &dyn Terminals, name: &str, participant: &str, target_ref: &str) -> Value {
    let main = &ctx.main;
    let Ok(events) = group::events(main, name) else {
        return json!({"status": "failed", "reason": "cannot read group"});
    };
    let Some(member) = group::members(&events).into_iter().find(|member| member.name == participant) else {
        return json!({"status": "skipped", "reason": "not_a_member"});
    };
    let pending = pending(main, name, &events, &member, target_ref);
    let Some(last) = pending.iter().map(|event| group::seq(event)).max() else {
        return json!({"status": "skipped", "reason": "delivered"});
    };
    let (text, kind) = match body(name, &pending, &events) {
        Some(body) => (body, "body"),
        None => (pointer(ctx, name, participant), "pointer"),
    };
    match term.send(target_ref, Input::Text(text), true) {
        Err(Fail::Unavailable(reason)) => return json!({"status": "waiting", "reason": reason}),
        Err(Fail::Stale) => return json!({"status": "stale"}),
        Ok(()) => {}
    }
    std::thread::sleep(ENTER_AFTER_PASTE);
    match term.send(target_ref, Input::Key("Enter".into()), false) {
        Err(Fail::Stale) => json!({"status": "stale"}),
        Err(Fail::Unavailable(reason)) => json!({"status": "failed", "reason": reason}),
        Ok(()) => {
            let _ = group::set_delivered(main, name, participant, target_ref, last);
            json!({"status": "rung", "delivered": kind})
        }
    }
}

/// post / spec / change 之后：在 Berth 终端里且成员有终端可投就立即送达（指定的终端优先）；
/// 都在一轮里或不在 Berth 终端里时排队，由后台进程在它一轮结束时送达。
pub(crate) fn doorbell(
    ctx: &Ctx,
    term: Option<&dyn Terminals>,
    name: &str,
    participant: &str,
) -> Value {
    let Ok(events) = group::events(&ctx.main, name) else {
        return json!({"status": "failed", "reason": "cannot read group"});
    };
    let Some(member) = group::members(&events).into_iter().find(|member| member.name == participant) else {
        return json!({"status": "skipped", "reason": "not_a_member"});
    };
    if member.bodies.is_empty() {
        return json!({"status": "skipped", "reason": "no_target_ref"});
    }
    let Some(term) = term else {
        // GUI / 手机发的：叫醒后台马上投，不等下一个周期。
        watch::nudge(ctx);
        return json!({"status": "queued", "reason": "outside_berth_terminal"});
    };
    let Some(_slot) = slot(&ctx.main, name, participant) else {
        return json!({"status": "deferred", "state": "working"});
    };
    let mut state = "stale";
    for body in &member.bodies {
        let probe = match term.probe(&body.target_ref) {
            Ok(probe) => probe,
            Err(Fail::Stale) => continue,
            Err(Fail::Unavailable(reason)) => return json!({"status": "failed", "reason": reason}),
        };
        let body_state = term::state_name(&probe);
        if body_state != "stale" {
            state = body_state;
        }
        if !watch::deliverable(&ctx.main, name, participant, &body.target_ref, &probe) {
            continue;
        }
        let mut rung = ring(ctx, term, name, participant, &body.target_ref);
        if rung["status"] == "skipped" {
            // 这个终端没有该它接的（消息指定给了别的终端）：看下一个。
            continue;
        }
        rung["state"] = json!(body_state);
        rung["target_ref"] = json!(body.target_ref);
        if rung["status"] == "waiting" {
            watch::ensure_running(ctx);
        }
        return rung;
    }
    if state == "stale" {
        return json!({"status": "stale"});
    }
    watch::ensure_running(ctx);
    json!({"status": "deferred", "state": state})
}
