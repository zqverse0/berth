//! 成员身份：成员 = 专家（启动栏选的专家），一个专家可以同时有几个终端，群里仍是一个成员。
//! 没选专家的 Agent 不入群。名字只跟终端的启动参数走，不信 Agent 自报；`--as` 只给不在本群成员终端里的调用方（GUI 的 user、脚本）。

use std::path::Path;

use berth_project_core::tasks::{group, TaskError, TaskResult};
use serde_json::Value;

use crate::term::PaneProbe;

/// 终端对应的成员名：它的专家；没选专家时为 `None`（不入群）。
pub(crate) fn member_name(probe: &PaneProbe) -> Option<String> {
    probe.expert.clone()
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
