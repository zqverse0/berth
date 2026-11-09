//! runtime bridge `knowledge.*` 的薄适配；扫描、搜索、过期、改状态在 `berth_project_core::knowledge`。

pub(crate) mod digest;

use std::path::Path;

use berth_project_core::knowledge as service;
use serde_json::Value;

use crate::berth_tasks::BerthTaskError;

pub fn dispatch(folder: &Path, method: &str, params: Value) -> Result<Value, BerthTaskError> {
    // worktree 项目也读写主项目那一份 vault。
    let project_root = &service::vault_project(folder);
    match method {
        "knowledge.snapshot" => encode(service::snapshot(project_root)),
        "knowledge.search" => encode(service::search(project_root, decode(params)?)),
        "knowledge.stale" => encode(service::stale(project_root)),
        "knowledge.setStatus" => encode(service::set_status(project_root, decode(params)?)),
        _ => Err(BerthTaskError::invalid("Unsupported knowledge operation")),
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, BerthTaskError> {
    serde_json::from_value(value)
        .map_err(|error| BerthTaskError::invalid(format!("Invalid knowledge request: {error}")))
}

fn encode<T: serde::Serialize>(result: std::io::Result<T>) -> Result<Value, BerthTaskError> {
    let value = result.map_err(|error| match error.kind() {
        std::io::ErrorKind::InvalidInput => BerthTaskError::invalid(error.to_string()),
        _ => BerthTaskError::io(error),
    })?;
    serde_json::to_value(value).map_err(|error| BerthTaskError::internal(error.to_string()))
}
