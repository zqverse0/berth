//! runtime bridge `knowledge.*` 的薄适配；扫描、搜索、过期、改状态与想法在 `berth_project_core::knowledge`。

#[cfg(feature = "tauri-runtime")]
pub(crate) mod classify;
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
        "knowledge.ideas" => encode(service::ideas::list(project_root)),
        "knowledge.addIdea" => {
            let request: IdeaText = decode(params)?;
            encode(service::ideas::add(project_root, &request.text))
        }
        "knowledge.setIdeaStatus" => {
            let request: IdeaStatus = decode(params)?;
            encode(service::ideas::set_status(
                project_root,
                &request.id,
                &request.status,
            ))
        }
        // 「记忆 → Jev 动态」：会话分类直接写入的条目，撤销 / 改类。
        "knowledge.jevLog" => encode(service::journal::recent(project_root, JEV_LOG_LIMIT)),
        "knowledge.jevUndo" => {
            let request: JevEntry = decode(params)?;
            encode(service::journal::undo(project_root, &request.id))
        }
        "knowledge.jevMove" => {
            let request: JevEntry = decode(params)?;
            let config = service::classifier::load_config(&berth_tool_core::paths::berth_home_dir())
                .map_err(|error| BerthTaskError::invalid(error.to_string()))?;
            encode(service::journal::recategorize(
                project_root,
                &config,
                &request.id,
                request.category.as_deref().unwrap_or_default(),
            ))
        }
        _ => Err(BerthTaskError::invalid("Unsupported knowledge operation")),
    }
}

#[derive(serde::Deserialize)]
struct IdeaText {
    text: String,
}

#[derive(serde::Deserialize)]
struct IdeaStatus {
    id: String,
    status: String,
}

/// 「Jev 动态」一次列出的条数。
const JEV_LOG_LIMIT: usize = 200;

#[derive(serde::Deserialize)]
struct JevEntry {
    id: String,
    #[serde(default)]
    category: Option<String>,
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
