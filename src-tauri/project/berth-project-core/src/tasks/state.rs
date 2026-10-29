//! 本机实时状态 `<主项目>/.berth/local/tasks.json`：任务 ↔ 分支 / worktree 绑定与完成状态。
//!
//! 只存在主项目一份，所有 worktree 读写它；不进 git，新 clone 时为空（不从 task.json 推断，
//! 旧数据经 `berth task migrate` 显式导入）。写入方只有 `berth task`。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fsutil;
use super::hub::local_dir;
use super::{TaskError, TaskResult};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Live {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    /// 放弃收尾（未合并就结束）：仍是 completed，视图另标「已放弃」。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub abandoned: bool,
    /// 取消归档的原因：`Some("")` 是没写原因；完成归档为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// 任务引用的项目群内部键；成员归属不读取任务引用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

impl Live {
    pub fn is_completed(&self) -> bool {
        self.status.as_deref() == Some("completed")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct State {
    #[serde(default = "version")]
    pub version: u32,
    /// 键是任务目录名。
    #[serde(default)]
    pub tasks: BTreeMap<String, Live>,
}

fn version() -> u32 {
    1
}

fn path(main: &Path) -> PathBuf {
    local_dir(main).join("tasks.json")
}

pub(crate) fn load(main: &Path) -> TaskResult<State> {
    match fsutil::read_json(&path(main))? {
        // 新项目直接是当前版本，不走旧版本转换。
        None => Ok(State {
            version: 2,
            ..State::default()
        }),
        Some(value) => serde_json::from_value(value).map_err(|error| {
            TaskError::new(
                "invalid_json",
                format!("Malformed {}: {error}", path(main).display()),
            )
        }),
    }
}

/// 加锁读改写；`local/` 只在主项目里，由 `berth init` 创建，这里不隐式创建 `.berth/`。
pub(crate) fn update<T>(
    main: &Path,
    change: impl FnOnce(&mut State) -> TaskResult<T>,
) -> TaskResult<T> {
    if !main.join(".berth").is_dir() {
        return Err(super::hub::not_initialized(main));
    }
    let local = local_dir(main);
    if !local.join(".gitignore").exists() {
        // 旧项目可能还没有 `local/`：先放好忽略文件，实时状态绝不能被提交。
        fsutil::atomic_write(&local.join(".gitignore"), b"*\n")?;
    }
    let _guard = fsutil::lock(&local.join("tasks.json.lock"))?;
    let mut state = load(main)?;
    let result = change(&mut state)?;
    fsutil::write_json(&path(main), &state)?;
    Ok(result)
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub(crate) fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
