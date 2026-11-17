//! 发言者身份：群成员是 ACP 成员（入群时定名）；从命令行发言要写 `--as`（GUI 的 user、脚本、终端里的 Agent）。

use std::path::Path;

use berth_project_core::tasks::{group, TaskError, TaskResult};

/// 发言者：`--as` 的名字。
pub(crate) fn author(as_name: &str) -> TaskResult<String> {
    let name = as_name.trim();
    if name.is_empty() {
        return Err(TaskError::new("invalid_input", "--as is required"));
    }
    Ok(name.to_owned())
}

/// 显示名（`spawn --name`）：与当前不同才记，重复入群不刷事件；重名等失败不影响入群。
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
