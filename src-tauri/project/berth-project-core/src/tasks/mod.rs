//! 项目任务：`.berth/tasks/<名>.md`（单文件，见 `file`；旧任务是 `<目录>/prd.md + task.json`，进 git）与本机实时状态
//! `<主项目>/.berth/local/tasks.json`（绑定的分支 / worktree、完成状态，不进 git）。
//!
//! CLI `berth task` 与 GUI 任务视图共用这里；状态只由命令写，步骤进度来自勾选项与带尾注的提交。
//! 契约见 `.berth/tasks/10-04-task-group/prd.md`。

pub mod group;
pub(crate) mod fsutil;
mod file;
mod git;
mod hub;
mod ops;
pub mod session_links;
mod state;
mod view;

#[cfg(test)]
mod tests;

use std::fmt;

pub(crate) use hub::checkout_root;
pub(crate) use hub::hub_elsewhere;
pub use hub::{main_project, resolve, Scope, HUB_MARKER};
pub use ops::{
    task_dir, parse_task_run, run_result_path, run_stamp, run_stamp_now, write_run_result, INCOMPLETE_MARK,
    RUNS_DIR, TASK_RUN_ENV,
    archive, assign, begin, bind, complete, create, done, finish, finish_group, list, migrate,
    open_tasks_in_group, promote, reopen, save, show, step, unbind, views, CreateOptions,
    FinishOptions,
};
pub use file::FileStep;
pub use view::TaskView;

/// 给 Agent 看的工作流错误：`code` 是稳定的机器可读值，沿用旧脚本的取值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskError {
    pub code: &'static str,
    pub message: String,
}

impl TaskError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for TaskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TaskError {}

impl From<std::io::Error> for TaskError {
    fn from(error: std::io::Error) -> Self {
        Self::new("io_error", error.to_string())
    }
}

pub type TaskResult<T> = Result<T, TaskError>;
