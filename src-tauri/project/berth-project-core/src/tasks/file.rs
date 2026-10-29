//! 单文件任务 `.berth/tasks/<MM-DD-slug>.md`：frontmatter（title / status / idea / steps）+ 固定骨架正文。
//! 步骤在 frontmatter 的 `steps`（id / do / change / verify / commit），正文只放目标、背景、不做、验收、记录。
//! status 只由 `berth task` 命令写；分支、worktree、群这些本机绑定仍在 `local/tasks.json`。
//! 旧任务（目录 + task.json + prd.md）照旧可读，不迁移。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::fsutil::{self, MAX_ARTIFACT_BYTES};
use super::state::Live;
use super::{TaskError, TaskResult};
use crate::knowledge::{replace_status, split_frontmatter};

pub(crate) const PLANNING: &str = "规划中";
pub(crate) const RUNNING: &str = "进行中";
pub(crate) const DONE: &str = "已完成";
pub(crate) const ABANDONED: &str = "已放弃";

/// 规划里还没填的占位；开工前必须换掉。
const TODO: &str = "待补充";

/// 一步：做什么、改哪里、怎么验证；`commit` 由 `berth task step` 写入。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileStep {
    pub id: String,
    #[serde(rename = "do", default)]
    pub action: String,
    #[serde(default)]
    pub change: String,
    #[serde(default)]
    pub verify: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// 新任务的正文骨架；`background` 是升级来源想法的原话与讨论。
pub(crate) fn skeleton(background: Option<&str>) -> String {
    let background = background
        .map(|text| format!("## 背景\n\n{}\n\n", text.trim()))
        .unwrap_or_default();
    format!(
        "## 目标\n\n{TODO}：一句话结果。\n\n{background}## 不做\n\n- {TODO}\n\n\
         ## 验收\n\n- [ ] {TODO}：端到端可检查的结果\n\n## 记录\n"
    )
}

fn placeholder_steps() -> Vec<FileStep> {
    vec![FileStep {
        id: "S1".into(),
        action: format!("{TODO}：一句话说清做什么"),
        change: format!("{TODO}：文件与函数"),
        verify: format!("{TODO}：一条能直接运行的命令"),
        commit: None,
    }]
}

pub(crate) fn is_file_task(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "md") && path.is_file()
}

pub(crate) fn read(path: &Path) -> TaskResult<String> {
    fsutil::read_text(path, MAX_ARTIFACT_BYTES)
}

fn malformed(path: &Path, error: impl std::fmt::Display) -> TaskError {
    TaskError::new(
        "invalid_json",
        format!("Malformed frontmatter in {}: {error}", path.display()),
    )
}

fn mapping(path: &Path, text: &str) -> TaskResult<serde_yaml::Mapping> {
    let frontmatter = split_frontmatter(text).0.unwrap_or_default();
    match serde_yaml::from_str(frontmatter).map_err(|error| malformed(path, error))? {
        serde_yaml::Value::Mapping(map) => Ok(map),
        serde_yaml::Value::Null => Ok(Default::default()),
        _ => Err(malformed(path, "not a mapping")),
    }
}

/// frontmatter 转成与 task.json 同形的记录（title / status / idea / steps）。
pub(crate) fn record(path: &Path) -> TaskResult<Value> {
    let map = mapping(path, &read(path)?)?;
    serde_json::to_value(map).map_err(|error| malformed(path, error))
}

/// 记录里的步骤；`steps` 写坏时报出原因，不当成没有步骤。
pub(crate) fn steps(record: &Value) -> TaskResult<Vec<FileStep>> {
    match record.get("steps") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(steps) => serde_json::from_value(steps.clone()).map_err(|error| {
            TaskError::new("invalid_json", format!("Malformed steps: {error}"))
        }),
    }
}

/// 去掉 frontmatter 的正文（任务页编辑的就是它）。
pub(crate) fn body(text: &str) -> &str {
    split_frontmatter(text).1
}

fn compose(map: &serde_yaml::Mapping, body: &str) -> TaskResult<String> {
    let frontmatter = serde_yaml::to_string(map)
        .map_err(|error| TaskError::new("io_error", error.to_string()))?;
    Ok(format!("---\n{frontmatter}---\n\n{}\n", body.trim()))
}

fn steps_yaml(steps: &[FileStep]) -> TaskResult<serde_yaml::Value> {
    serde_yaml::to_value(steps).map_err(|error| TaskError::new("io_error", error.to_string()))
}

pub(crate) fn render(title: &str, idea: Option<&str>, body: &str) -> TaskResult<String> {
    let mut map = serde_yaml::Mapping::new();
    map.insert("title".into(), title.into());
    map.insert("status".into(), PLANNING.into());
    if let Some(idea) = idea.map(str::trim).filter(|idea| !idea.is_empty()) {
        map.insert("idea".into(), idea.into());
    }
    map.insert("steps".into(), steps_yaml(&placeholder_steps())?);
    compose(&map, body)
}

pub(crate) fn set_status(path: &Path, status: &str) -> TaskResult<()> {
    let text = read(path)?;
    fsutil::atomic_write(path, replace_status(&text, status).as_bytes())
}

/// 改写步骤和 / 或正文，其余 frontmatter 原样保留。
/// `body` 是（加载时的正文，新正文）：磁盘上的正文已被别人改过就拒绝，免得盖掉 Agent 写的记录。
pub(crate) fn save(
    path: &Path,
    steps: Option<&[FileStep]>,
    body_edit: Option<(&str, &str)>,
) -> TaskResult<()> {
    let text = read(path)?;
    let mut map = mapping(path, &text)?;
    let current = body(&text);
    let next_body = match body_edit {
        Some((base, _)) if base.trim() != current.trim() => {
            return Err(TaskError::new(
                "conflict",
                "Task file changed on disk; reload before saving",
            ))
        }
        Some((_, next)) => next,
        None => current,
    };
    if let Some(steps) = steps {
        let mut ids = std::collections::HashSet::new();
        if let Some(step) = steps.iter().find(|step| !ids.insert(step.id.as_str())) {
            return Err(TaskError::new("invalid_input", format!("Duplicate step {}", step.id)));
        }
        map.insert("steps".into(), steps_yaml(steps)?);
    }
    fsutil::atomic_write(path, compose(&map, next_body)?.as_bytes())
}

/// 开工前检查：至少一步，每步的 do / change / verify 都填了且不是占位。
pub(crate) fn check_plan(steps: &[FileStep]) -> TaskResult<()> {
    if steps.is_empty() {
        return Err(TaskError::new("invalid_state", "Plan has no steps; fill `steps` first"));
    }
    let gaps: Vec<String> = steps
        .iter()
        .flat_map(|step| {
            [("do", &step.action), ("change", &step.change), ("verify", &step.verify)]
                .into_iter()
                .filter(|(_, value)| value.trim().is_empty() || value.contains(TODO))
                .map(move |(field, _)| format!("{}.{field}", step.id))
        })
        .collect();
    if gaps.is_empty() {
        Ok(())
    } else {
        Err(TaskError::new(
            "invalid_state",
            format!("Plan is incomplete, fill these first: {}", gaps.join(", ")),
        ))
    }
}

/// `## <heading>` 下非空行的最后 `count` 行。
pub(crate) fn section_tail(body: &str, heading: &str, count: usize) -> Vec<String> {
    let marker = format!("## {heading}");
    let Some(start) = body.lines().position(|line| line.trim() == marker) else {
        return Vec::new();
    };
    let lines: Vec<String> = body
        .lines()
        .skip(start + 1)
        .take_while(|line| !line.starts_with("## "))
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect();
    lines[lines.len().saturating_sub(count)..].to_vec()
}

/// 单文件任务的状态以文件为准，覆盖 `local/tasks.json` 里的同名字段；旧任务的记录没有这些取值，原样返回。
pub(crate) fn apply_status(record: &Value, live: &mut Live) {
    let (status, abandoned) = match record.get("status").and_then(Value::as_str) {
        Some(PLANNING) => (None, false),
        Some(RUNNING) => (Some("in_progress"), false),
        Some(DONE) => (Some("completed"), false),
        Some(ABANDONED) => (Some("completed"), true),
        _ => return,
    };
    live.status = status.map(str::to_owned);
    live.abandoned = abandoned;
}
