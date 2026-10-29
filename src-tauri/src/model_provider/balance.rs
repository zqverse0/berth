//! 模型服务商余额查询(声明驱动)。
//!
//! 内置站点模板(`balance_templates.json`,与 usage.json 同构)按 api_url 的
//! host 匹配,合成 `credential.kind = "provider-key"` 声明后复用同模块的
//! `usage::execute`——余额查询与 agent 用量共用同一执行器,新增站点
//! 只改模板数据(内置)或落一个用户声明(provider-usage/),零代码。
//! 不识别具体服务商。
//!
//! 凭据(token)是档案的 api_key,由调用方传入;模板与声明文件都不落 key。

use serde::Deserialize;

use super::usage::{self, UsageDeclaration, UsageState};

const TEMPLATES_JSON: &str = include_str!("balance_templates.json");

/// 站点模板:匹配规则 + 与 `UsageDeclaration` 同构的声明子对象。
///
/// 不用 serde flatten——它与 `deny_unknown_fields` 冲突;独立字段直接内嵌。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BalanceTemplate {
    id: String,
    match_hosts: Vec<String>,
    declaration: UsageDeclaration,
}

fn load_templates() -> Result<Vec<BalanceTemplate>, String> {
    let mut templates: Vec<BalanceTemplate> =
        serde_json::from_str(TEMPLATES_JSON).map_err(|error| error.to_string())?;
    // 用户声明目录(provider-usage/<id>.json,与内置同构):同 id 覆盖内置,
    // 新 id 追加——加站点零代码,落一个文件即可。坏文件跳过,不拖垮内置模板。
    let root = crate::platform::paths::provider_usage_root();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            match serde_json::from_slice::<BalanceTemplate>(&bytes) {
                Ok(template) => {
                    templates.retain(|existing| existing.id != template.id);
                    templates.push(template);
                }
                Err(error) => {
                    tracing::warn!(
                        "[balance] skip invalid provider usage declaration {}: {error}",
                        path.display()
                    );
                }
            }
        }
    }
    Ok(templates)
}

/// 按档案的 api_url 匹配模板并执行余额查询。
///
/// `Err` = 瞬时传输失败(重试语义);无匹配模板 → `Ok(unavailable)`
/// (确定性结果,前端显示"该站点暂不支持");key 为空 → `Ok(missing)`。
pub async fn query(api_url: &str, api_key: &str) -> Result<UsageState, String> {
    let url = api_url.trim();
    if url.is_empty() {
        return Err("api url must not be empty".to_string());
    }
    let templates = load_templates()?;
    let lowered = url.to_lowercase();
    let matched = templates.iter().find(|template| {
        template
            .match_hosts
            .iter()
            .any(|host| lowered.contains(host))
    });
    let Some(template) = matched else {
        return Ok(unsupported_site_state());
    };
    // 模板 credential 块只是 serde 形状占位;执行时替换为 provider-key
    // (token = 档案 api_key),声明文件与模板都不携带凭据。
    let mut declaration = template.declaration.clone();
    declaration.credential.kind = "provider-key".to_string();
    declaration.credential.path = None;
    declaration.credential.token_pointer = None;
    declaration.credential.header_pointers.clear();
    usage::execute(&template.id, &declaration, Some(api_key)).await
}

fn unsupported_site_state() -> UsageState {
    let mut state = UsageState::new("unsupported", usage::UsageStatus::Unavailable);
    state.diagnostics.push(usage::UsageDiagnostic {
        severity: "info".to_string(),
        message: "no balance template for this site".to_string(),
    });
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::path::TEST_ENV_LOCK;
    use std::path::PathBuf;

    /// 同步 env 沙箱(launchbar 测试同款锁):临时 BERTH_HOME 指向
    /// provider-usage/<id>.json 的用户声明目录。
    fn with_temp_user_declarations(test: impl FnOnce(PathBuf)) {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        let dir = std::env::temp_dir().join(format!("balance-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("provider-usage")).unwrap();
        std::env::set_var("BERTH_HOME", &dir);
        test(dir.clone());
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_declarations_override_builtin_and_add_sites() {
        with_temp_user_declarations(|dir| {
            // 覆盖内置 deepseek(url 换掉) + 新增自定义站点;一文件一个声明。
            std::fs::write(
                dir.join("provider-usage/deepseek.json"),
                serde_json::to_string(&serde_json::json!({
                    "id": "deepseek",
                    "matchHosts": ["api.deepseek.com"],
                    "declaration": {
                        "credential": {"kind": "json-file", "tokenPointer": "/unused"},
                        "request": {"method": "GET", "url": "https://api.deepseek.com/custom/balance"},
                        "windows": [{"id": "balance", "label": "Balance", "remainingPointers": ["/total"]}]
                    }
                }))
                .unwrap(),
            )
            .unwrap();
            std::fs::write(
                dir.join("provider-usage/mysite.json"),
                serde_json::to_string(&serde_json::json!({
                    "id": "mysite",
                    "matchHosts": ["api.mysite.example"],
                    "declaration": {
                        "credential": {"kind": "json-file", "tokenPointer": "/unused"},
                        "request": {"method": "GET", "url": "https://api.mysite.example/balance"},
                        "windows": [{"id": "balance", "label": "Balance", "remainingPointers": ["/credit"]}]
                    }
                }))
                .unwrap(),
            )
            .unwrap();

            let templates = load_templates().unwrap();
            let deepseek = templates.iter().find(|t| t.id == "deepseek").unwrap();
            assert_eq!(
                deepseek.declaration.request.url, "https://api.deepseek.com/custom/balance",
                "用户声明应覆盖内置同 id 模板"
            );
            assert!(
                templates.iter().any(|t| t.id == "mysite"),
                "用户声明应新增站点"
            );
        });
    }

    #[test]
    fn invalid_user_declaration_is_skipped() {
        with_temp_user_declarations(|dir| {
            std::fs::write(dir.join("provider-usage/bad.json"), b"{ not json").unwrap();
            let templates = load_templates().unwrap();
            assert!(templates.iter().all(|t| t.id != "bad"));
            // 内置模板不受坏文件影响。
            assert!(templates.iter().any(|t| t.id == "deepseek"));
        });
    }

    #[test]
    fn templates_parse_and_declare_https_get() {
        let templates = load_templates().unwrap();
        assert!(templates.len() >= 6);
        for template in &templates {
            assert!(!template.id.is_empty());
            assert!(!template.match_hosts.is_empty());
            assert_eq!(template.declaration.request.method, "GET");
            assert!(template.declaration.request.url.starts_with("https://"));
            assert!(!template.declaration.windows.is_empty());
            assert_eq!(
                template.declaration.credential.kind, "json-file",
                "模板里的 credential 占位必须是合法 kind(执行前由本模块替换为 provider-key)"
            );
        }
    }

    #[test]
    fn host_matching_is_case_insensitive_and_prefix_free() {
        let templates = load_templates().unwrap();
        let find = |url: &str| {
            let lowered = url.to_lowercase();
            templates
                .iter()
                .find(|template| {
                    template
                        .match_hosts
                        .iter()
                        .any(|host| lowered.contains(host))
                })
                .map(|template| template.id.as_str())
        };
        assert_eq!(find("https://API.DEEPSEEK.com/v1"), Some("deepseek"));
        assert_eq!(
            find("https://api.siliconflow.cn/v1/chat/completions"),
            Some("siliconflow-cn")
        );
        assert_eq!(
            find("https://api.siliconflow.com/v1/chat/completions"),
            Some("siliconflow-en")
        );
        assert_eq!(find("https://api.novita.ai/v3"), Some("novita"));
        assert_eq!(find("https://unknown.example.com/v1"), None);
    }

    #[tokio::test]
    async fn unsupported_site_is_unavailable_not_an_error() {
        let state = query("https://unknown.example.com/v1", "sk-x")
            .await
            .unwrap();
        assert_eq!(state.status, usage::UsageStatus::Unavailable);
        assert!(state.subject != "unsupported" || !state.diagnostics.is_empty());
    }

    #[tokio::test]
    async fn empty_url_is_rejected() {
        assert!(query("   ", "sk-x").await.is_err());
    }
}
