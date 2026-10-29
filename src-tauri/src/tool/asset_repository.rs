//! Tool Asset 文件读写——实现已上移至 `berth-tool-core::repository`
//! （09-10 design D3）。本文件保持 `crate::tool::asset_repository` 的公
//! 开面与 `AppCommandError` 签名不变（commands/terminal、launchbar、
//! profile 消费）。

use std::path::PathBuf;

use crate::app_error::AppCommandError;
use crate::tool::asset::ToolAsset;

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

pub fn tool_asset_file_path(id: &str) -> Result<PathBuf, AppCommandError> {
    berth_tool_core::repository::tool_asset_file_path(id).map_err(map_error)
}

/// 资产包根目录 `tools/<id>/`（`base: package` 资源的解析根）。
pub fn tool_package_dir(id: &str) -> Result<PathBuf, AppCommandError> {
    berth_tool_core::repository::tool_package_dir(id).map_err(map_error)
}

pub fn load_tool_asset(id: &str) -> Result<Option<ToolAsset>, AppCommandError> {
    berth_tool_core::repository::load_tool_asset(id).map_err(map_error)
}

pub fn list_tool_asset_ids() -> Vec<String> {
    berth_tool_core::repository::list_tool_asset_ids()
}

/// 含停用插件；只给管理视图（设置页）。
pub fn list_installed_tool_asset_ids() -> Vec<String> {
    berth_tool_core::repository::list_installed_tool_asset_ids()
}
