//! 划词翻译 Tauri 入口。
//!
//! `translate_text`：翻译。`get/update_translate_settings`：默认引擎与接口配置。
//! API key 走 keyring，不进 app_metadata。

use crate::app_error::AppCommandError;
use crate::translate::settings::{
    load_translate_settings, save_translate_settings, TranslateSettings,
};
use crate::translate::{translate_text_core, TranslateTextRequest, TranslateTextResult};

#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
#[cfg(feature = "tauri-runtime")]
use tauri::State;

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn translate_text(
    request: TranslateTextRequest,
    #[cfg(feature = "tauri-runtime")] db: State<'_, AppDatabase>,
) -> Result<TranslateTextResult, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    let stored = load_translate_settings(&db.conn, false).await.ok();
    #[cfg(not(feature = "tauri-runtime"))]
    let stored = None;
    translate_text_core(request, stored.as_ref()).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_translate_settings(
    db: State<'_, AppDatabase>,
) -> Result<TranslateSettings, AppCommandError> {
    load_translate_settings(&db.conn, true).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_translate_settings(
    settings: TranslateSettings,
    db: State<'_, AppDatabase>,
) -> Result<TranslateSettings, AppCommandError> {
    save_translate_settings(&db.conn, settings).await
}
