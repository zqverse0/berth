use crate::app_error::AppCommandError;
use crate::db::service::{agent_setting_service, model_provider_service};
use crate::db::AppDatabase;
use crate::event_bridge::EventEmitter;
use crate::models::agent::AgentType;
use crate::models::model_provider::ModelProviderInfo;

// ---------------------------------------------------------------------------
// Shared core functions (used by both Tauri commands and web handlers)
// ---------------------------------------------------------------------------

fn validate_agent_type(agent_type: &str) -> Result<(), AppCommandError> {
    if agent_type.trim().is_empty() {
        return Err(AppCommandError::invalid_input("Agent type is required"));
    }
    let _: AgentType = serde_json::from_value(serde_json::Value::String(agent_type.to_string()))
        .map_err(|_| AppCommandError::invalid_input(format!("Invalid agent type: {agent_type}")))?;
    Ok(())
}

fn validate_fields(
    name: Option<&str>,
    api_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<(), AppCommandError> {
    if let Some(n) = name {
        if n.len() > 256 {
            return Err(AppCommandError::invalid_input(
                "Name must be 256 characters or less",
            ));
        }
    }
    if let Some(u) = api_url.map(str::trim).filter(|s| !s.is_empty()) {
        if u.len() > 2048 {
            return Err(AppCommandError::invalid_input(
                "API URL must be 2048 characters or less",
            ));
        }
        if !u.starts_with("http://") && !u.starts_with("https://") {
            return Err(AppCommandError::invalid_input(
                "API URL must start with http:// or https://",
            ));
        }
    }
    if let Some(k) = api_key {
        if k.len() > 65536 {
            return Err(AppCommandError::invalid_input(
                "API Key must be 65536 characters or less",
            ));
        }
    }
    Ok(())
}

/// 模型字段只限长度：格式由读取它的插件自己解释，宿主不按 Agent 品牌校验结构。
fn validate_model(model: Option<&str>) -> Result<(), AppCommandError> {
    const MAX_LEN: usize = 262_144;
    if model.map(str::trim).is_some_and(|raw| raw.len() > MAX_LEN) {
        return Err(AppCommandError::invalid_input(format!(
            "Model must be {MAX_LEN} characters or less"
        )));
    }
    Ok(())
}

async fn hydrate_provider(
    db: &AppDatabase,
    mut row: berth_project_core::entities::model_provider::Model,
    include_secrets: bool,
) -> Result<ModelProviderInfo, AppCommandError> {
    let key = if !include_secrets
        || row.kind == berth_project_core::entities::model_provider::KIND_OFFICIAL
    {
        String::new()
    } else {
        crate::model_provider::secrets::load_api_key(&db.conn, &row)
            .await
            .map_err(AppCommandError::from)?
    };
    let overlays =
        crate::db::service::model_provider_overlay_service::list_for_provider(&db.conn, row.id)
            .await
            .map_err(AppCommandError::from)?;
    let discovery_json = if include_secrets {
        crate::model_provider::secrets::load_discovery(&db.conn, &row)
            .await
            .map_err(AppCommandError::from)?
    } else {
        // 启动栏只读目录，不读取凭据文件，也不把旧库残留的密钥交给前端。
        row.api_key.clear();
        row.discovery_json.as_deref().map(|raw| {
            berth_project_core::service::model_provider_launch::split_secrets(raw)
                .map(|(sanitized, _, _)| sanitized)
                .unwrap_or_else(|| raw.to_string())
        })
    };
    let mut info = ModelProviderInfo::from(row);
    info.discovery_json = discovery_json;
    info.api_key = key.clone();
    info.api_key_masked = {
        let chars: Vec<char> = key.chars().collect();
        let len = chars.len();
        if len <= 8 {
            "\u{2022}".repeat(len)
        } else {
            let prefix: String = chars[..4].iter().collect();
            let suffix: String = chars[len - 4..].iter().collect();
            format!("{}{}{}", prefix, "\u{2022}".repeat(len.min(20) - 8), suffix)
        }
    };
    info.overlays = overlays
        .into_iter()
        .map(|o| crate::models::model_provider::ProviderOverlayInfo {
            agent_type: o.agent_type,
            models: o.models_json,
        })
        .collect();
    Ok(info)
}

pub async fn list_model_providers_core(
    db: &AppDatabase,
    include_secrets: bool,
) -> Result<Vec<ModelProviderInfo>, AppCommandError> {
    // 不做同 URL 自动合并删除：设置页必须展示库内全部 API 档案。
    // 旧 `kind=official` 行不再列出：自带登录由 tool.json 声明虚拟出来（不落库、不删旧行）。
    let rows = model_provider_service::list_all(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows
        .into_iter()
        .filter(|row| row.kind != berth_project_core::entities::model_provider::KIND_OFFICIAL)
    {
        out.push(hydrate_provider(db, row, include_secrets).await?);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub async fn create_model_provider_core(
    db: &AppDatabase,
    name: String,
    api_url: String,
    api_key: String,
    agent_type: String,
    model: Option<String>,
    website: Option<String>,
    agent_allowlist: Option<Vec<String>>,
    kind: Option<String>,
    overlays: Option<Vec<crate::models::model_provider::ProviderOverlayInfo>>,
    discovery_json: Option<String>,
) -> Result<ModelProviderInfo, AppCommandError> {
    validate_fields(Some(&name), Some(&api_url), Some(&api_key))?;
    // 自定义不要求 agent_type；空串表示全局档案。
    if !agent_type.trim().is_empty() {
        validate_agent_type(&agent_type)?;
    }
    validate_model(model.as_deref())?;

    let kind_val = kind.unwrap_or_else(|| "custom".to_string());
    let model_row = model_provider_service::create_with_kind(
        &db.conn,
        name,
        api_url,
        String::new(),
        agent_type.clone(),
        model.clone(),
        website,
        kind_val,
    )
    .await
    .map_err(AppCommandError::from)?;
    if !api_key.trim().is_empty() {
        crate::model_provider::secrets::store_api_key(model_row.id, &api_key)
            .await
            .map_err(AppCommandError::invalid_input)?;
    }

    let discovery_json =
        crate::model_provider::secrets::store_discovery(model_row.id, discovery_json)
            .await
            .map_err(AppCommandError::invalid_input)?;
    let allowlist_json =
        agent_allowlist.map(|list| serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()));
    if allowlist_json.is_some() || discovery_json.is_some() {
        let _ = crate::db::service::model_provider_service::update_meta(
            &db.conn,
            model_row.id,
            None,
            discovery_json.map(Some),
            allowlist_json,
            None,
        )
        .await;
    } else if !agent_type.trim().is_empty() {
        let _ = crate::db::service::model_provider_service::update_meta(
            &db.conn,
            model_row.id,
            None,
            None,
            Some(
                serde_json::to_string(&vec![model_row.agent_type.clone()])
                    .unwrap_or_else(|_| "[]".into()),
            ),
            None,
        )
        .await;
    }

    if let Some(overlay_rows) = overlays {
        for row in overlay_rows {
            if row.agent_type.trim().is_empty() {
                continue;
            }
            let _ = crate::db::service::model_provider_overlay_service::upsert(
                &db.conn,
                model_row.id,
                row.agent_type,
                row.models,
            )
            .await;
        }
    } else if !agent_type.trim().is_empty() {
        if let Some(raw) = model.filter(|v| !v.trim().is_empty()) {
            let _ = crate::db::service::model_provider_overlay_service::upsert(
                &db.conn,
                model_row.id,
                agent_type,
                raw,
            )
            .await;
        }
    }

    let row = model_provider_service::get_by_id(&db.conn, model_row.id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("model provider missing after create"))?;
    hydrate_provider(db, row, true).await
}

/// Update a model provider. For the `model` parameter:
/// - `None` (omitted) means "don't change"
/// - `Some("")` means "clear"
/// - `Some(value)` means "set to value"
#[allow(clippy::too_many_arguments)]
pub async fn update_model_provider_core(
    db: &AppDatabase,
    id: i32,
    name: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    website: Option<String>,
    agent_allowlist: Option<Vec<String>>,
    overlays: Option<Vec<crate::models::model_provider::ProviderOverlayInfo>>,
    kind: Option<String>,
    discovery_json: Option<String>,
    _emitter: &EventEmitter,
) -> Result<ModelProviderInfo, AppCommandError> {
    validate_fields(name.as_deref(), api_url.as_deref(), api_key.as_deref())?;

    // Fetch old provider to detect changes and to determine effective agent_type for model validation.
    let _old_provider = model_provider_service::get_by_id(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("model provider not found: {id}")))?;

    if let Some(ref at) = agent_type {
        if !at.trim().is_empty() {
            validate_agent_type(at)?;
        }
    }
    validate_model(model.as_deref())?;

    // Translate Some("") to Some(None) (clear), Some(value) to Some(Some(value)), None to None.
    let model_patch: Option<Option<String>> = model.as_ref().map(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let stored_key = api_key.clone();
    let model_row = model_provider_service::update(
        &db.conn,
        id,
        name,
        api_url,
        Some(String::new()),
        None,
        model_patch,
        website,
    )
    .await
    .map_err(AppCommandError::from)?;
    if let Some(key) = stored_key.filter(|k| !k.trim().is_empty()) {
        crate::model_provider::secrets::store_api_key(id, &key)
            .await
            .map_err(AppCommandError::invalid_input)?;
    }
    let discovery_json = crate::model_provider::secrets::store_discovery(id, discovery_json)
        .await
        .map_err(AppCommandError::invalid_input)?;
    let allowlist_json =
        agent_allowlist.map(|list| serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()));
    if allowlist_json.is_some() || discovery_json.is_some() || kind.is_some() {
        crate::db::service::model_provider_service::update_meta(
            &db.conn,
            id,
            None,
            discovery_json.map(Some),
            allowlist_json,
            kind,
        )
        .await
        .map_err(AppCommandError::from)?;
    }
    if let (Some(at), Some(Some(raw))) = (
        agent_type.filter(|s| !s.trim().is_empty()),
        model.as_ref().map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
    ) {
        crate::db::service::model_provider_overlay_service::upsert(&db.conn, id, at, raw)
            .await
            .map_err(AppCommandError::from)?;
    }
    if let Some(rows) = overlays {
        crate::db::service::model_provider_overlay_service::delete_for_provider(&db.conn, id)
            .await
            .map_err(AppCommandError::from)?;
        for row in rows {
            if row.agent_type.trim().is_empty() {
                continue;
            }
            crate::db::service::model_provider_overlay_service::upsert(
                &db.conn,
                id,
                row.agent_type,
                row.models,
            )
            .await
            .map_err(AppCommandError::from)?;
        }
    }

    hydrate_provider(db, model_row, true).await
}

/// Result of `update_model_provider`: the updated provider row plus how many
/// running sessions the cascade left on stale (launch-time) config — for the
/// settings-side "N sessions need restart" toast.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateModelProviderResult {
    pub provider: ModelProviderInfo,
    pub affected_running_sessions: usize,
}

/// `update_model_provider_core` followed by a staleness refresh for every agent
/// bound to this provider. Shared by the Tauri command and the web handler so
/// both surface how many running sessions need a restart to pick up the new
/// credentials/model. If the save didn't actually change url/key/model, the
/// cascade is skipped, fingerprints are unchanged, and the refresh is a silent
/// no-op returning 0.
#[allow(clippy::too_many_arguments)]
pub async fn update_model_provider_and_refresh(
    db: &AppDatabase,
    id: i32,
    name: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    website: Option<String>,
    agent_allowlist: Option<Vec<String>>,
    overlays: Option<Vec<crate::models::model_provider::ProviderOverlayInfo>>,
    kind: Option<String>,
    discovery_json: Option<String>,
    emitter: &EventEmitter,
) -> Result<UpdateModelProviderResult, AppCommandError> {
    let provider = update_model_provider_core(
        db,
        id,
        name,
        api_url,
        api_key,
        agent_type,
        model,
        website,
        agent_allowlist,
        overlays,
        kind,
        discovery_json,
        emitter,
    )
    .await?;

    Ok(UpdateModelProviderResult {
        provider,
        affected_running_sessions: 0,
    })
}

pub async fn delete_model_provider_core(db: &AppDatabase, id: i32) -> Result<(), AppCommandError> {
    let _existing = model_provider_service::get_by_id(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("model provider not found: {id}")))?;

    // 协议匹配只决定启动栏可见性；历史 agent_setting 绑定不是删除前置条件。
    // 删档案时顺带清残留引用，避免旧「全局当前供应商」脏数据误拦删除。
    agent_setting_service::clear_model_provider_bindings(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;

    crate::db::service::model_provider_overlay_service::delete_for_provider(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    let _ = crate::model_provider::secrets::delete_api_key(id).await;
    let _ = crate::model_provider::secrets::delete_discovery_secrets(id).await;
    model_provider_service::delete(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_model_providers(
    db: tauri::State<'_, AppDatabase>,
    include_secrets: Option<bool>,
) -> Result<Vec<ModelProviderInfo>, AppCommandError> {
    list_model_providers_core(&db, include_secrets.unwrap_or(true)).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_model_provider(
    db: tauri::State<'_, AppDatabase>,
    name: String,
    api_url: String,
    api_key: String,
    agent_type: String,
    model: Option<String>,
    website: Option<String>,
    agent_allowlist: Option<Vec<String>>,
    kind: Option<String>,
    overlays: Option<Vec<crate::models::model_provider::ProviderOverlayInfo>>,
    discovery_json: Option<String>,
) -> Result<ModelProviderInfo, AppCommandError> {
    create_model_provider_core(
        &db,
        name,
        api_url,
        api_key,
        agent_type,
        model,
        website,
        agent_allowlist,
        kind,
        overlays,
        discovery_json,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_model_provider(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    name: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    website: Option<String>,
    agent_allowlist: Option<Vec<String>>,
    overlays: Option<Vec<crate::models::model_provider::ProviderOverlayInfo>>,
    kind: Option<String>,
    discovery_json: Option<String>,
    app: tauri::AppHandle,
) -> Result<UpdateModelProviderResult, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    update_model_provider_and_refresh(
        &db,
        id,
        name,
        api_url,
        api_key,
        agent_type,
        model,
        website,
        agent_allowlist,
        overlays,
        kind,
        discovery_json,
        &emitter,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn delete_model_provider(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    delete_model_provider_core(&db, id).await
}

// ---------------------------------------------------------------------------
// Agent ↔ provider 绑定命令(Tauri 薄壳;core 在 model_provider::binding)
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_agent_provider_binding(
    db: tauri::State<'_, AppDatabase>,
    agent_type: String,
) -> Result<crate::model_provider::binding::AgentProviderBinding, AppCommandError> {
    crate::model_provider::binding::get(&db, &agent_type).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn set_agent_provider_binding(
    db: tauri::State<'_, AppDatabase>,
    agent_type: String,
    provider_id: Option<i32>,
    model_key: Option<String>,
) -> Result<(), AppCommandError> {
    crate::model_provider::binding::set(&db, &agent_type, provider_id, model_key).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn import_cc_switch_providers(
    db: tauri::State<'_, AppDatabase>,
) -> Result<crate::model_provider::import::ImportSummary, AppCommandError> {
    crate::model_provider::import::import_from_cc_switch(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn fetch_provider_models(
    protocol: String,
    api_url: String,
    api_key: String,
) -> Result<Vec<crate::model_provider::models::FetchedModel>, AppCommandError> {
    // 仅一次 GET 列表；鉴权形态由协议决定（chat / claude / gemini），不重试。
    crate::model_provider::models::fetch(&protocol, &api_url, &api_key).await
}

/// 档案备份：`operation` 为 `export`（写出不含 Key 的 JSON）或 `import`（从该文件新建档案）。
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn model_provider_transfer(
    db: tauri::State<'_, AppDatabase>,
    operation: String,
    path: String,
) -> Result<crate::model_provider::import::TransferSummary, AppCommandError> {
    match operation.as_str() {
        "export" => crate::model_provider::import::export_to_file(&db, &path).await,
        "import" => crate::model_provider::import::import_from_file(&db, &path).await,
        other => Err(AppCommandError::invalid_input(format!(
            "unknown operation '{other}', expected export or import"
        ))),
    }
}

/// 设置页端点「调用地址」：本实例代理根地址、是否在监听、令牌（占位凭据，真 Key 不出后端）。
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn model_provider_proxy_access(
) -> Result<crate::model_provider::proxy::ProxyAccess, AppCommandError> {
    crate::model_provider::proxy::access()
        .await
        .map_err(AppCommandError::invalid_input)
}

/// 决策面板：用档案的决策端点评估一次（Key 由后端从本地凭据文件读取）。
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn model_provider_systemone(
    db: tauri::State<'_, AppDatabase>,
    provider_id: i32,
    model: String,
    state: serde_json::Value,
    questions: serde_json::Value,
) -> Result<serde_json::Value, AppCommandError> {
    crate::model_provider::systemone::evaluate(
        &db.conn,
        provider_id,
        &model,
        state,
        questions,
        std::time::Duration::from_secs(60),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::tool::path::TEST_ENV_LOCK;
    use std::path::PathBuf;

    fn with_empty_tools_home(test: impl FnOnce(PathBuf)) {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let previous_data = std::env::var_os("BERTH_DATA_DIR");
        let dir =
            std::env::temp_dir().join(format!("model-provider-cmd-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        std::env::set_var("BERTH_HOME", &dir);
        std::env::set_var("BERTH_DATA_DIR", &dir);
        test(dir.clone());
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        match previous_data {
            Some(value) => std::env::set_var("BERTH_DATA_DIR", value),
            None => std::env::remove_var("BERTH_DATA_DIR"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn launchbar_catalog_preserves_models_without_reading_or_exposing_keys() {
        let db = fresh_in_memory_db().await;
        let row = model_provider_service::create_with_kind(
            &db.conn,
            "Provider".into(),
            "https://example.com/v1".into(),
            "test-legacy-key".into(),
            "codex".into(),
            Some("model-1".into()),
            None,
            "custom".into(),
        )
        .await
        .unwrap();
        model_provider_service::update_meta(
            &db.conn, row.id, None,
            Some(Some(r#"{"endpoints":{"chat":{"apiUrl":"https://example.com/v1","apiKey":"test-endpoint-key"}}}"#.into())),
            None, None,
        ).await.unwrap();
        let rows = list_model_providers_core(&db, false).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model.as_deref(), Some("model-1"));
        assert!(rows[0].api_key.is_empty());
        assert!(rows[0].api_key_masked.is_empty());
        let discovery = rows[0].discovery_json.as_deref().unwrap();
        assert!(discovery.contains("https://example.com/v1"));
        assert!(!discovery.contains("test-endpoint-key"));
    }

    /// Regression: an `api_key` containing a multibyte character (e.g. a
    /// full-width char typed under a CJK IME) must not panic the masking in
    /// `ModelProviderInfo::from`. Before the fix, `create` persisted the row
    /// and then panicked, after which every `list_model_providers` call
    /// panicked on that row — breaking the settings list and the agent
    /// management provider dropdown until the row was removed.
    #[test]
    fn create_and_list_tolerate_multibyte_api_key() {
        with_empty_tools_home(|_| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let db = fresh_in_memory_db().await;

                let created = create_model_provider_core(
                    &db,
                    "Provider".to_string(),
                    "https://api.example.com".to_string(),
                    "sk-密钥abcd1234".to_string(),
                    "codex".to_string(),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await;
                assert!(
                    created.is_ok(),
                    "create panicked/failed: {:?}",
                    created.err()
                );

                let rows = list_model_providers_core(&db, true)
                    .await
                    .expect("list must not fail on a multibyte api_key");
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].kind, "custom");
                // The raw key round-trips; only the masked view is derived.
                assert_eq!(rows[0].api_key, "sk-密钥abcd1234");
                assert!(!rows[0].api_key_masked.is_empty());
            });
        });
    }

    #[test]
    fn transfer_round_trips_without_keys_and_skips_duplicates() {
        with_empty_tools_home(|home| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let source = fresh_in_memory_db().await;
                create_model_provider_core(
                    &source,
                    "Relay".to_string(),
                    "https://relay.example".to_string(),
                    "sk-secret-main".to_string(),
                    String::new(),
                    Some(r#"[{"id":"m1","name":"m1"}]"#.to_string()),
                    Some("https://relay.example/home".to_string()),
                    None,
                    None,
                    None,
                    Some(r#"{"endpoints":{"chat":{"apiUrl":"https://relay.example/v1"}},"keyGroups":[{"id":"1","name":"default","key":"sk-secret-group","models":[]}]}"#.to_string()),
                )
                .await
                .unwrap();
                let file = home.join("providers.json");
                let path = file.to_str().unwrap();
                let exported = crate::model_provider::import::export_to_file(&source, path)
                    .await
                    .unwrap();
                assert_eq!(exported.providers, 1);
                let text = std::fs::read_to_string(&file).unwrap();
                assert!(!text.contains("sk-secret"), "export must not carry keys");

                let target = fresh_in_memory_db().await;
                let imported = crate::model_provider::import::import_from_file(&target, path)
                    .await
                    .unwrap();
                assert_eq!((imported.providers, imported.skipped_duplicate), (1, 0));
                let again = crate::model_provider::import::import_from_file(&target, path)
                    .await
                    .unwrap();
                assert_eq!((again.providers, again.skipped_duplicate), (0, 1));

                let rows = list_model_providers_core(&target, true).await.unwrap();
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].website.as_deref(), Some("https://relay.example/home"));
                assert!(rows[0].model.as_deref().unwrap().contains("m1"));
                assert!(rows[0]
                    .discovery_json
                    .as_deref()
                    .unwrap()
                    .contains("https://relay.example/v1"));
            });
        });
    }

    #[test]
    fn official_provider_can_be_updated_and_deleted() {
        with_empty_tools_home(|_| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let db = fresh_in_memory_db().await;
                let official = crate::db::service::model_provider_service::create_with_kind(
                    &db.conn,
                    "Claude Official".into(),
                    String::new(),
                    String::new(),
                    "claude_code".into(),
                    None,
                    None,
                    berth_project_core::entities::model_provider::KIND_OFFICIAL.into(),
                )
                .await
                .expect("seed official");

                let update = update_model_provider_core(
                    &db,
                    official.id,
                    Some("Renamed".into()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    &EventEmitter::Noop,
                )
                .await;
                assert!(update.is_ok(), "official provider can be updated");
                assert_eq!(update.unwrap().name, "Renamed");

                let delete = delete_model_provider_core(&db, official.id).await;
                assert!(delete.is_ok(), "official provider can be deleted");
            });
        });
    }

    #[test]
    fn delete_provider_clears_stale_agent_setting_bindings() {
        with_empty_tools_home(|_| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let db = fresh_in_memory_db().await;
                let provider = create_model_provider_core(
                    &db,
                    "relay".into(),
                    "https://api.example.com".into(),
                    "sk-test".into(),
                    "claude_code".into(),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await
                .expect("create provider");

                agent_setting_service::set_model_binding(
                    &db.conn,
                    AgentType::new("claude_code"),
                    Some(provider.id),
                    Some("sonnet".into()),
                )
                .await
                .expect("seed stale binding");

                delete_model_provider_core(&db, provider.id)
                    .await
                    .expect("delete must succeed despite stale binding");

                let leftover =
                    agent_setting_service::find_by_model_provider_id(&db.conn, provider.id)
                        .await
                        .expect("query bindings");
                assert!(leftover.is_empty(), "stale bindings must be cleared");

                let setting =
                    agent_setting_service::get_by_agent_type(&db.conn, AgentType::new("claude_code"))
                        .await
                        .expect("read setting")
                        .expect("setting row remains");
                assert_eq!(setting.model_provider_id, None);
                assert_eq!(setting.model_key, None);
            });
        });
    }

    #[test]
    fn validate_model_only_caps_length() {
        assert!(validate_model(Some(r#"{"customs":[{"base":"gpt-5.4"}]}"#)).is_ok());
        assert!(validate_model(Some(&"a".repeat(10_000))).is_ok());
        assert!(validate_model(Some(&"a".repeat(262_145))).is_err());
        assert!(validate_model(None).is_ok());
    }
}
