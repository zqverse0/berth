//! Compatibility facade for the legacy conversation-only opened-tabs API.
//!
//! `primary_tab_service` owns storage and the one logical clock. Keeping this
//! module as a projection lets older clients continue to read conversations
//! without maintaining a second table or version counter.

use sea_orm::{ConnectionTrait, DatabaseConnection};

use berth_project_core::error::DbError;
use crate::db::service::primary_tab_service;
use crate::models::{OpenedTab, PrimaryTab};

pub struct CasOutcome {
    pub accepted: bool,
    pub version: i64,
    pub tabs: Vec<OpenedTab>,
    pub primary_tabs: Vec<PrimaryTab>,
}

pub struct TabInvalidation {
    pub version: i64,
    pub emit: Option<Vec<OpenedTab>>,
    pub primary_emit: Option<Vec<PrimaryTab>>,
}

pub async fn get_tabs_version<C: ConnectionTrait>(conn: &C) -> Result<i64, DbError> {
    primary_tab_service::get_tabs_version(conn).await
}

pub async fn list_all_tabs<C: ConnectionTrait>(conn: &C) -> Result<Vec<OpenedTab>, DbError> {
    let tabs = primary_tab_service::list_all_tabs(conn).await?;
    Ok(primary_tab_service::primary_to_legacy(&tabs))
}

pub async fn snapshot_tabs(conn: &DatabaseConnection) -> Result<(Vec<OpenedTab>, i64), DbError> {
    let (tabs, version) = primary_tab_service::snapshot_tabs(conn).await?;
    Ok((primary_tab_service::primary_to_legacy(&tabs), version))
}

pub async fn save_all_tabs_cas(
    conn: &DatabaseConnection,
    items: Vec<OpenedTab>,
    expected_version: i64,
) -> Result<CasOutcome, DbError> {
    let outcome = primary_tab_service::save_all_tabs_cas(
        conn,
        primary_tab_service::legacy_to_primary(items),
        expected_version,
    )
    .await?;
    let tabs = primary_tab_service::primary_to_legacy(&outcome.tabs);
    Ok(CasOutcome {
        accepted: outcome.accepted,
        version: outcome.version,
        tabs,
        primary_tabs: outcome.tabs,
    })
}

pub async fn delete_conversation_tabs_and_bump(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<TabInvalidation, DbError> {
    let outcome =
        primary_tab_service::delete_conversation_tabs_and_bump(conn, conversation_id).await?;
    let emit = outcome
        .emit
        .as_deref()
        .map(primary_tab_service::primary_to_legacy);
    Ok(TabInvalidation {
        version: outcome.version,
        emit,
        primary_emit: outcome.emit,
    })
}

pub async fn delete_folder_tabs_and_bump(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<TabInvalidation, DbError> {
    let outcome = primary_tab_service::delete_folder_tabs_and_bump(conn, folder_id).await?;
    let emit = outcome
        .emit
        .as_deref()
        .map(primary_tab_service::primary_to_legacy);
    Ok(TabInvalidation {
        version: outcome.version,
        emit,
        primary_emit: outcome.emit,
    })
}

pub async fn detach_folder_tabs_and_bump(
    conn: &DatabaseConnection,
    folder_id: i32,
    source_label: String,
    source_path: String,
) -> Result<TabInvalidation, DbError> {
    let outcome = primary_tab_service::detach_folder_tabs_and_bump(
        conn,
        folder_id,
        source_label,
        source_path,
    )
    .await?;
    let emit = outcome
        .emit
        .as_deref()
        .map(primary_tab_service::primary_to_legacy);
    Ok(TabInvalidation {
        version: outcome.version,
        emit,
        primary_emit: outcome.emit,
    })
}
