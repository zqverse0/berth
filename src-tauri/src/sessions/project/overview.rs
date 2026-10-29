//! 项目会话总览（侧栏「会话」视图）：全部 Agent 在主 checkout 与各群目录下的会话，
//! 带所属群、来源与在跑成员。与 CLI `berth session list` 共用 `session_files` 与 `session_links`。

#[cfg(feature = "tauri-runtime")]
use std::collections::HashMap;
use std::path::Path;

use berth_project_core::tasks::{main_project, session_links::session_links};
#[cfg(feature = "tauri-runtime")]
use berth_tool_core::session_files::{readable_spec, recent_sessions, title};
#[cfg(feature = "tauri-runtime")]
use serde::Serialize;

use crate::models::SessionGroupLink;

#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionOverviewItem {
    /// 工具 id（`tools/<id>`）。
    pub agent: String,
    pub session_id: Option<String>,
    pub cwd: String,
    /// 最后活动（毫秒 mtime）。
    pub updated_at: u64,
    pub title: Option<String>,
    pub group: String,
    pub group_name: String,
    pub group_dir: String,
    /// `berth` / `external` / `unknown`。
    pub origin: &'static str,
    /// 在跑时绑定它的群成员名。
    pub live_member: Option<String>,
}

#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionOverview {
    pub items: Vec<ProjectSessionOverviewItem>,
    pub has_more: bool,
}

/// 会话 tab 头部用：`project_path` 目录下的会话 `session_id` 在本项目群里的归属。
pub(crate) fn session_group_link(
    project_path: &Path,
    session_id: &str,
    updated_at_ms: u64,
) -> Option<SessionGroupLink> {
    let main = main_project(project_path).ok()?;
    let links = session_links(&main).ok()?;
    let cwd = project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_owned());
    let group = links.group_of(&cwd)?;
    let dir = links.group_dir(group);
    Some(SessionGroupLink {
        group: group.to_owned(),
        group_name: links.group_label(group).unwrap_or_else(|| group.to_owned()),
        group_dir: dir
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default(),
        group_dir_exists: dir.is_some_and(Path::is_dir),
        main_dir: main.to_string_lossy().into_owned(),
        origin: links.origin(Some(session_id), updated_at_ms).as_str(),
        live_member: links
            .live_member(Some(session_id))
            .map(|(_, member)| member.to_owned()),
    })
}

/// `project_path` 所在项目的会话，最近活动在前，最多 `limit` 条。
#[cfg(feature = "tauri-runtime")]
pub(crate) fn project_session_overview(
    project_path: &Path,
    limit: usize,
) -> Result<ProjectSessionOverview, String> {
    let main = main_project(project_path).map_err(|error| error.to_string())?;
    let links = session_links(&main).map_err(|error| error.to_string())?;
    let mut specs = HashMap::new();
    let mut rows = Vec::new();
    for agent in berth_tool_core::repository::list_tool_asset_ids() {
        // 没有可读会话声明的 Agent 不进列表。
        let Ok(spec) = readable_spec(&agent) else {
            continue;
        };
        // 各 Agent 取够 limit + 1 条就停，合并后仍能判断 has_more。
        for session in
            recent_sessions(&spec, 0, |cwd| links.group_of(cwd).is_some()).take(limit + 1)
        {
            rows.push((agent.clone(), session));
        }
        specs.insert(agent, spec);
    }
    rows.sort_by_key(|(_, session)| std::cmp::Reverse(session.updated_at));
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    // 列出的会话已知文件位置：登记给声明式 reader，点开时不必在整个会话目录里按 id 查找。
    for (agent, session) in &rows {
        if let (Some(agent_type), Some(id)) = (agent_type_of(agent), &session.session_id) {
            crate::sessions::declarative::remember_source_locator(agent_type, id, &session.path);
        }
    }
    let items = rows
        .into_iter()
        .map(|(agent, session)| {
            let group = links.group_of(&session.cwd).unwrap_or_default().to_owned();
            let id = session.session_id.as_deref();
            ProjectSessionOverviewItem {
                title: specs
                    .get(&agent)
                    .and_then(|spec| title(spec, &session.path)),
                group_name: links.group_label(&group).unwrap_or_else(|| group.clone()),
                group_dir: links
                    .group_dir(&group)
                    .map(|dir| dir.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                origin: links.origin(id, session.updated_at).as_str(),
                live_member: links.live_member(id).map(|(_, member)| member.to_owned()),
                cwd: session.cwd.to_string_lossy().into_owned(),
                updated_at: session.updated_at,
                session_id: session.session_id,
                agent,
                group,
            }
        })
        .collect();
    Ok(ProjectSessionOverview { items, has_more })
}

/// 工具声明的 `projectType` 对应的会话身份；未声明或未知时为 `None`。
#[cfg(feature = "tauri-runtime")]
fn agent_type_of(agent: &str) -> Option<crate::models::AgentType> {
    let asset = berth_tool_core::repository::load_tool_asset(agent).ok()??;
    let project_type = asset
        .agent_extension()?
        .get("projectType")?
        .as_str()?
        .to_owned();
    crate::models::agent::parse_known_agent_type(&project_type)
}
