//! `tool_assets(request)` — 查看 Tool Asset（列表含停用插件 + 详情 + 包内
//! 文档）、启用 / 停用插件、从官方插件仓库安装，与把插件打包成 zip 分发。
//!
//! 复用 `berth-tool-core` 的发现、开放投影与启用状态；本层只补充适合前端
//! 展示的摘要与包内 `usage.md`。本命令不启动进程。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_error::AppCommandError;

const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ToolAssetsRequest {
    List,
    Load {
        id: String,
    },
    /// 启用 / 停用插件（`$BERTH_HOME/plugins.json`），返回刷新后的列表。
    SetEnabled {
        id: String,
        enabled: bool,
    },
    /// 把插件包打成 `<id>/…` 结构的 zip：解压进插件目录即可使用。
    Pack {
        id: String,
        path: String,
    },
    /// 官方插件仓库里可安装的插件（会联网克隆）。
    Catalog,
    /// 从 git 来源（`<仓库>#<子目录>`）安装插件，返回刷新后的列表。
    Install {
        source: String,
    },
    /// 删除插件目录与它的状态条目，返回刷新后的列表。
    Remove {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ToolAssetsResponse {
    List {
        tools: Vec<ToolAssetSummary>,
        directory: String,
    },
    Detail {
        detail: ToolAssetDetail,
    },
    Packed {
        path: String,
    },
    Catalog {
        repository: String,
        plugins: Vec<ToolCatalogEntry>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCatalogEntry {
    /// 传给 `install` 的来源。
    pub source: String,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    /// 包内 `icon.svg|icon.png` 的 data URL。
    pub icon: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAssetSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `tool.json` 的 `version`（旧包为 `revision`）。
    pub version: Option<String>,
    pub protocol: Option<String>,
    /// 接入了宿主哪些位置（与 `berth tools check` 同源）。
    pub contributes: Vec<String>,
    pub enabled: bool,
    pub diagnostics: Vec<ToolAssetDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAssetDetail {
    pub summary: ToolAssetSummary,
    pub directory: String,
    pub raw: Value,
    pub usage: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAssetDiagnostic {
    pub location: String,
    pub message: String,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tool_assets(
    request: ToolAssetsRequest,
) -> Result<ToolAssetsResponse, AppCommandError> {
    match request {
        ToolAssetsRequest::List => list(),
        ToolAssetsRequest::Load { id } => load(&id),
        ToolAssetsRequest::SetEnabled { id, enabled } => {
            berth_tool_core::plugins::set_enabled(&id, enabled)
                .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
            if !enabled {
                crate::preview_watch::stop_watches_without_provider();
            }
            list()
        }
        ToolAssetsRequest::Pack { id, path } => {
            let package = crate::tool::asset_repository::tool_package_dir(&id)?;
            pack(&package, &id, Path::new(&path))?;
            Ok(ToolAssetsResponse::Packed { path })
        }
        ToolAssetsRequest::Catalog => blocking(catalog).await,
        ToolAssetsRequest::Install { source } => {
            blocking(move || {
                berth_tool_core::plugins::install(&source)
                    .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
                list()
            })
            .await
        }
        ToolAssetsRequest::Remove { id } => {
            berth_tool_core::plugins::remove(&id)
                .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
            crate::preview_watch::stop_watches_without_provider();
            list()
        }
    }
}

/// git 克隆是阻塞的网络操作，不占 async 运行时线程。
async fn blocking(
    operation: impl FnOnce() -> Result<ToolAssetsResponse, AppCommandError> + Send + 'static,
) -> Result<ToolAssetsResponse, AppCommandError> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?
}

fn catalog() -> Result<ToolAssetsResponse, AppCommandError> {
    let repo = berth_tool_core::plugins::OFFICIAL_REPO;
    let installed = crate::tool::asset_repository::list_installed_tool_asset_ids();
    let plugins = berth_tool_core::plugins::catalog(repo, |name, dir, raw| {
        let id = raw.get("id").and_then(Value::as_str).unwrap_or(name).to_string();
        ToolCatalogEntry {
            source: format!("{repo}#{name}"),
            name: localized_text(raw.pointer("/identity/name")).unwrap_or_else(|| id.clone()),
            description: localized_text(raw.pointer("/identity/description")),
            version: version_text(&raw),
            icon: crate::commands::launchbar::icon_data_url(dir).ok().flatten(),
            installed: installed.contains(&id),
            id,
        }
    })
    .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
    Ok(ToolAssetsResponse::Catalog {
        repository: repo.to_string(),
        plugins,
    })
}

/// 打包插件目录（跳过 `.git` 与符号链接，保留文件权限），条目都放在 `<id>/` 下。
fn pack(package: &Path, id: &str, dest: &Path) -> Result<(), AppCommandError> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    if !package.join("tool.json").is_file() {
        return Err(AppCommandError::not_found(format!(
            "no tool.json registered for '{id}'"
        )));
    }
    if dest.starts_with(package) {
        return Err(AppCommandError::invalid_input(
            "save the archive outside the plugin directory",
        ));
    }
    let zip_error = |error: zip::result::ZipError| AppCommandError::io_error(error.to_string());
    let mut writer = zip::ZipWriter::new(std::fs::File::create(dest).map_err(AppCommandError::io)?);
    let entries = walkdir::WalkDir::new(package)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".git");
    for entry in entries {
        let entry = entry.map_err(|error| AppCommandError::io_error(error.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(package).unwrap_or(entry.path());
        let name = format!("{id}/{}", relative.to_string_lossy().replace('\\', "/"));
        let mut options = SimpleFileOptions::default();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry
                .metadata()
                .map_err(|error| AppCommandError::io_error(error.to_string()))?;
            options = options.unix_permissions(mode.permissions().mode());
        }
        writer.start_file(name, options).map_err(zip_error)?;
        writer
            .write_all(&std::fs::read(entry.path()).map_err(AppCommandError::io)?)
            .map_err(AppCommandError::io)?;
    }
    writer.finish().map_err(zip_error)?;
    Ok(())
}

fn list() -> Result<ToolAssetsResponse, AppCommandError> {
    // 新装用户还没有插件目录：先建好，「打开目录」才打得开。
    let directory = crate::tool::path::cli_tools_directory();
    std::fs::create_dir_all(&directory).map_err(AppCommandError::io)?;
    let tools = crate::tool::asset_repository::list_installed_tool_asset_ids()
        .into_iter()
        .map(
            |id| match crate::tool::asset_repository::load_tool_asset(&id) {
                Ok(Some(asset)) => summary(&id, &asset),
                Ok(None) => broken_summary(id, "tool.json disappeared while loading".into()),
                Err(error) => broken_summary(id, error.to_string()),
            },
        )
        .collect();
    Ok(ToolAssetsResponse::List {
        tools,
        directory: directory.to_string_lossy().into_owned(),
    })
}

fn load(id: &str) -> Result<ToolAssetsResponse, AppCommandError> {
    let asset = crate::tool::asset_repository::load_tool_asset(id)?
        .ok_or_else(|| AppCommandError::not_found(format!("no tool.json registered for '{id}'")))?;
    let package = crate::tool::asset_repository::tool_package_dir(id)?;
    let mut summary = summary(id, &asset);
    let usage = read_document_or_diagnostic(&package, "usage.md", &mut summary);
    let detail = ToolAssetDetail {
        summary,
        directory: package.to_string_lossy().into_owned(),
        raw: asset.raw().clone(),
        usage,
    };
    Ok(ToolAssetsResponse::Detail { detail })
}

fn summary(id: &str, asset: &crate::tool::asset::ToolAsset) -> ToolAssetSummary {
    let raw = asset.raw();
    let dir = crate::tool::asset_repository::tool_package_dir(id).ok();
    let diagnostics = asset
        .diagnostics()
        .into_iter()
        .chain(
            dir.iter()
                .flat_map(|dir| berth_tool_core::package::check_package(dir, raw)),
        )
        .map(|diagnostic| ToolAssetDiagnostic {
            location: diagnostic.location,
            message: diagnostic.message,
        })
        .collect();
    ToolAssetSummary {
        id: id.to_string(),
        name: localized_text(raw.pointer("/identity/name")).unwrap_or_else(|| id.to_string()),
        description: localized_text(raw.pointer("/identity/description")),
        version: version_text(raw),
        protocol: asset.protocol().map(str::to_string),
        contributes: dir
            .map(|dir| berth_tool_core::package::contributions(&dir, raw))
            .unwrap_or_default(),
        enabled: berth_tool_core::plugins::is_enabled(id),
        diagnostics,
    }
}

fn version_text(raw: &Value) -> Option<String> {
    ["/version", "/revision"]
        .iter()
        .find_map(|pointer| raw.pointer(pointer))
        .map(|value| {
            value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_string)
        })
}

fn broken_summary(id: String, message: String) -> ToolAssetSummary {
    let enabled = berth_tool_core::plugins::is_enabled(&id);
    ToolAssetSummary {
        name: id.clone(),
        id,
        description: None,
        version: None,
        protocol: None,
        contributes: Vec::new(),
        enabled,
        diagnostics: vec![ToolAssetDiagnostic {
            location: "tool.json".into(),
            message,
        }],
    }
}

fn localized_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Object(map) => ["zh-CN", "en"]
            .iter()
            .find_map(|language| map.get(*language).and_then(Value::as_str))
            .or_else(|| map.values().find_map(Value::as_str))
            .map(str::to_string),
        _ => None,
    }
}

fn read_document_or_diagnostic(
    package: &Path,
    name: &str,
    summary: &mut ToolAssetSummary,
) -> Option<String> {
    match read_package_document(package, name) {
        Ok(content) => content,
        Err(error) => {
            summary.diagnostics.push(ToolAssetDiagnostic {
                location: name.to_string(),
                message: error.to_string(),
            });
            None
        }
    }
}

fn read_package_document(package: &Path, name: &str) -> Result<Option<String>, AppCommandError> {
    let candidate = package.join(name);
    let metadata = match std::fs::metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppCommandError::io(error)),
    };
    if !metadata.is_file() || metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "tool document {name} must be a regular file no larger than {MAX_DOCUMENT_BYTES} bytes"
        )));
    }
    let root = package.canonicalize().map_err(AppCommandError::io)?;
    let resolved = candidate.canonicalize().map_err(AppCommandError::io)?;
    if !resolved.starts_with(root) {
        return Err(AppCommandError::invalid_input(format!(
            "tool document {name} resolves outside its package"
        )));
    }
    std::fs::read_to_string(resolved)
        .map(Some)
        .map_err(AppCommandError::io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::path::TEST_ENV_LOCK;

    #[test]
    fn lists_and_loads_usage_without_executing_the_tool() {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let home = std::env::temp_dir().join(format!("tool-assets-ui-{}", std::process::id()));
        let package = home.join("tools/demo");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("tool.json"),
            r#"{"protocol":"berth.tool/1","id":"demo","identity":{"name":"Demo","description":"Example"},"actions":{"inspect":{"inputSchema":{"type":"object","properties":{}},"bindings":[]}}}"#,
        )
        .unwrap();
        std::fs::write(package.join("usage.md"), "# Usage\nRun it").unwrap();
        std::env::set_var("BERTH_HOME", &home);

        let ToolAssetsResponse::List { tools, .. } = list().unwrap() else {
            panic!("expected list");
        };
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "Demo");
        assert!(tools[0].enabled);

        // 停用后仍在管理列表里，标记为停用；运行入口的列表不再包含它。
        berth_tool_core::plugins::set_enabled("demo", false).unwrap();
        let ToolAssetsResponse::List { tools, .. } = list().unwrap() else {
            panic!("expected list");
        };
        assert!(!tools[0].enabled);
        assert!(crate::tool::asset_repository::list_tool_asset_ids().is_empty());
        berth_tool_core::plugins::set_enabled("demo", true).unwrap();

        let ToolAssetsResponse::Detail { detail } = load("demo").unwrap() else {
            panic!("expected detail");
        };
        assert!(detail.usage.unwrap().contains("Run it"));
        assert_eq!(detail.raw["id"], "demo");

        std::fs::write(package.join("usage.md"), [0xff]).unwrap();
        let ToolAssetsResponse::Detail { detail } = load("demo").unwrap() else {
            panic!("expected detail with document diagnostic");
        };
        assert!(detail.usage.is_none());
        assert!(detail
            .summary
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.location == "usage.md"));

        let archive = home.join("demo.zip");
        pack(&package, "demo", &archive).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        let mut names: Vec<_> = zip.file_names().map(str::to_string).collect();
        names.sort();
        assert_eq!(names, ["demo/tool.json", "demo/usage.md"]);
        assert!(zip.by_name("demo/tool.json").is_ok());
        assert!(pack(&package, "demo", &package.join("x.zip")).is_err());

        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(home);
    }
}
