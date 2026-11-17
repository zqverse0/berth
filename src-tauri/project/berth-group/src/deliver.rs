//! 送达：发给 ACP 成员、还没送到的消息由群组运行时（[`crate::acp`]）以 `session/prompt` 发出。
//! 群账本 jsonl 是事实源，投递标记只记已送达的最大 seq。

use std::path::Path;

use berth_project_core::tasks::group::{self, Member};
use serde_json::{json, Value};

use crate::{text, watch, Ctx};

/// 发给成员、还没投出去的消息：已投到的位置取它（本次入群以来）各投递标记的最大值，
/// 起点是上次离群处（离线时发的回来照投）。
pub(crate) fn pending<'a>(main: &Path, name: &str, events: &'a [Value], member: &'a Member) -> Vec<&'a Value> {
    let after = events
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("joined"))
        .filter(|event| text(event, "author") == Some(member.name.as_str()) && group::seq(event) >= member.joined_seq)
        .filter_map(|event| text(event, "target_ref"))
        .map(|body| group::delivered_seq(main, name, &member.name, body))
        .fold(group::delivery_floor(events, member), u64::max);
    group::messages_to(events, &member.name).filter(|event| group::seq(event) > after).collect()
}

/// post / spec / change 之后：收件人是 ACP 成员就叫醒运行时马上发；别的（内置 Berth、离线专家）消息留在群里。
pub(crate) fn doorbell(ctx: &Ctx, name: &str, participant: &str) -> Value {
    let Ok(events) = group::events(&ctx.main, name) else {
        return json!({"status": "failed", "reason": "cannot read group"});
    };
    let Some(member) = group::members(&events).into_iter().find(|member| member.name == participant) else {
        return json!({"status": "skipped", "reason": "not_a_member"});
    };
    if !member.bodies.iter().any(|body| crate::acp::is_acp(&body.target_ref)) {
        return json!({"status": "skipped", "reason": "no_target_ref"});
    }
    watch::kick_now(ctx);
    json!({"status": "queued", "reason": "acp"})
}
