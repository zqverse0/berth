//! 划词翻译：免费 MT 竞速。
//!
//! 命令净增例外：pointer 右键「翻译」没有现成 HTTP POST 入口可复用，
//! 见 `commands/translate.rs`。引擎请求形状参考 Agentero 的免费 MT，
//! 密钥/商用/Agent 路径不迁入。

mod engines;
pub mod settings;

use crate::app_error::AppCommandError;
use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use settings::{
    get_stored_api_key, is_commercial_provider, is_free_provider, normalize_provider_id,
    TranslateSettings, PROVIDER_AUTO,
};

/// 单次请求字符上限（按 Unicode 标量）。
pub const MAX_TEXT_CHARS: usize = 5000;

/// 单引擎超时。竞速时墙钟约等于最慢的一次成功，而不是累加。
pub const ENGINE_TIMEOUT_MS: u32 = 8_000;

/// 并行竞速的免费引擎，偏国内可达。
pub const RACE_PROVIDERS: &[&str] = &["tencenttransmart", "huoshanweb", "googleapi"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextRequest {
    pub text: String,
    #[serde(default)]
    pub source_lang: Option<String>,
    #[serde(default)]
    pub target_lang: Option<String>,
    /// `auto` 或具体引擎 id。缺省时用设置页默认值。
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextResult {
    pub text: String,
    pub provider: String,
    pub target_lang: String,
}

/// 给 Tauri 命令与原生阅读器 IPC 共用。
pub async fn translate_text_core(
    request: TranslateTextRequest,
    stored: Option<&TranslateSettings>,
) -> Result<TranslateTextResult, AppCommandError> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err(AppCommandError::invalid_input("Empty text"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(AppCommandError::invalid_input(format!(
            "Text too long for translation (max {MAX_TEXT_CHARS} characters)"
        )));
    }

    let source = normalize_lang(request.source_lang.as_deref().unwrap_or("auto"), true);
    let requested_target = request
        .target_lang
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            stored
                .map(|s| s.target_lang.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "auto")
        });
    let target = resolve_target_lang(text, requested_target);
    if target.is_empty() {
        return Err(AppCommandError::invalid_input("Missing target language"));
    }

    let provider = normalize_provider_id(
        request
            .provider
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| stored.map(|s| s.provider.as_str()).unwrap_or(PROVIDER_AUTO)),
    );

    let timeout = std::time::Duration::from_millis(u64::from(ENGINE_TIMEOUT_MS));
    if provider == PROVIDER_AUTO || provider.is_empty() {
        return race_free_mt(text, &source, &target, timeout).await;
    }

    let engine_id = provider.to_ascii_lowercase();
    let stored_cfg = stored.and_then(|s| {
        s.provider_configs
            .get(&provider)
            .or_else(|| s.provider_configs.get(&engine_id))
    });
    let mut api_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !settings::is_api_key_mask(s))
        .map(str::to_string);
    if api_key.is_none() && is_commercial_provider(&provider) {
        api_key = get_stored_api_key(&provider).await?;
    }
    let base_url = request
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            stored_cfg
                .map(|c| c.base_url.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    let region = request
        .region
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            stored_cfg
                .map(|c| c.region.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            stored_cfg
                .map(|c| c.model.trim().to_string())
                .filter(|s| !s.is_empty())
        });

    if !is_free_provider(&provider) && !is_commercial_provider(&provider) {
        return Err(AppCommandError::invalid_input(format!(
            "Unknown translation provider: {provider}"
        )));
    }

    let translated = engines::translate_provider(
        &engine_id,
        text,
        &source,
        &target,
        timeout,
        engines::EngineOptions {
            api_key: api_key.as_deref(),
            base_url: base_url.as_deref(),
            region: region.as_deref(),
            model: model.as_deref(),
        },
    )
    .await?;
    let out = translated.trim().to_string();
    if out.is_empty() {
        return Err(AppCommandError::network(format!(
            "{provider} returned empty translation"
        )));
    }
    Ok(TranslateTextResult {
        text: out,
        provider,
        target_lang: target,
    })
}

async fn race_free_mt(
    text: &str,
    source: &str,
    target: &str,
    timeout: std::time::Duration,
) -> Result<TranslateTextResult, AppCommandError> {
    let mut tasks = FuturesUnordered::new();
    for provider in RACE_PROVIDERS {
        let text = text.to_string();
        let source = source.to_string();
        let target = target.to_string();
        let provider = (*provider).to_string();
        tasks.push(async move {
            match engines::translate_provider(
                &provider,
                &text,
                &source,
                &target,
                timeout,
                engines::empty_engine_options(),
            )
            .await
            {
                Ok(translated) => {
                    let out = translated.trim().to_string();
                    if out.is_empty() {
                        Err(AppCommandError::network(format!(
                            "{provider} returned empty translation"
                        )))
                    } else {
                        Ok(TranslateTextResult {
                            text: out,
                            provider,
                            target_lang: target,
                        })
                    }
                }
                Err(err) => Err(err),
            }
        });
    }

    let mut last_err: Option<AppCommandError> = None;
    while let Some(result) = tasks.next().await {
        match result {
            Ok(ok) => return Ok(ok),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err.unwrap_or_else(|| AppCommandError::network("All translation engines failed")))
}

/// 未指定目标语言时：中文为主译英文，否则译简体中文。
fn resolve_target_lang(text: &str, requested: Option<&str>) -> String {
    let requested = requested.map(str::trim).filter(|s| !s.is_empty());
    if let Some(raw) = requested {
        return normalize_lang(raw, false);
    }
    if looks_mostly_cjk(text) {
        "en".to_string()
    } else {
        "zh-CN".to_string()
    }
}

pub fn looks_mostly_cjk(s: &str) -> bool {
    let mut cjk = 0usize;
    let mut letters = 0usize;
    for c in s.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&c) {
            cjk += 1;
        } else if c.is_ascii_alphabetic() {
            letters += 1;
        }
    }
    cjk > 0 && cjk >= letters
}

fn normalize_lang(raw: &str, allow_auto: bool) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return if allow_auto {
            "auto".to_string()
        } else {
            String::new()
        };
    }
    let lower = s.to_ascii_lowercase();
    if allow_auto && (lower == "auto" || lower == "detect") {
        return "auto".to_string();
    }
    if lower == "zh" || lower == "zh-cn" || lower == "zh-hans" || lower == "chinese" {
        return "zh-CN".to_string();
    }
    if lower == "en" || lower == "english" {
        return "en".to_string();
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_heuristic_picks_english_target() {
        assert!(looks_mostly_cjk("本文提出了一种新的注意力机制。"));
        assert_eq!(
            resolve_target_lang("本文提出了一种新的注意力机制。", None),
            "en"
        );
        assert!(!looks_mostly_cjk(
            "We propose a new attention mechanism for sequence transduction."
        ));
        assert_eq!(
            resolve_target_lang("We propose a new attention mechanism.", None),
            "zh-CN"
        );
    }

    #[test]
    fn explicit_target_wins() {
        assert_eq!(resolve_target_lang("Hello", Some("zh")), "zh-CN");
        assert_eq!(resolve_target_lang("你好", Some("en")), "en");
    }

    #[test]
    fn normalize_zh_and_auto() {
        assert_eq!(normalize_lang("zh-CN", false), "zh-CN");
        assert_eq!(normalize_lang("Chinese", false), "zh-CN");
        assert_eq!(normalize_lang("auto", true), "auto");
    }

    #[tokio::test]
    async fn empty_text_rejected() {
        let err = translate_text_core(
            TranslateTextRequest {
                text: "   ".into(),
                source_lang: None,
                target_lang: None,
                provider: None,
                api_key: None,
                base_url: None,
                region: None,
                model: None,
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.message, "Empty text");
    }
}
