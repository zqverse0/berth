//! 成员身份：一个 Agent 终端就是一个成员；基础名是专家，没选专家时是 Agent，
//! 重名的依次编号 `名-2`、`名-3`（入群时定下，之后不变）。名字只跟终端的启动参数走，不信 Agent 自报；`--as` 只给不在本群成员终端里的调用方（GUI 的 user、脚本）。

use std::path::Path;

use berth_project_core::tasks::{group, TaskError, TaskResult};
use serde_json::Value;

use crate::term::PaneProbe;

/// 终端的基础名：它的专家，没选专家时是它的 Agent；不是 Agent 终端时为 `None`（不入群）。
pub(crate) fn member_name(probe: &PaneProbe) -> Option<String> {
    probe.expert.clone().or_else(|| crate::term::agent_of(probe))
}

/// 新终端入群用的成员名：基础名没被在群成员占用就用它，否则取最小的空闲编号 `基础名-N`（N ≥ 2）。
pub(crate) fn fresh_name(events: &[Value], base: &str) -> String {
    let taken: std::collections::HashSet<String> =
        group::members(events).into_iter().map(|member| member.name).collect();
    if !taken.contains(base) {
        return base.to_owned();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|name| !taken.contains(name))
        .unwrap_or_default()
}

/// 终端会话状态记在哪个名字下：已是成员用它的成员名，还没入群用基础名
/// （入群时才定编号，后台进程据基础名找到它、再把状态挪到成员名下）。
pub(crate) fn recorded_name(events: &[Value], target_ref: &str, probe: &PaneProbe) -> Option<String> {
    group::member_of(events, target_ref)
        .map(|member| member.name)
        .or_else(|| member_name(probe))
}

/// 终端在群里的名字：已是成员用它的成员名，否则是入群时会取的名字。
pub(crate) fn name_for(events: &[Value], target_ref: &str, probe: &PaneProbe) -> Option<String> {
    group::member_of(events, target_ref)
        .map(|member| member.name)
        .or_else(|| Some(fresh_name(events, &member_name(probe)?)))
}

/// 终端（`target_ref`）在本群的成员名；不是本群成员的终端时为 `None`。
pub(crate) fn pane_member(events: &[Value], pane: Option<&str>) -> Option<String> {
    group::member_of(events, pane?).map(|member| member.name)
}

/// 发言者：调用方（`caller` 是它所在终端）在本群成员终端里以终端为准（`--as` 写错也不冒名），否则用 `--as`。
pub(crate) fn author(events: &[Value], caller: Option<&str>, as_name: &str) -> TaskResult<String> {
    if let Some(member) = pane_member(events, caller) {
        return Ok(member);
    }
    let name = as_name.trim();
    if name.is_empty() {
        return Err(TaskError::new(
            "invalid_input",
            "--as is required outside a group member's terminal",
        ));
    }
    Ok(name.to_owned())
}

/// 显示名（`join --as`、`spawn --name`）：与当前不同才记，重复入群不刷事件；重名等失败不影响入群。
pub(crate) fn set_label(main: &Path, group: &str, member: &str, label: &str) {
    let current = group::events(main, group).ok().and_then(|events| {
        group::members(&events)
            .into_iter()
            .find(|entry| entry.name == member)
            .and_then(|entry| entry.label)
    });
    if current.as_deref() != Some(label) {
        let _ = group::rename(main, group, member, Some(label));
    }
}
