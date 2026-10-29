//! Agent 身份枚举。
//!
//! 定义在共享 crate `berth-project-core`：`folder.default_agent_type` 与
//! `conversation.agent_type` 是它持久化的值域，schema owner 必须是唯一定义处。
//! 此处只做再导出，桌面宿主的既有引用路径不变。

pub use berth_project_core::agent::{parse_known_agent_type, AgentType};
