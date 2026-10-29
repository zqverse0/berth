//! Request payloads for the personal terminal command adapter.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePersonalTerminalRequest {
    pub terminal_id: Option<String>,
    pub cwd: String,
    pub shell: Option<String>,
    pub initial_command: Option<String>,
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 文件定义 Agent 的稳定 id；存在时启动前重新读取契约文件。
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_mode_id: Option<String>,
    #[serde(default)]
    pub agent_extra_args: Vec<String>,
    /// Typed values for v2 contract runtime capabilities. The backend
    /// validates and compiles these values against the current contract.
    #[serde(default)]
    pub agent_capability_values: BTreeMap<String, Value>,
    /// 启动栏选择值。桌面启动原样交给 `launch.js --berth-launch-inputs`，
    /// 宿主不拼目标 CLI。
    #[serde(default)]
    pub agent_launch_inputs: Option<BTreeMap<String, Value>>,
    /// 模型服务商启动档案参数（`--berth-provider <文件>`）。
    /// 与用户 typed inputs 独立：有 launch 输入时仍要接到计划后面，
    /// 不能混进会被丢掉的 `agent_extra_args`。仅宿主内部填写。
    #[serde(default, skip_deserializing)]
    pub provider_injection_args: Vec<String>,
    pub folder_id: Option<i32>,
    pub rows: u16,
    pub cols: u16,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdRequest {
    pub terminal_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClientRequest {
    pub terminal_id: String,
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeAttachedTerminalRequest {
    pub terminal_id: String,
    pub client_id: String,
    pub input_sequence: u64,
    pub cols: u16,
    pub rows: u16,
}
