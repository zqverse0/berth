//! 工具资产目录规则——实现已上移至 `berth-tool-core::paths`（09-10
//! design D3：路径根由一处公共实现提供）。本文件保持
//! `crate::tool::path` 的公开面与 `AppCommandError` 签名不变。

use std::path::PathBuf;

use crate::app_error::AppCommandError;

/// Test isolation lock（core 内同一 static，两宿主测试互斥）。
pub use berth_tool_core::paths::TEST_ENV_LOCK;

pub use berth_tool_core::paths::{
    file_name_id, index_file_path, is_regular_manifest_file, is_valid_manifest_id, INDEX_FILE_NAME,
};

/// Root directory for `berth.tool/1` assets.
pub fn cli_tools_directory() -> PathBuf {
    crate::platform::paths::cli_tools_root()
}

fn map_error(error: berth_tool_core::error::ToolCoreError) -> AppCommandError {
    match error {
        berth_tool_core::error::ToolCoreError::InvalidInput(message) => {
            AppCommandError::invalid_input(message)
        }
        berth_tool_core::error::ToolCoreError::Io(message) => {
            AppCommandError::io(std::io::Error::other(message))
        }
    }
}

pub fn manifest_file_path(id: &str) -> Result<PathBuf, AppCommandError> {
    berth_tool_core::paths::manifest_file_path(id).map_err(map_error)
}

// 派生索引与 manifest 文件名规则保留原导出（根级旧 manifest 链的读方在
// commands/launchbar 与 model_provider；目录真相仍在 core）。

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn wrapper_keeps_invalid_id_error() {
        let error = manifest_file_path("Bad").unwrap_err();
        assert!(error.to_string().contains("max 128 chars"));
        assert!(is_valid_manifest_id("ok.id-1_x"));
        assert_eq!(
            file_name_id(Path::new("index.json")),
            None,
            "index is not a manifest"
        );
    }
}
