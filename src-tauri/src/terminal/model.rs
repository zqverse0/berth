//! Public Berth terminal adapter models.

use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::terminal::error::{TerminalError, TerminalErrorCode};
use crate::terminal::protocol::TerminalStatus;

pub(super) const DEFAULT_MAX_RUNNING: usize = 64;
pub(super) const DEFAULT_MAX_RECORDS: usize = 256;
pub(super) const DEFAULT_SUBSCRIBER_CAPACITY: usize = 4096;

/// Request used by the shared terminal command layer.
pub struct CreateTerminalRequest {
    /// Optional caller-selected terminal identity.
    pub terminal_id: Option<String>,
    /// Directory in which the first pane starts.
    pub cwd: String,
    /// Shell executable for shell-backed launches.
    pub shell: Option<String>,
    /// Optional command text executed by the shell.
    pub initial_command: Option<String>,
    /// Optional directly executed executable.
    pub executable: Option<String>,
    /// Arguments for [`Self::executable`].
    pub args: Vec<String>,
    /// 当前数据实例的项目行号；创建时经共享 catalog 解析运行 UUID。
    pub folder_id: Option<i32>,
    /// Initial terminal rows.
    pub rows: u16,
    /// Initial terminal columns.
    pub cols: u16,
    /// Berth window/client owner label used for detach-only cleanup.
    pub client_id: Option<String>,
    /// Environment overrides for the spawned process.
    pub extra_env: Option<HashMap<String, String>>,
    /// Temporary files or directories owned by the launch request.
    pub temp_files: Vec<PathBuf>,
    /// Agent 启动：异常退出时保留死 pane，退出码与最后输出留给用户看。
    pub keep_on_failed_exit: bool,
}

/// GUI 对共享项目归属分类的线上投影；不作为运行绑定或持久化账本。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOwnership {
    /// session key 同时证明当前数据实例与已登记项目。
    Project,
    /// 存量 session 缺少实例归属证明，只允许明确目标的兼容操作。
    #[default]
    LegacyUnresolved,
    /// 无项目归属的独立终端。
    Independent,
}

/// Description of one live Berth terminal window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDescriptor {
    /// Berth terminal identity, normally the Berth terminal window name.
    pub terminal_id: String,
    /// Runtime endpoint identity shared by all clients of this daemon.
    pub backend_instance_id: String,
    /// 已证明归属的当前项目；数字 legacy session 不填此字段。
    pub folder_id: Option<i32>,
    /// 共享 owner 规则的分类；旧 descriptor 缺字段时不推定独立或项目归属。
    #[serde(default)]
    pub ownership: TerminalOwnership,
    /// Window title.
    pub title: String,
    /// Initial working directory.
    pub initial_cwd: String,
    /// Shell used by the pane.
    pub shell: String,
    /// Current process status.
    pub status: TerminalStatus,
    /// Current pane process id when Berth terminal reports one.
    pub process_id: Option<u32>,
    /// First observation time in this Berth process.
    pub created_at: DateTime<Utc>,
    /// Exit time when the pane process has ended.
    pub exited_at: Option<DateTime<Utc>>,
    /// Agent 工具 id：`tools/<id>/launch.js` 启动取自 pane 启动 argv；
    /// 否则前台进程名匹配 tool.json 的可执行文件名（手动在 shell 里启动的 Agent）。
    #[serde(default)]
    pub agent_id: Option<String>,
    /// termd 报告的 Agent 协议状态；旧 daemon 不报告时为 `None`。
    #[serde(default)]
    pub agent_signal: Option<TerminalAgentSignal>,
    /// 前台进程名（termd `pane_current_command`）；与 shell 不同即终端在跑命令。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
    /// launch.js 启动时启动栏选中的输入（专家、模型等），取自 pane 启动 argv；手动启动为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_inputs: Option<serde_json::Value>,
    /// pane 前台进程的当前目录；用于把终端归到所在 worktree。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 仅在 `terminal_get_session` 请求 `tailLines` 时填写的 pane 尾部纯文本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
    /// 该 pane 的 `TargetBindingRef` 编码，与 CLI `berth terminal create/list` 输出、
    /// pane 环境 `BERTH_TARGET_REF` 逐字节相同；协作页用它对应频道 joined 事件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
}

/// 按共享协议把运行绑定编码为 target ref；超长等编码失败时为 `None`。
pub(super) fn encode_target_ref(binding: &berth_term_sdk::berth::RuntimeBinding) -> Option<String> {
    berth_control_proto::TargetBindingRef {
        version: 1,
        daemon_instance: binding.daemon_instance.clone(),
        session: binding.session.as_str().to_owned(),
        pane_id: binding.pane_id.as_u32(),
        generation: binding.generation,
    }
    .encode()
    .ok()
}

/// pane 的 Agent 协议状态投影（termd 格式变量 `pane_agent_*` / `pane_pb_*`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentSignal {
    /// `attention` / `working` / `idle`。
    pub state: String,
    /// 最近一条通知文本。
    pub notification: Option<String>,
    /// 协议层状态最近一次变化的 Unix 秒。
    pub state_changed_at: Option<i64>,
    /// OSC 9;4 进度条状态名。
    pub progress_state: String,
    /// OSC 9;4 进度百分比。
    pub progress: u8,
}

/// Limits for the Berth-side live terminal index and attachment queues.
#[derive(Debug, Clone, Copy)]
pub struct TerminalLimits {
    /// Maximum number of running terminals visible to Berth.
    pub max_running: usize,
    /// Maximum number of locally indexed records.
    pub max_records: usize,
    /// Subscriber queue size at the Berth adapter boundary.
    pub subscriber_capacity: usize,
}

impl Default for TerminalLimits {
    fn default() -> Self {
        Self {
            max_running: DEFAULT_MAX_RUNNING,
            max_records: DEFAULT_MAX_RECORDS,
            subscriber_capacity: DEFAULT_SUBSCRIBER_CAPACITY,
        }
    }
}

/// Errors that can cross the shared Berth command boundary.
#[derive(Debug, thiserror::Error)]
pub enum TerminalOperationError {
    /// A stable terminal protocol error.
    #[error("terminal protocol error: {0:?}")]
    Protocol(TerminalErrorCode),
    /// An adapter/runtime error.
    #[error(transparent)]
    Runtime(#[from] TerminalError),
}

impl From<TerminalErrorCode> for TerminalOperationError {
    fn from(value: TerminalErrorCode) -> Self {
        Self::Protocol(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_ref_round_trips_through_the_cli_decoder() {
        use berth_term_sdk::berth::{PaneId, RuntimeBinding, SessionName};
        let binding = RuntimeBinding::new(
            Some("epoch-a".into()),
            SessionName::new("berth-project-x").expect("session"),
            PaneId::new(7),
            3,
        );
        let encoded = encode_target_ref(&binding).expect("encode");
        let decoded = berth_control_proto::TargetBindingRef::decode(&encoded).expect("decode");
        assert_eq!(decoded.daemon_instance.as_deref(), Some("epoch-a"));
        assert_eq!(decoded.session, "berth-project-x");
        assert_eq!((decoded.pane_id, decoded.generation), (7, 3));
        // 与 CLI / termd 环境同一编码：重编码逐字节一致。
        assert_eq!(decoded.encode().expect("re-encode"), encoded);
        let json = serde_json::to_value(TerminalDescriptor {
            terminal_id: "t".into(),
            backend_instance_id: "b".into(),
            folder_id: None,
            ownership: TerminalOwnership::Project,
            title: String::new(),
            initial_cwd: "/".into(),
            shell: "/bin/sh".into(),
            status: TerminalStatus::Running,
            process_id: None,
            created_at: Utc::now(),
            exited_at: None,
            agent_id: None,
            agent_signal: None,
            foreground_command: None,
            launch_inputs: None,
            cwd: None,
            tail: None,
            target_ref: Some(encoded.clone()),
        })
        .expect("descriptor json");
        assert_eq!(json["targetRef"], encoded);
    }

    #[test]
    fn descriptor_without_ownership_is_legacy_unresolved() {
        let old = serde_json::json!({
            "terminalId": "old-terminal",
            "backendInstanceId": "synthetic-endpoint",
            "folderId": 7,
            "title": "legacy",
            "initialCwd": "/synthetic/project",
            "shell": "/bin/sh",
            "status": "running",
            "processId": 42,
            "createdAt": "2026-09-26T00:00:00Z",
            "exitedAt": null
        });
        let descriptor: TerminalDescriptor = serde_json::from_value(old).expect("old descriptor");
        assert_eq!(descriptor.ownership, TerminalOwnership::LegacyUnresolved);
        let encoded = serde_json::to_value(descriptor).expect("encode descriptor");
        assert_eq!(encoded["ownership"], "legacy_unresolved");
        assert_eq!(encoded["folderId"], 7);
    }

    #[test]
    fn descriptor_ownership_uses_shared_classification_vocabulary() {
        for (ownership, value) in [
            (TerminalOwnership::Project, "project"),
            (TerminalOwnership::LegacyUnresolved, "legacy_unresolved"),
            (TerminalOwnership::Independent, "independent"),
        ] {
            let encoded = serde_json::to_value(ownership).expect("encode ownership");
            assert_eq!(encoded, value);
            assert_eq!(
                serde_json::from_value::<TerminalOwnership>(encoded).expect("decode ownership"),
                ownership
            );
        }
        assert!(serde_json::from_str::<TerminalOwnership>("\"unknown\"").is_err());
    }
}
