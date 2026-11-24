//! Runtime bridge command: routes method strings to in-process handlers.
//!
//! Methods:
//! - `task.*` / `group.*` — project tasks and groups
//! - `knowledge.*` — knowledge vault
//! - `device.*` — 可 SSH 连接的其他设备（`src/devices.rs`）
//! - `expert.*` — 设置 →「专家」：`catalog` / `save` / `create` / `delete` / `asset`（`berth_tool_core::experts`）；`options`（id 与名字）
//! - `system.*` — 本机与 Berth 自身的资源占用（`src/system_resources.rs`）

use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(feature = "tauri-runtime")]
use std::time::Instant;

use crate::app_error::AppCommandError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBridgeOperationArgs {
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub folder_id: Option<i32>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Tagged Runtime bridge operation.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn runtime_bridge_operation<#[cfg(feature = "tauri-runtime")] R: tauri::Runtime>(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle<R>,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    args: RuntimeBridgeOperationArgs,
) -> Result<Value, AppCommandError> {
    let method = args.method.trim().to_string();
    if method.is_empty() {
        return Err(AppCommandError::invalid_input("method is required"));
    }

    #[cfg(feature = "tauri-runtime")]
    {
        let params = args.params.unwrap_or_else(|| json!({}));
        // 方法表只在 `collaboration::call` 一处（未知方法由它报错）。
        if ["task.", "group."]
            .iter()
            .any(|prefix| method.starts_with(prefix))
        {
            let folder_id = args
                .folder_id
                .ok_or_else(|| AppCommandError::invalid_input("folderId is required"))?;
            let folder = crate::commands::folders::get_folder_core(&db, folder_id)
                .await
                .map_err(AppCommandError::from)?;
            let project_root = std::path::PathBuf::from(folder.path);
            let started = Instant::now();
            let launch = {
                use tauri::Manager;
                app.try_state::<crate::terminal::manager::TerminalManager>()
                    .and_then(|manager| manager.cli_launch())
                    .map(
                        |(socket, env)| crate::berth_tasks::collaboration::CliLaunch {
                            socket,
                            env,
                        },
                    )
            };
            return match crate::berth_tasks::collaboration::call(
                &method,
                &project_root,
                &params,
                launch,
            )
            .await
            {
                Ok(result) => Ok(json!({
                    "ok": true,
                    "result": result,
                    "meta": {
                        "binaryPath": "",
                        "binarySource": "embedded-rust",
                        "durationMs": started.elapsed().as_millis(),
                        "method": method,
                    }
                })),
                Err(message) => Ok(json!({
                    "ok": false,
                    "error": {
                        "kind": "berth_tasks",
                        "message": message,
                        "method": method,
                    }
                })),
            };
        }

        // `device.*`、`expert.*`、`system.*` 是全局的（不属于某个项目），不走下面按项目的分发。
        if ["device.", "expert.", "system."]
            .iter()
            .any(|prefix| method.starts_with(prefix))
        {
            let started = Instant::now();
            let outcome = if method.starts_with("system.") {
                // 扫进程表、磁盘是同步 IO
                let method = method.clone();
                tokio::task::spawn_blocking(move || crate::system_resources::dispatch(&method, &params))
                    .await
                    .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
            } else if method.starts_with("expert.") {
                // 读写专家目录是同步 IO：不占 async 运行时的工作线程
                let method = method.clone();
                tokio::task::spawn_blocking(move || expert_operation(&method, &params))
                    .await
                    .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
            } else {
                use tauri::Manager;
                let mount_root = app
                    .path()
                    .app_data_dir()
                    .map(|dir| {
                        crate::platform::paths::resolve_effective_data_dir(&dir).join("remote")
                    })
                    .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
                let emitter = crate::event_bridge::EventEmitter::tauri(app.clone());
                crate::devices::dispatch(&db, &emitter, &mount_root, &method, &params).await
            };
            return Ok(match outcome {
                Ok(result) => json!({
                    "ok": true,
                    "result": result,
                    "meta": {
                        "binaryPath": "",
                        "binarySource": "embedded-rust",
                        "durationMs": started.elapsed().as_millis(),
                        "method": method,
                    }
                }),
                Err(message) => json!({
                    "ok": false,
                    "error": { "kind": "knowledge", "message": message, "method": method }
                }),
            });
        }

        // 项目成员：ls 与 `berth project . member ls` 同一实现。GUI 用 ls 读
        // 未加入的 worktree，检出（含失效 / 临时）走 `list_project_members`；join|move|main 只有 GUI 用。
        if let Some(action) = method.strip_prefix("project.member.") {
            let folder_id = args
                .folder_id
                .ok_or_else(|| AppCommandError::invalid_input("folderId is required"))?;
            let started = Instant::now();
            let outcome = project_member(&db, folder_id, action, &params).await;
            return Ok(match outcome {
                Ok(result) => json!({
                    "ok": true,
                    "result": result,
                    "meta": {
                        "binaryPath": "",
                        "binarySource": "embedded-rust",
                        "durationMs": started.elapsed().as_millis(),
                        "method": method,
                    }
                }),
                Err(message) => json!({
                    "ok": false,
                    "error": { "kind": "project", "message": message, "method": method }
                }),
            });
        }

        if method.starts_with("knowledge.") {
            let folder_id = args
                .folder_id
                .ok_or_else(|| AppCommandError::invalid_input("folderId is required"))?;
            let folder = crate::commands::folders::get_folder_core(&db, folder_id)
                .await
                .map_err(AppCommandError::from)?;
            let project_root = std::path::PathBuf::from(folder.path);
            let method_for_worker = method.clone();
            let started = Instant::now();
            let outcome = tokio::task::spawn_blocking(move || {
                crate::knowledge::dispatch(&project_root, &method_for_worker, params)
            })
            .await
            .map_err(|e| {
                AppCommandError::task_execution_failed(format!("berth_tasks join: {e}"))
            })?;
            return match outcome {
                Ok(result) => Ok(json!({
                    "ok": true,
                    "result": result,
                    "meta": {
                        "binaryPath": "",
                        "binarySource": "embedded-rust",
                        "durationMs": started.elapsed().as_millis(),
                        "method": method,
                    }
                })),
                Err(error) => Ok(error.response(&method)),
            };
        }
    }

    Ok(json!({
        "ok": false,
        "error": {
            "kind": "unknown",
            "message": format!("unknown runtime bridge method: {method}"),
            "method": method,
        }
    }))
}

/// `expert.*`：全局（不属于某个项目），读写 `$BERTH_HOME/experts`。
#[cfg(feature = "tauri-runtime")]
/// `project.member.*`，`folder_id` 是项目里的成员：
/// - `ls` 成员视图
/// - `join` 把 git 发现的检出（`path`）加入本项目
/// - `move` 把这个成员改挂到 `project`（项目 id）；`main` 设它为主成员
#[cfg(feature = "tauri-runtime")]
async fn project_member(
    db: &crate::db::AppDatabase,
    folder_id: i32,
    action: &str,
    params: &Value,
) -> Result<Value, String> {
    use berth_project_core::service::folder_service;
    let folder = crate::commands::folders::get_folder_core(db, folder_id)
        .await
        .map_err(|error| error.to_string())?;
    let project = match folder.project_id {
        Some(id) => folder_service::get_project(&db.conn, id)
            .await
            .map_err(|error| error.to_string())?,
        None => None,
    }
    .ok_or_else(|| format!("{} is not in a project", folder.path))?;
    let path = params["path"].as_str().unwrap_or_default();
    match action {
        "ls" => folder_service::project_view(&db.conn, &project)
            .await
            .map_err(|error| error.to_string())
            .and_then(|view| serde_json::to_value(view).map_err(|error| error.to_string())),
        "join" => folder_service::add_folder_to_project(&db.conn, path, project.id)
            .await
            .map(|entry| json!({ "folderId": entry.id }))
            .map_err(|error| error.to_string()),
        "move" => {
            let target = params["project"]
                .as_i64()
                .and_then(|id| i32::try_from(id).ok())
                .ok_or_else(|| "project is required".to_string())?;
            folder_service::get_project(&db.conn, target)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("project {target} not found"))?;
            folder_service::add_folder_to_project(&db.conn, &folder.path, target)
                .await
                .map(|entry| json!({ "folderId": entry.id }))
                .map_err(|error| error.to_string())
        }
        "main" => folder_service::set_main_member(&db.conn, folder.id)
            .await
            .map(|()| json!({}))
            .map_err(|error| error.to_string()),
        _ => Err(format!("unknown method project.member.{action}")),
    }
}

fn expert_operation(method: &str, params: &Value) -> Result<Value, String> {
    use berth_tool_core::experts;
    let home = crate::platform::paths::berth_home_dir();
    let id = params["id"].as_str().unwrap_or_default();
    match method {
        "expert.catalog" => experts::catalog(&home),
        // 只要 id 与名字（群组「添加专家」下拉）：不像 catalog 那样读提示词正文与技能
        "expert.options" => crate::commands::launchbar::expert_options()
            .map(Value::from)
            .map_err(|error| error.to_string()),
        "expert.save" => {
            let expert = serde_json::from_value(params["expert"].clone())
                .map_err(|error| format!("专家无效：{error}"))?;
            experts::save(
                &home,
                id,
                &expert,
                params["promptText"].as_str(),
                params["modified"].as_u64(),
            )
            .map(|()| Value::Null)
        }
        "expert.asset" => {
            experts::asset(&home, params["kind"].as_str().unwrap_or_default(), id).map(Value::from)
        }
        "expert.memoryList" => experts::memory_list(&home, id),
        "expert.memorySave" => experts::memory_save(
            &home,
            id,
            params["name"].as_str().unwrap_or_default(),
            params["description"].as_str().unwrap_or_default(),
            params["body"].as_str().unwrap_or_default(),
        )
        .map(|()| Value::Null),
        "expert.memoryDelete" => {
            experts::memory_delete(&home, id, params["name"].as_str().unwrap_or_default()).map(|()| Value::Null)
        }
        "expert.create" => {
            experts::create(&home, id, params["name"].as_str().unwrap_or(id)).map(|()| Value::Null)
        }
        "expert.delete" => experts::delete(&home, id).map(|()| Value::Null),
        // 任意终端的启动清单（`$BERTH_HOME/run/launches`）
        "expert.launch" => experts::latest_launch(&home, params["target"].as_str().unwrap_or_default()),
        // 插件可选的 inspect 钩子：核对这份清单的声明与实际，按需运行
        "expert.inspect" => {
            let manifest = experts::latest_launch(&home, params["target"].as_str().unwrap_or_default())?;
            berth_plugin_api::agent::inspect(&home, &manifest, Box::new(|| Value::Null))
        }
        _ => Err(format!("Unsupported expert operation: {method}")),
    }
}
