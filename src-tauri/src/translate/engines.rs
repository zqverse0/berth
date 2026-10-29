//! 免费网页机器翻译引擎。非官方接口，可能限流或失效。
//! 请求形状对齐 Agentero `features/translate`，只保留划词需要的免费路径。

use crate::app_error::AppCommandError;
use serde_json::Value;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub struct EngineOptions<'a> {
    pub api_key: Option<&'a str>,
    pub base_url: Option<&'a str>,
    #[allow(dead_code)]
    pub region: Option<&'a str>,
    pub model: Option<&'a str>,
}

pub fn empty_engine_options<'a>() -> EngineOptions<'a> {
    EngineOptions {
        api_key: None,
        base_url: None,
        region: None,
        model: None,
    }
}

pub async fn translate_provider(
    provider: &str,
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    opts: EngineOptions<'_>,
) -> Result<String, AppCommandError> {
    match provider {
        "google" | "googleapi" => {
            let host = if provider == "google" {
                "https://translate.google.com"
            } else {
                "https://translate.googleapis.com"
            };
            translate_google(host, text, source, target, timeout).await
        }
        "huoshanweb" => translate_huoshan_web(text, source, target, timeout).await,
        "tencenttransmart" => translate_tencent_transmart(text, source, target, timeout).await,
        "deepl" => {
            translate_deepl(text, source, target, timeout, opts.api_key, opts.base_url).await
        }
        "openaicompatible" => {
            translate_openai_compatible(
                text,
                source,
                target,
                timeout,
                opts.api_key,
                opts.base_url,
                opts.model,
            )
            .await
        }
        other => Err(AppCommandError::invalid_input(format!(
            "Unknown translation provider: {other}"
        ))),
    }
}

fn lang_base(code: &str) -> &str {
    code.split('-').next().unwrap_or(code)
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, AppCommandError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| AppCommandError::network(format!("http client: {e}")))
}

async fn read_body(
    resp: reqwest::Response,
) -> Result<(reqwest::StatusCode, String), AppCommandError> {
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppCommandError::network(format!("translate read body: {e}")))?;
    Ok((status, body))
}

fn http_err(status: reqwest::StatusCode, body: &str, label: &str) -> AppCommandError {
    let snippet: String = body.chars().take(180).collect();
    AppCommandError::network(format!("{label} failed (HTTP {status}): {snippet}"))
}

async fn translate_google(
    host: &str,
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppCommandError> {
    let client = http_client(timeout)?;
    let sl = if source == "auto" { "auto" } else { source };
    let url = format!("{}/translate_a/single", host.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .query(&[
            ("client", "gtx"),
            ("sl", sl),
            ("tl", target),
            ("dt", "t"),
            ("q", text),
        ])
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("Google translate request failed: {e}")))?;
    let (status, body) = read_body(resp).await?;
    if !status.is_success() {
        return Err(http_err(status, &body, "Google Translate"));
    }
    parse_google_gtx_body(&body)
}

fn parse_google_gtx_body(body: &str) -> Result<String, AppCommandError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|e| AppCommandError::network(format!("Google translate parse: {e}")))?;
    let mut out = String::new();
    let Some(segments) = v
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|x| x.as_array())
    else {
        return Err(AppCommandError::network(
            "Unexpected Google translation response",
        ));
    };
    for seg in segments {
        if let Some(piece) = seg
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|x| x.as_str())
        {
            out.push_str(piece);
        }
    }
    if out.is_empty() {
        return Err(AppCommandError::network("Empty Google translation result"));
    }
    Ok(out)
}

async fn translate_huoshan_web(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppCommandError> {
    let client = http_client(timeout)?;
    let from = if source == "auto" {
        "auto".to_string()
    } else {
        lang_base(source).to_string()
    };
    let to = lang_base(target).to_string();
    let body = serde_json::json!({
        "source_language": from,
        "target_language": to,
        "text": text,
    });
    let resp = client
        .post("https://translate.volcengine.com/crx/translate/v1")
        .header("Content-Type", "application/json")
        .header("User-Agent", UA)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("Volcengine request failed: {e}")))?;
    let (status, body) = read_body(resp).await?;
    if !status.is_success() {
        return Err(http_err(status, &body, "Volcengine Web"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppCommandError::network(format!("Volcengine parse: {e}")))?;
    v.get("translation")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppCommandError::network("Unexpected Volcengine translation response"))
}

async fn translate_tencent_transmart(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
) -> Result<String, AppCommandError> {
    let client = http_client(timeout)?;
    let from = if source == "auto" {
        "auto".to_string()
    } else {
        lang_base(source).to_string()
    };
    let to = lang_base(target).to_string();
    let body = serde_json::json!({
        "header": {
            "fn": "auto_translation",
            "client_key": "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487"
        },
        "type": "plain",
        "model_category": "normal",
        "source": {
            "lang": from,
            "text_list": [text],
        },
        "target": {
            "lang": to,
        },
    });
    let resp = client
        .post("https://transmart.qq.com/api/imt")
        .header("Content-Type", "application/json")
        .header("User-Agent", UA)
        .header("Referer", "https://transmart.qq.com/zh-CN/index")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("Tencent Transmart request failed: {e}")))?;
    let (status, body) = read_body(resp).await?;
    if !status.is_success() {
        return Err(http_err(status, &body, "Tencent Transmart"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppCommandError::network(format!("Tencent Transmart parse: {e}")))?;
    if let Some(arr) = v.get("auto_translation").and_then(|x| x.as_array()) {
        let parts: Vec<&str> = arr.iter().filter_map(|x| x.as_str()).collect();
        if !parts.is_empty() {
            return Ok(parts.join("\n").trim().to_string());
        }
    }
    Err(AppCommandError::network(
        "Unexpected Tencent Transmart translation response",
    ))
}

fn required_api_key<'a>(
    provider: &str,
    api_key: Option<&'a str>,
) -> Result<&'a str, AppCommandError> {
    api_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppCommandError::configuration_missing(format!(
                "{provider} requires apiKey (Settings → Translate)"
            ))
        })
}

fn optional_endpoint(base_url: Option<&str>, default_root: &str, suffix: &str) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default_root)
        .trim_end_matches('/');
    if base.ends_with(suffix) {
        base.to_string()
    } else {
        format!("{base}{suffix}")
    }
}

async fn translate_deepl(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<String, AppCommandError> {
    let key = required_api_key("DeepL", api_key)?;
    let url = optional_endpoint(base_url, "https://api-free.deepl.com", "/v2/translate");
    let client = http_client(timeout)?;
    let target_lang = deepl_target(target);
    let mut form = vec![("text", text), ("target_lang", target_lang.as_str())];
    let source_lang = if source == "auto" {
        None
    } else {
        Some(deepl_source(source))
    };
    if let Some(ref sl) = source_lang {
        form.push(("source_lang", sl.as_str()));
    }
    let resp = client
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .form(&form)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("DeepL request failed: {e}")))?;
    let (status, body) = read_body(resp).await?;
    if !status.is_success() {
        return Err(http_err(status, &body, "DeepL"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppCommandError::network(format!("DeepL parse: {e}")))?;
    v.get("translations")
        .and_then(|x| x.as_array())
        .and_then(|x| x.first())
        .and_then(|x| x.get("text"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppCommandError::network("Unexpected DeepL translation response"))
}

fn deepl_source(code: &str) -> String {
    match code {
        "zh-CN" | "zh-Hans" => "ZH".to_string(),
        "en" => "EN".to_string(),
        _ => lang_base(code).to_ascii_uppercase(),
    }
}

fn deepl_target(code: &str) -> String {
    match code {
        "zh-CN" | "zh-Hans" => "ZH-HANS".to_string(),
        "en" => "EN-US".to_string(),
        _ => lang_base(code).to_ascii_uppercase(),
    }
}

async fn translate_openai_compatible(
    text: &str,
    source: &str,
    target: &str,
    timeout: Duration,
    api_key: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<String, AppCommandError> {
    let key = required_api_key("OpenAI-compatible", api_key)?;
    let model = model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppCommandError::configuration_missing(
                "OpenAI-compatible requires model (Settings → Translate)",
            )
        })?;
    let url = optional_endpoint(base_url, "https://api.openai.com/v1", "/chat/completions");
    let from = if source == "auto" {
        "the source language"
    } else {
        source
    };
    let prompt = format!(
        "Translate the text below from {from} to {target}.\n\n\
         Rules:\n\
         - Translate the meaning, not word order.\n\
         - Keep code, identifiers, paths, URLs and commands unchanged.\n\
         - Output only the translation.\n\n\
         Text:\n{text}"
    );
    let client = http_client(timeout)?;
    let body = serde_json::json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": "You are a professional translator. Output only the translation."
            },
            { "role": "user", "content": prompt }
        ]
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("OpenAI-compatible request failed: {e}")))?;
    let (status, body) = read_body(resp).await?;
    if !status.is_success() {
        return Err(http_err(status, &body, "OpenAI-compatible"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| AppCommandError::network(format!("OpenAI-compatible parse: {e}")))?;
    v.get("choices")
        .and_then(|x| x.as_array())
        .and_then(|arr| arr.first())
        .and_then(|x| x.get("message"))
        .and_then(|x| x.get("content"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppCommandError::network("Unexpected OpenAI-compatible response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_google_segments() {
        let body = r#"[[["你好","Hello",null,null,10]],null,"en"]"#;
        let t = parse_google_gtx_body(body).unwrap();
        assert_eq!(t, "你好");
    }
}
