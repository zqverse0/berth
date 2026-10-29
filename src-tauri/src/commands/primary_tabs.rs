use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::db::service::primary_tab_service;
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use crate::event_bridge::{
    emit_event, EventEmitter, PrimaryTabsChanged, PRIMARY_TABS_CHANGED_EVENT,
};
use crate::models::{
    PrimaryTab, PrimaryTabsSnapshot, SavePrimaryTabsOutcome, SavePrimaryTabsRejection,
};

pub async fn list_primary_tabs_core(
    conn: &DatabaseConnection,
) -> Result<PrimaryTabsSnapshot, AppCommandError> {
    let (items, version) = primary_tab_service::snapshot_tabs(conn).await?;
    Ok(PrimaryTabsSnapshot { items, version })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyResourceArchiveItem {
    pub resource_kind: String,
    pub resource_key: String,
    pub payload: serde_json::Value,
    pub archived_at: String,
}

/// Read-only export seam for resources removed from the folder-only runtime
/// projection. The original rows remain untouched; consumers can download this
/// lossless inventory without restoring a permanent Chat section.
pub async fn list_legacy_resource_archive_core(
    conn: &DatabaseConnection,
) -> Result<Vec<LegacyResourceArchiveItem>, AppCommandError> {
    let rows = conn
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT resource_kind, resource_key, payload, archived_at \
             FROM legacy_resource_archive ORDER BY archived_at, id",
        ))
        .await
        .map_err(|error| {
            AppCommandError::database_error("Failed to read legacy resource archive")
                .with_detail(error.to_string())
        })?;
    rows.into_iter()
        .map(|row| {
            let read = |column| {
                row.try_get("", column).map_err(|error| {
                    AppCommandError::database_error("Failed to decode legacy resource archive")
                        .with_detail(error.to_string())
                })
            };
            let payload: String = read("payload")?;
            Ok(LegacyResourceArchiveItem {
                resource_kind: read("resource_kind")?,
                resource_key: read("resource_key")?,
                payload: serde_json::from_str(&payload).map_err(|error| {
                    AppCommandError::task_execution_failed(
                        "Legacy resource archive contains invalid JSON",
                    )
                    .with_detail(error.to_string())
                })?,
                archived_at: read("archived_at")?,
            })
        })
        .collect()
}

pub async fn save_primary_tabs_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    items: Vec<PrimaryTab>,
    expected_version: i64,
    origin: String,
) -> Result<SavePrimaryTabsOutcome, AppCommandError> {
    let outcome = primary_tab_service::save_all_tabs_cas(conn, items, expected_version).await?;
    if outcome.accepted {
        emit_primary_tabs_changed(emitter, outcome.version, outcome.tabs.clone(), origin);
    }
    Ok(SavePrimaryTabsOutcome {
        accepted: outcome.accepted,
        version: outcome.version,
        tabs: outcome.tabs,
        rejection: (!outcome.accepted).then_some(SavePrimaryTabsRejection::VersionConflict),
    })
}

pub(crate) fn emit_primary_tabs_changed(
    emitter: &EventEmitter,
    version: i64,
    tabs: Vec<PrimaryTab>,
    origin: String,
) {
    emit_event(
        emitter,
        PRIMARY_TABS_CHANGED_EVENT,
        PrimaryTabsChanged {
            version,
            origin,
            tabs,
        },
    );
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_primary_tabs(
    db: tauri::State<'_, AppDatabase>,
) -> Result<PrimaryTabsSnapshot, AppCommandError> {
    list_primary_tabs_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_legacy_resource_archive(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<LegacyResourceArchiveItem>, AppCommandError> {
    list_legacy_resource_archive_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn save_primary_tabs(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    items: Vec<PrimaryTab>,
    expected_version: i64,
    origin: String,
) -> Result<SavePrimaryTabsOutcome, AppCommandError> {
    save_primary_tabs_core(
        &db.conn,
        &EventEmitter::Tauri(app),
        items,
        expected_version,
        origin,
    )
    .await
}
