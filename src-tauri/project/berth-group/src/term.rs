//! 群组用到的外部世界：终端（观测 / 写入 / 新建 pane、按目录找项目）与 Agent 会话文件（hook 没给回答时补读）。
//! 都放在 trait 后面：CLI 连 termd 实现 [`Terminals`]，桌面宿主用自己的终端管理；测试用假实现。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use berth_tool_core::session_files::{readable_spec, turn_reply, turn_tool_targets};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fail {
    /// pane 已不在（关闭、换代）。
    Stale,
    /// termd 连不上、超时、拒绝等；不代表 pane 已没了。
    Unavailable(String),
}

/// spawn 新建 Agent pane 的参数。
pub struct CreateAgent<'a> {
    pub project_id: i32,
    pub cwd: &'a Path,
    pub agent: &'a str,
    pub inputs: BTreeMap<String, Value>,
    pub provider_id: Option<i32>,
    pub model_id: Option<&'a str>,
}

pub trait Terminals {
    fn probe(&self, target_ref: &str) -> Result<PaneProbe, Fail>;
    /// pane 属于另一个 Berth 实例：本实例看不到它，不送达也不判离群。
    fn foreign(&self, _target_ref: &str) -> bool {
        false
    }
    fn send(&self, target_ref: &str, input: Input, paste: bool) -> Result<(), Fail>;
    /// 这些目录（主项目、任务 worktree）对应项目下的全部 live pane。
    fn panes_under(&self, roots: &[PathBuf]) -> Result<Vec<(String, PaneProbe)>, Fail>;
    /// 目录对应的项目 id；没注册就注册（必要时拉起 GUI）。
    fn ensure_project(&self, path: &Path) -> Result<i32, String>;
    /// 新建 Agent pane，返回 target_ref。
    fn create_agent(&self, request: CreateAgent<'_>) -> Result<String, String>;
}

pub trait Sessions {
    /// 这一轮已结束时的最终回答；还在调工具或等结果时为 `None`。
    fn turn_reply(&self, agent: &str, path: &Path) -> Option<String>;
    /// 这一轮各工具调用的目标（路径、命令等）：不在 git 仓库里时据此找这一轮写过的文件。
    fn turn_targets(&self, _agent: &str, _path: &Path) -> Vec<String> {
        Vec::new()
    }
}

/// pane 汇总状态：`attention` / `working` / `idle`，进程退出为 `stale`。旧 daemon 没有状态变量时按空闲处理（至少能收到消息）。
pub fn state_name(probe: &PaneProbe) -> &'static str {
    match probe.agent_state {
        Some("exited") => "stale",
        Some("attention") => "attention",
        Some("working") => "working",
        _ => "idle",
    }
}

#[cfg(test)]
fn agent_ids() -> &'static HashSet<String> {
    // 测试不依赖本机装了哪些插件。
    static IDS: OnceLock<HashSet<String>> = OnceLock::new();
    IDS.get_or_init(|| HashSet::from(["claude".to_owned()]))
}

#[cfg(not(test))]
fn agent_ids() -> &'static HashSet<String> {
    static IDS: OnceLock<HashSet<String>> = OnceLock::new();
    IDS.get_or_init(|| {
        berth_tool_core::repository::list_installed_tool_asset_ids()
            .into_iter()
            .filter(|id| {
                berth_tool_core::repository::load_tool_asset(id)
                    .ok()
                    .flatten()
                    .is_some_and(|asset| asset.agent_extension().is_some())
            })
            .collect()
    })
}

/// pane 里的 Agent：经 launch.js 启动的工具 id，或前台进程名等于已安装 Agent 的 id（与 GUI 同一规则）。
pub fn agent_of(probe: &PaneProbe) -> Option<String> {
    probe.launch_agent.clone().or_else(|| {
        probe
            .foreground_command
            .clone()
            .filter(|command| agent_ids().contains(command))
    })
}

/// 群组用的 pane 观测：Agent 状态、最近通知、识别出的 Agent 与前台目录。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaneProbe {
    /// 终端编号（`berth terminal ls` 里 `项目:编号` 的编号）。
    pub pane_id: u32,
    /// 启动栏选的专家；群成员名就是它，没选专家的 Agent 不入群。
    pub expert: Option<String>,
    /// 启动栏明确选择的 Agent 会话，不按目录最新文件猜测。
    pub session_id: Option<String>,
    /// session 的持久项目身份对应的目录；不使用前台 cwd 推断归属。
    pub session_project_path: Option<String>,
    /// `idle` / `working` / `attention` / `exited`；旧 daemon 不认识时为 `None`。
    pub agent_state: Option<&'static str>,
    /// 一轮还没结束（OSC 9;4 进度非 0，Berth 的 hook 在一轮开始 / 结束时写入）；
    /// 与 `attention` 无关：一轮中等授权是忙，一轮结束后的提醒不是。
    pub busy: bool,
    pub notification: Option<String>,
    /// 经 launch.js 启动（`launch_tool_id`）的 Agent；手动启动的由调用方按前台进程名补认。
    pub launch_agent: Option<String>,
    pub foreground_command: Option<String>,
    /// 前台进程当前目录，没有时退回 pane 初始目录。
    pub cwd: Option<String>,
}

/// 写进 pane 的输入：文本或按键名。
#[derive(Debug, PartialEq, Eq)]
pub enum Input {
    Text(String),
    Key(String),
}

/// 真实会话文件（Tool Asset 的 `sessions.json`），与 `berth session last` 同一读取器。
pub struct SessionFiles;

impl Sessions for SessionFiles {
    fn turn_reply(&self, agent: &str, path: &Path) -> Option<String> {
        let spec = readable_spec(agent).ok()?;
        turn_reply(&spec, path)
    }

    fn turn_targets(&self, agent: &str, path: &Path) -> Vec<String> {
        readable_spec(agent)
            .map(|spec| turn_tool_targets(&spec, path))
            .unwrap_or_default()
    }
}
