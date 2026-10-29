//! 翻译设置：非密钥走 app_metadata，API key 走 keyring。

use std::collections::HashMap;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::platform::keyring_store;
use berth_project_core::service::app_metadata_service;

pub const TRANSLATE_SETTINGS_KEY: &str = "translate_settings";

pub const PROVIDER_AUTO: &str = "auto";
pub const FREE_PROVIDERS: &[&str] = &["tencenttransmart", "huoshanweb", "googleapi", "google"];
pub const COMMERCIAL_PROVIDERS: &[&str] = &["deepl", "openaiCompatible"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslateProviderConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub model: String,
    /// 仅写入：明文 key。读取时不回传，只用 `has_key`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSettings {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_target_lang")]
    pub target_lang: String,
    #[serde(default)]
    pub provider_configs: HashMap<String, TranslateProviderConfig>,
}

fn default_provider() -> String {
    PROVIDER_AUTO.to_string()
}

fn default_target_lang() -> String {
    "auto".to_string()
}

impl Default for TranslateSettings {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            target_lang: default_target_lang(),
            provider_configs: HashMap::new(),
        }
    }
}

pub fn is_api_key_mask(value: &str) -> bool {
    let t = value.trim();
    t.len() >= 4 && t.chars().all(|c| c == '*')
}

pub fn is_free_provider(id: &str) -> bool {
    FREE_PROVIDERS.contains(&id)
}

pub fn is_commercial_provider(id: &str) -> bool {
    COMMERCIAL_PROVIDERS.contains(&id)
}

pub fn is_known_provider(id: &str) -> bool {
    id == PROVIDER_AUTO || is_free_provider(id) || is_commercial_provider(id)
}

pub fn normalize_provider_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("openaicompatible") {
        return "openaiCompatible".to_string();
    }
    trimmed.to_string()
}

pub async fn get_stored_api_key(provider: &str) -> Result<Option<String>, AppCommandError> {
    Ok(keyring_store::get_translate_api_key(provider)
        .await
        .map_err(AppCommandError::io_error)?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

pub async fn set_stored_api_key(provider: &str, api_key: &str) -> Result<(), AppCommandError> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        keyring_store::delete_translate_api_key(provider)
            .await
            .map_err(AppCommandError::io_error)?;
        return Ok(());
    }
    keyring_store::set_translate_api_key(provider, trimmed)
        .await
        .map_err(AppCommandError::io_error)
}

pub async fn load_translate_settings(
    conn: &DatabaseConnection,
    check_credentials: bool,
) -> Result<TranslateSettings, AppCommandError> {
    let raw = app_metadata_service::get_value(conn, TRANSLATE_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;
    let mut settings = match raw {
        Some(raw) => serde_json::from_str::<TranslateSettings>(&raw).unwrap_or_default(),
        None => TranslateSettings::default(),
    };
    if !is_known_provider(&settings.provider) {
        settings.provider = default_provider();
    }
    if settings.target_lang.trim().is_empty() {
        settings.target_lang = default_target_lang();
    }
    for id in COMMERCIAL_PROVIDERS {
        let entry = settings
            .provider_configs
            .entry((*id).to_string())
            .or_default();
        entry.api_key = None;
        entry.has_key = check_credentials && get_stored_api_key(id).await?.is_some();
    }
    Ok(settings)
}

pub async fn save_translate_settings(
    conn: &DatabaseConnection,
    mut incoming: TranslateSettings,
) -> Result<TranslateSettings, AppCommandError> {
    incoming.provider = normalize_provider_id(&incoming.provider);
    if !is_known_provider(&incoming.provider) {
        return Err(AppCommandError::invalid_input(format!(
            "Unknown translation provider: {}",
            incoming.provider
        )));
    }
    if incoming.target_lang.trim().is_empty() {
        incoming.target_lang = default_target_lang();
    }

    for id in COMMERCIAL_PROVIDERS {
        let Some(config) = incoming.provider_configs.get_mut(*id) else {
            continue;
        };
        if let Some(api_key) = config.api_key.take() {
            let trimmed = api_key.trim();
            if trimmed.is_empty() {
                set_stored_api_key(id, "").await?;
            } else if !is_api_key_mask(trimmed) {
                set_stored_api_key(id, trimmed).await?;
            }
        }
        config.api_key = None;
        config.has_key = get_stored_api_key(id).await?.is_some();
    }

    let persisted = TranslateSettings {
        provider: incoming.provider.clone(),
        target_lang: incoming.target_lang.clone(),
        provider_configs: incoming
            .provider_configs
            .iter()
            .map(|(id, cfg)| {
                (
                    id.clone(),
                    TranslateProviderConfig {
                        base_url: cfg.base_url.clone(),
                        region: cfg.region.clone(),
                        model: cfg.model.clone(),
                        api_key: None,
                        has_key: false,
                    },
                )
            })
            .collect(),
    };
    let serialized = serde_json::to_string(&persisted).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize translate settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, TRANSLATE_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;
    for (id, cfg) in &mut incoming.provider_configs {
        cfg.api_key = None;
        cfg.has_key = is_commercial_provider(id) && cfg.has_key;
    }
    Ok(incoming)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_detects_star_strings() {
        assert!(is_api_key_mask("****"));
        assert!(is_api_key_mask("********"));
        assert!(!is_api_key_mask("sk-abc"));
        assert!(!is_api_key_mask("***"));
    }

    #[test]
    fn openai_provider_id_normalizes() {
        assert_eq!(
            normalize_provider_id("openaiCompatible"),
            "openaiCompatible"
        );
        assert_eq!(
            normalize_provider_id("openaicompatible"),
            "openaiCompatible"
        );
    }
}
