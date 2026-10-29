//! 核心错误类型：桌面侧包装成 `AppCommandError`，CLI 侧直接映射退出码。

use thiserror::Error;

/// 资产仓储/目录规则错误。kind 供消费方映射（桌面 InvalidInput →
/// `AppCommandError::invalid_input`，Io → `AppCommandError::io`）；
/// Display 即最终用户可见消息（与迁移前的 `AppCommandError` 文案一致）。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ToolCoreError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    Io(String),
}

impl ToolCoreError {
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput(message.into())
    }
}

impl From<std::io::Error> for ToolCoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}
