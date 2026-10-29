//! 会话与群的关系（会话监控）：所属群按会话目录，来源与在跑由群账本推导，不另存启动记录。
//! CLI `berth session list` 与 GUI 会话视图共用。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::group::{self, MAIN_GROUP};
use super::TaskResult;

/// 会话从哪里来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// 群账本或成员状态里出现过这个会话 id（Berth 终端里的 Agent）。
    Berth,
    /// 账本开始记录会话之后、却没被记下的会话（其他终端）。
    External,
    /// 账本开始记录会话之前就不再活动，无从判断。
    Unknown,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Berth => "berth",
            Self::External => "external",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Default)]
pub struct SessionLinks {
    /// （群名，群目录）；含目录已删的群，旧会话仍能归到它。
    pub groups: Vec<(String, PathBuf)>,
    berth: HashSet<String>,
    /// 在跑的会话 id → 绑定它的成员（群名，成员名）。
    live: HashMap<String, (String, String)>,
    /// 账本最早记下会话 id 的时间（毫秒）。
    since_ms: Option<u64>,
}

/// 读主项目的群账本。没有账本（未启用 Berth）时只有 `main` 群。
pub fn session_links(main: &Path) -> TaskResult<SessionLinks> {
    let mut links = SessionLinks::default();
    let meta = if group::dir(main).join("groups.json").is_file() {
        group::meta(main)?
    } else {
        Value::Null
    };
    // 删掉的群只剩一行：原目录（仍按它归组会话）与它记下过的会话。
    for (name, entry) in meta["retired"].as_object().into_iter().flatten() {
        if let Some(worktree) = entry.get("worktree").and_then(Value::as_str) {
            links.groups.push((name.clone(), PathBuf::from(worktree)));
        }
        for id in entry["sessions"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            links.berth.insert(id.to_owned());
        }
        if let Some(at) = entry.get("since").and_then(Value::as_u64) {
            links.since_ms = Some(links.since_ms.map_or(at, |since| since.min(at)));
        }
    }
    for (name, entry) in meta["groups"].as_object().into_iter().flatten() {
        let group_dir = match entry.pointer("/env/worktree").and_then(Value::as_str) {
            Some(worktree) => Some(PathBuf::from(worktree)),
            None => (name == MAIN_GROUP).then(|| main.to_path_buf()),
        };
        if let Some(dir) = &group_dir {
            links.groups.push((name.clone(), dir.clone()));
        }
        // ponytail: 账本坏一个就跳过它，不让会话列表整体失败。
        let Ok(events) = group::events(main, name) else {
            continue;
        };
        for event in &events {
            if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                links.berth.insert(id.to_owned());
                if let Some(at) = event.get("timestamp_ms").and_then(Value::as_u64) {
                    links.since_ms = Some(links.since_ms.map_or(at, |since| since.min(at)));
                }
            }
        }
        // 在跑 = 当前在群的成员绑定的会话；成员进出由后台 watch 按 pane 维护（只管目录还在的群）。
        if !group_dir.is_some_and(|dir| dir.is_dir()) {
            continue;
        }
        for member in group::members(&events) {
            for body in &member.bodies {
                if let Some(id) = group::bound_session_in(main, name, &events, &body.target_ref) {
                    links.berth.insert(id.clone());
                    links.live.insert(id, (name.clone(), member.name.clone()));
                }
            }
        }
    }
    let members_dir = group::runtime_dir(main).join("members");
    for entry in fs::read_dir(members_dir).into_iter().flatten().flatten() {
        let state: Option<Value> = fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        if let Some(id) = state
            .as_ref()
            .and_then(|state| state.get("sessionId"))
            .and_then(Value::as_str)
        {
            links.berth.insert(id.to_owned());
        }
    }
    if !links.groups.iter().any(|(name, _)| name == MAIN_GROUP) {
        links
            .groups
            .push((MAIN_GROUP.to_owned(), main.to_path_buf()));
    }
    // 群目录统一成真实路径（目录已删的保持原样），与会话里的目录可比。
    for (_, path) in &mut links.groups {
        if let Ok(real) = path.canonicalize() {
            *path = real;
        }
    }
    Ok(links)
}

impl SessionLinks {
    /// `cwd` 所属的群：包含它的最深群目录。
    pub fn group_of(&self, cwd: &Path) -> Option<&str> {
        self.groups
            .iter()
            .filter(|(_, root)| cwd.starts_with(root))
            .max_by_key(|(_, root)| root.components().count())
            .map(|(name, _)| name.as_str())
    }

    pub fn group_dir(&self, name: &str) -> Option<&Path> {
        self.groups
            .iter()
            .find(|(group, _)| group == name)
            .map(|(_, root)| root.as_path())
    }

    /// 群的显示名：群目录名。
    pub fn group_label(&self, name: &str) -> Option<String> {
        self.groups
            .iter()
            .find(|(group, _)| group == name)
            .and_then(|(_, root)| root.file_name())
            .map(|part| part.to_string_lossy().into_owned())
    }

    pub fn origin(&self, session_id: Option<&str>, updated_at_ms: u64) -> Origin {
        if session_id.is_some_and(|id| self.berth.contains(id)) {
            Origin::Berth
        } else if self.since_ms.is_none_or(|since| updated_at_ms < since) {
            Origin::Unknown
        } else {
            Origin::External
        }
    }

    pub fn live(&self, session_id: Option<&str>) -> bool {
        self.live_member(session_id).is_some()
    }

    /// 正在写这个会话的成员：（群名，成员名）。
    pub fn live_member(&self, session_id: Option<&str>) -> Option<(&str, &str)> {
        let (group, member) = self.live.get(session_id?)?;
        Some((group.as_str(), member.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_lines(path: &Path, lines: &[Value]) {
        let body: Vec<String> = lines.iter().map(Value::to_string).collect();
        fs::write(path, body.join("\n") + "\n").unwrap();
    }

    #[test]
    fn links_follow_group_directories_and_the_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("proj");
        let tree = temp.path().join("proj-feat");
        fs::create_dir_all(&tree).unwrap();
        let dir = group::dir(&main);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("groups.json"),
            json!({"groups": {
                "main": {"env": {"branch": "dev", "baseBranch": "dev", "worktree": main}},
                "checkout-1": {"env": {"branch": "feat", "baseBranch": "dev", "worktree": tree}},
            }, "retired": {
                "gone": {"worktree": temp.path().join("proj-old"), "sessions": ["s-gone"], "since": 9000},
                "10-04-x": {"worktree": null, "sessions": ["s-task"], "since": 9000},
            }})
            .to_string(),
        )
        .unwrap();
        fs::create_dir_all(&main).unwrap();
        // 在群成员 pi-1 绑定 s-live；已离群的 codex-1 汇报过 s-old；删掉的群留下 s-gone、s-task。
        write_lines(
            &dir.join("checkout-1.jsonl"),
            &[
                json!({"seq": 1, "kind": "joined", "author": "pi-1", "target_ref": "t1", "session_id": null, "timestamp_ms": 5000}),
                json!({"seq": 2, "kind": "joined", "author": "codex-1", "target_ref": "t2", "timestamp_ms": 5100}),
                json!({"seq": 3, "kind": "message", "author": "codex-1", "session_id": "s-old", "timestamp_ms": 6000}),
                json!({"seq": 4, "kind": "message", "author": "pi-1", "session_id": "s-live", "timestamp_ms": 7000}),
                json!({"seq": 5, "kind": "left", "author": "codex-1", "timestamp_ms": 8000}),
            ],
        );
        let links = session_links(&main).unwrap();

        let main_real = main.canonicalize().unwrap();
        let tree_real = tree.canonicalize().unwrap();
        assert_eq!(links.group_of(&main_real.join("src")), Some("main"));
        assert_eq!(links.group_of(&tree_real), Some("checkout-1"));
        assert_eq!(
            links.group_of(&temp.path().join("proj-old/src")),
            Some("gone")
        );
        assert_eq!(links.group_of(Path::new("/elsewhere")), None);
        assert_eq!(
            links.group_label("checkout-1").as_deref(),
            Some("proj-feat")
        );

        assert_eq!(
            links.live_member(Some("s-live")),
            Some(("checkout-1", "pi-1"))
        );
        assert!(!links.live(Some("s-old")) && !links.live(None));
        // 删掉的群没有成员，它的会话不算在跑。
        assert!(!links.live(Some("s-task")) && !links.live(Some("s-gone")));
        assert_eq!(links.origin(Some("s-gone"), 1), Origin::Berth);
        assert_eq!(links.origin(Some("s-old"), 1), Origin::Berth);
        assert_eq!(links.origin(Some("s-task"), 1), Origin::Berth);
        // 账本最早记下会话 id 是 6000：之前就不再活动的会话来源未知，之后的算外部。
        assert_eq!(links.origin(Some("other"), 5999), Origin::Unknown);
        assert_eq!(links.origin(Some("other"), 6000), Origin::External);
        assert_eq!(links.origin(None, 6000), Origin::External);
    }

    #[test]
    fn project_without_ledger_has_only_the_main_group() {
        let temp = tempfile::tempdir().unwrap();
        let links = session_links(temp.path()).unwrap();
        assert_eq!(
            links.group_of(&temp.path().canonicalize().unwrap()),
            Some(MAIN_GROUP)
        );
        assert_eq!(links.origin(Some("x"), 1), Origin::Unknown);
    }
}
