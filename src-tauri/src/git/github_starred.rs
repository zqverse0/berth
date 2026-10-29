//! GitHub 星标同步：移植 GithubStarsManager 的 starred / README / merge。
//! Token 只在本模块内从 keyring 读取，不回传前端。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use base64::Engine;
use chrono::Utc;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::git::credential;
use crate::models::system::GitHubAccount;
use berth_project_core::service::app_metadata_service;

const STARRED_CACHE_KEY: &str = "github_starred_cache";
const STARRED_PER_PAGE: u32 = 100;
const PAGE_DELAY_MS: u64 = 100;
const GITHUB_API_VERSION: &str = "2022-11-28";
const MAX_RETRIES: u32 = 3;

/// github.com → api.github.com；企业实例 → `{url}/api/v3`。
pub fn github_api_base(server_url: &str) -> String {
    let trimmed = server_url.trim().trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("https://github.com")
        || trimmed.eq_ignore_ascii_case("http://github.com")
    {
        "https://api.github.com".to_string()
    } else {
        format!("{trimmed}/api/v3")
    }
}

/// GitHub license 对象 / 字符串 → SPDX id。移植 `githubApi.ts` `toLicenseSpdxId`。
pub fn to_license_spdx_id(license: &Value) -> Option<String> {
    if license.is_null() {
        return None;
    }
    if let Some(s) = license.as_str() {
        let trimmed = s.trim();
        return if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
    if let Some(obj) = license.as_object() {
        let spdx = obj
            .get("spdx_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(spdx) = spdx {
            return Some(spdx.to_string());
        }
        let key = obj
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        return key.map(str::to_string);
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GithubStarredOwner {
    pub login: String,
    #[serde(default)]
    pub avatar_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GithubStarredRepo {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub clone_url: Option<String>,
    #[serde(default)]
    pub stargazers_count: i64,
    #[serde(default)]
    pub forks_count: i64,
    pub language: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub pushed_at: Option<String>,
    pub starred_at: Option<String>,
    pub owner: GithubStarredOwner,
    #[serde(default)]
    pub topics: Vec<String>,
    pub license: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GithubStarredCache {
    pub account_id: String,
    pub synced_at: String,
    #[serde(default)]
    pub repos: Vec<GithubStarredRepo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GithubStarredResult {
    pub repos: Vec<GithubStarredRepo>,
    pub synced_at: Option<String>,
    pub account_id: Option<String>,
    pub readme: Option<String>,
    pub rate_limit_remaining: Option<i64>,
}

/// README content API 的 base64 解码。移植 `decodeContentResponse`。
pub fn decode_readme_content(encoding: Option<&str>, content: Option<&str>) -> String {
    let raw = content.unwrap_or_default();
    if encoding == Some("base64") && !raw.is_empty() {
        let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(compact) {
            return String::from_utf8_lossy(&bytes).into_owned();
        }
    }
    raw.to_string()
}

/// 解包 `application/vnd.github.star+json`：`{ starred_at, repo }` 或裸 repo。
pub fn parse_starred_item(value: &Value) -> Option<GithubStarredRepo> {
    if let Some(repo) = value.get("repo") {
        let starred_at = json_string(value, "starred_at");
        return parse_repo(repo, starred_at);
    }
    parse_repo(value, json_string(value, "starred_at"))
}

/// 只增不删 merge。移植 `handleStarSync`：按 id 更新 GitHub 字段，不删本地已有。
pub fn merge_starred(
    existing: &[GithubStarredRepo],
    incoming: &[GithubStarredRepo],
) -> Vec<GithubStarredRepo> {
    let mut map: HashMap<i64, GithubStarredRepo> = existing
        .iter()
        .cloned()
        .map(|repo| (repo.id, repo))
        .collect();
    let mut order: Vec<i64> = Vec::new();
    for repo in incoming {
        if let Some(prev) = map.get_mut(&repo.id) {
            prev.name = repo.name.clone();
            prev.full_name = repo.full_name.clone();
            prev.description = repo.description.clone();
            prev.html_url = repo.html_url.clone();
            prev.clone_url = repo.clone_url.clone();
            prev.stargazers_count = repo.stargazers_count;
            prev.forks_count = repo.forks_count;
            prev.language = repo.language.clone();
            prev.created_at = repo.created_at.clone();
            prev.updated_at = repo.updated_at.clone();
            prev.pushed_at = repo.pushed_at.clone();
            prev.starred_at = repo.starred_at.clone();
            prev.owner = repo.owner.clone();
            prev.topics = repo.topics.clone();
            prev.license = repo.license.clone();
            prev.archived = repo.archived;
        } else {
            map.insert(repo.id, repo.clone());
        }
        if !order.contains(&repo.id) {
            order.push(repo.id);
        }
    }
    // 未出现在 incoming 的本地记录跟在后面（只增不删）
    for repo in existing {
        if !order.contains(&repo.id) {
            order.push(repo.id);
        }
    }
    order.into_iter().filter_map(|id| map.remove(&id)).collect()
}

pub fn pick_default_account(accounts: &[GitHubAccount]) -> Option<&GitHubAccount> {
    accounts
        .iter()
        .find(|a| a.is_default)
        .or_else(|| accounts.first())
}

pub async fn github_starred_core(
    conn: &DatabaseConnection,
    op: &str,
    owner: Option<&str>,
    name: Option<&str>,
) -> Result<GithubStarredResult, AppCommandError> {
    match op {
        "list" => list_cached(conn).await,
        "sync" => sync_starred(conn).await,
        "readme" => {
            let owner = owner
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppCommandError::invalid_input("owner is required"))?;
            let name = name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppCommandError::invalid_input("name is required"))?;
            fetch_readme_for_account(conn, owner, name).await
        }
        "star" => {
            let owner = owner
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppCommandError::invalid_input("owner is required"))?;
            let name = name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppCommandError::invalid_input("name is required"))?;
            toggle_star_for_account(conn, owner, name, true).await
        }
        "unstar" => {
            let owner = owner
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppCommandError::invalid_input("owner is required"))?;
            let name = name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppCommandError::invalid_input("name is required"))?;
            toggle_star_for_account(conn, owner, name, false).await
        }
        _ => Err(AppCommandError::invalid_input(format!(
            "Unknown github_starred op: {op}"
        ))),
    }
}

async fn toggle_star_for_account(
    conn: &DatabaseConnection,
    owner: &str,
    name: &str,
    star: bool,
) -> Result<GithubStarredResult, AppCommandError> {
    let account = require_account(conn).await?;
    let token = require_token(&account.id).await?;
    let api_base = github_api_base(&account.server_url);
    let path = format!("/user/starred/{owner}/{name}");
    let url = format!("{api_base}{path}");
    let client = reqwest::Client::new();
    let mut request = if star {
        client.put(&url).header("Content-Length", "0")
    } else {
        client.delete(&url)
    };
    request = request
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "berth")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);

    let response = request.send().await.map_err(|err| {
        AppCommandError::network("Failed to update GitHub star").with_detail(err.to_string())
    })?;
    let status = response.status();
    if !status.is_success() && status.as_u16() != 204 {
        return Err(AppCommandError::network(format!(
            "GitHub star request returned {status}"
        )));
    }

    // 更新本地缓存
    if let Ok(Some(mut cached)) = load_cache(conn).await {
        if cached.account_id == account.id {
            let full_name = format!("{owner}/{name}");
            if !star {
                cached
                    .repos
                    .retain(|r| !r.full_name.eq_ignore_ascii_case(&full_name));
            }
            let _ = save_cache(conn, &cached).await;
        }
    }
    list_cached(conn).await
}

async fn list_cached(conn: &DatabaseConnection) -> Result<GithubStarredResult, AppCommandError> {
    let cache = load_cache(conn).await?;
    Ok(GithubStarredResult {
        repos: cache.as_ref().map(|c| c.repos.clone()).unwrap_or_default(),
        synced_at: cache.as_ref().map(|c| c.synced_at.clone()),
        account_id: cache.as_ref().map(|c| c.account_id.clone()),
        readme: None,
        rate_limit_remaining: None,
    })
}

async fn sync_starred(conn: &DatabaseConnection) -> Result<GithubStarredResult, AppCommandError> {
    let account = require_account(conn).await?;
    let token = require_token(&account.id).await?;
    let api_base = github_api_base(&account.server_url);
    let cache = load_cache(conn).await?;
    let known_ids: HashSet<i64> = match &cache {
        Some(cached) if cached.account_id == account.id => {
            cached.repos.iter().map(|r| r.id).collect()
        }
        _ => HashSet::new(),
    };
    let (incoming, remaining) = fetch_starred_incremental(&api_base, &token, &known_ids).await?;
    let merged = match cache {
        Some(cached) if cached.account_id == account.id => merge_starred(&cached.repos, &incoming),
        _ => incoming,
    };
    let synced_at = Utc::now().to_rfc3339();
    let next = GithubStarredCache {
        account_id: account.id.clone(),
        synced_at: synced_at.clone(),
        repos: merged,
    };
    save_cache(conn, &next).await?;
    Ok(GithubStarredResult {
        repos: next.repos,
        synced_at: Some(synced_at),
        account_id: Some(account.id),
        readme: None,
        rate_limit_remaining: remaining,
    })
}

async fn fetch_readme_for_account(
    conn: &DatabaseConnection,
    owner: &str,
    name: &str,
) -> Result<GithubStarredResult, AppCommandError> {
    let account = require_account(conn).await?;
    let token = require_token(&account.id).await?;
    let api_base = github_api_base(&account.server_url);
    let (readme, remaining) = fetch_repository_readme(&api_base, &token, owner, name).await?;
    Ok(GithubStarredResult {
        repos: Vec::new(),
        synced_at: None,
        account_id: Some(account.id),
        readme: Some(readme),
        rate_limit_remaining: remaining,
    })
}

async fn require_account(conn: &DatabaseConnection) -> Result<GitHubAccount, AppCommandError> {
    let settings = credential::load_github_accounts(conn)
        .await
        .unwrap_or_default();
    pick_default_account(&settings.accounts)
        .cloned()
        .ok_or_else(|| {
            AppCommandError::not_found("No GitHub account configured. Add one in Version Control.")
        })
}

async fn require_token(account_id: &str) -> Result<String, AppCommandError> {
    crate::platform::keyring_store::get_token(account_id)
        .await
        .map_err(AppCommandError::io_error)?
        .ok_or_else(|| {
            AppCommandError::authentication_failed(
                "GitHub token not found in keyring. Re-add the account in Version Control.",
            )
        })
}

async fn load_cache(
    conn: &DatabaseConnection,
) -> Result<Option<GithubStarredCache>, AppCommandError> {
    let raw = app_metadata_service::get_value(conn, STARRED_CACHE_KEY)
        .await
        .map_err(AppCommandError::from)?;
    match raw {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).map_err(|e| {
            AppCommandError::configuration_invalid("Failed to parse starred cache")
                .with_detail(e.to_string())
        }),
        _ => Ok(None),
    }
}

async fn save_cache(
    conn: &DatabaseConnection,
    cache: &GithubStarredCache,
) -> Result<(), AppCommandError> {
    let serialized = serde_json::to_string(cache).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize starred cache")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, STARRED_CACHE_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;
    Ok(())
}

async fn fetch_starred_incremental(
    api_base: &str,
    token: &str,
    known_ids: &HashSet<i64>,
) -> Result<(Vec<GithubStarredRepo>, Option<i64>), AppCommandError> {
    let mut all = Vec::new();
    let mut page = 1u32;
    #[allow(unused_assignments)]
    let mut remaining: Option<i64> = None;
    loop {
        let path = format!(
            "/user/starred?page={page}&per_page={STARRED_PER_PAGE}&sort=created&direction=desc"
        );
        let response =
            github_request(api_base, token, &path, "application/vnd.github.star+json").await?;
        remaining = response.rate_remaining;
        let items = response
            .json
            .as_array()
            .ok_or_else(|| AppCommandError::network("GitHub starred response was not an array"))?;
        if items.is_empty() {
            break;
        }

        let mut hit_known_count = 0;
        let batch_len = items.len();

        for item in items {
            if let Some(repo) = parse_starred_item(item) {
                if known_ids.contains(&repo.id) {
                    hit_known_count += 1;
                }
                all.push(repo);
            }
        }

        // 如果本页拉取的数据大部分/全部都是本地已缓存的仓库，说明已经与历史记录对齐，无需继续翻页
        if !known_ids.is_empty() && hit_known_count >= 10 {
            break;
        }

        if batch_len < STARRED_PER_PAGE as usize {
            break;
        }
        page += 1;
        tokio::time::sleep(Duration::from_millis(PAGE_DELAY_MS)).await;
    }
    Ok((all, remaining))
}

async fn fetch_repository_readme(
    api_base: &str,
    token: &str,
    owner: &str,
    name: &str,
) -> Result<(String, Option<i64>), AppCommandError> {
    let owner_enc = urlencoding::encode(owner);
    let name_enc = urlencoding::encode(name);
    let path = format!("/repos/{owner_enc}/{name_enc}/readme");
    match github_request(api_base, token, &path, "application/vnd.github+json").await {
        Ok(response) => {
            let encoding = response.json.get("encoding").and_then(Value::as_str);
            let content = response.json.get("content").and_then(Value::as_str);
            Ok((
                decode_readme_content(encoding, content),
                response.rate_remaining,
            ))
        }
        Err(err) if err.code == crate::app_error::AppErrorCode::NotFound => {
            Ok((String::new(), None))
        }
        Err(err) => Err(err),
    }
}

struct GithubHttpResponse {
    json: Value,
    rate_remaining: Option<i64>,
}

async fn github_request(
    api_base: &str,
    token: &str,
    path: &str,
    accept: &str,
) -> Result<GithubHttpResponse, AppCommandError> {
    let url = format!("{api_base}{path}");
    let client = reqwest::Client::new();
    let mut last_network: Option<String> = None;
    for attempt in 0..=MAX_RETRIES {
        let response = match client
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("User-Agent", "berth")
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                last_network = Some(err.to_string());
                if attempt == MAX_RETRIES {
                    break;
                }
                sleep_backoff(attempt).await;
                continue;
            }
        };

        let remaining = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok());
        let reset = response
            .headers()
            .get("x-ratelimit-reset")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok());
        let status = response.status();

        if status.is_success() {
            if status.as_u16() == 204 {
                return Ok(GithubHttpResponse {
                    json: Value::Null,
                    rate_remaining: remaining,
                });
            }
            let json = response.json::<Value>().await.map_err(|e| {
                AppCommandError::network("Failed to parse GitHub API response")
                    .with_detail(e.to_string())
            })?;
            return Ok(GithubHttpResponse {
                json,
                rate_remaining: remaining,
            });
        }

        if status.as_u16() == 401 {
            return Err(AppCommandError::authentication_failed(
                "GitHub token expired or invalid. Test the connection in Version Control.",
            ));
        }
        if status.as_u16() == 403 && remaining == Some(0) {
            let reset_text = reset
                .and_then(|ts| chrono::DateTime::<Utc>::from_timestamp(ts, 0))
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "unknown".to_string());
            return Err(AppCommandError::network(format!(
                "GitHub API rate limit exceeded. Resets at {reset_text}"
            )));
        }
        if status.as_u16() == 404 {
            return Err(AppCommandError::not_found("GitHub resource not found"));
        }

        let retryable = status.is_server_error();
        if !retryable || attempt == MAX_RETRIES {
            let body = response.text().await.unwrap_or_default();
            return Err(
                AppCommandError::network(format!("GitHub API error: {status}")).with_detail(body),
            );
        }
        sleep_backoff(attempt).await;
    }
    Err(AppCommandError::network("Failed to connect to GitHub API")
        .with_detail(last_network.unwrap_or_default()))
}

async fn sleep_backoff(attempt: u32) {
    let delay_ms = (1000u64 * 2u64.pow(attempt)).min(4000);
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

fn parse_repo(value: &Value, starred_at: Option<String>) -> Option<GithubStarredRepo> {
    let id = json_i64(value, "id")?;
    let name = json_string(value, "name")?;
    let full_name = json_string(value, "full_name")?;
    let html_url =
        json_string(value, "html_url").unwrap_or_else(|| format!("https://github.com/{full_name}"));
    let owner_val = value.get("owner");
    let login = owner_val
        .and_then(|o| json_string(o, "login"))
        .unwrap_or_else(|| full_name.split('/').next().unwrap_or("unknown").to_string());
    let avatar_url = owner_val
        .and_then(|o| json_string(o, "avatar_url"))
        .unwrap_or_default();
    let topics = value
        .get("topics")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let license = value.get("license").and_then(to_license_spdx_id);
    Some(GithubStarredRepo {
        id,
        name,
        full_name,
        description: json_string(value, "description"),
        html_url,
        clone_url: json_string(value, "clone_url"),
        stargazers_count: json_i64(value, "stargazers_count").unwrap_or(0),
        forks_count: json_i64(value, "forks_count").unwrap_or(0),
        language: json_string(value, "language"),
        created_at: json_string(value, "created_at"),
        updated_at: json_string(value, "updated_at"),
        pushed_at: json_string(value, "pushed_at"),
        starred_at,
        owner: GithubStarredOwner { login, avatar_url },
        topics,
        license,
        archived: value
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn json_i64(value: &Value, key: &str) -> Option<i64> {
    let v = value.get(key)?;
    v.as_i64()
        .or_else(|| v.as_u64().map(|n| n as i64))
        .or_else(|| v.as_f64().map(|n| n as i64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn api_base_github_dot_com() {
        assert_eq!(
            github_api_base("https://github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            github_api_base("https://github.com/"),
            "https://api.github.com"
        );
        assert_eq!(github_api_base(""), "https://api.github.com");
    }

    #[test]
    fn api_base_enterprise() {
        assert_eq!(
            github_api_base("https://github.example.com"),
            "https://github.example.com/api/v3"
        );
    }

    #[test]
    fn license_from_object_prefers_spdx() {
        let v = json!({"key": "mit", "spdx_id": "MIT"});
        assert_eq!(to_license_spdx_id(&v).as_deref(), Some("MIT"));
    }

    #[test]
    fn license_from_string_and_null() {
        assert_eq!(
            to_license_spdx_id(&json!("Apache-2.0")).as_deref(),
            Some("Apache-2.0")
        );
        assert_eq!(to_license_spdx_id(&Value::Null), None);
        assert_eq!(to_license_spdx_id(&json!("  ")), None);
    }

    #[test]
    fn unwraps_star_plus_json_envelope() {
        let v = json!({
            "starred_at": "2024-01-02T00:00:00Z",
            "repo": {
                "id": 42,
                "name": "alpha",
                "full_name": "acme/alpha",
                "html_url": "https://github.com/acme/alpha",
                "clone_url": "https://github.com/acme/alpha.git",
                "stargazers_count": 9,
                "forks_count": 1,
                "language": "Rust",
                "owner": {"login": "acme", "avatar_url": "https://example.com/a.png"},
                "topics": ["cli"],
                "license": {"spdx_id": "MIT", "key": "mit"},
                "archived": false
            }
        });
        let repo = parse_starred_item(&v).expect("repo");
        assert_eq!(repo.id, 42);
        assert_eq!(repo.starred_at.as_deref(), Some("2024-01-02T00:00:00Z"));
        assert_eq!(repo.license.as_deref(), Some("MIT"));
        assert_eq!(
            repo.clone_url.as_deref(),
            Some("https://github.com/acme/alpha.git")
        );
    }

    #[test]
    fn merge_updates_github_fields_and_keeps_local_only() {
        let existing = vec![
            parse_starred_item(&json!({
                "id": 1,
                "name": "old",
                "full_name": "acme/old",
                "html_url": "https://github.com/acme/old",
                "stargazers_count": 1,
                "owner": {"login": "acme"}
            }))
            .unwrap(),
            parse_starred_item(&json!({
                "id": 2,
                "name": "kept",
                "full_name": "acme/kept",
                "html_url": "https://github.com/acme/kept",
                "stargazers_count": 3,
                "owner": {"login": "acme"}
            }))
            .unwrap(),
        ];
        let incoming = vec![parse_starred_item(&json!({
            "id": 1,
            "name": "new",
            "full_name": "acme/new",
            "html_url": "https://github.com/acme/new",
            "stargazers_count": 8,
            "owner": {"login": "acme"}
        }))
        .unwrap()];
        let merged = merge_starred(&existing, &incoming);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "new");
        assert_eq!(merged[0].stargazers_count, 8);
        assert_eq!(merged[1].name, "kept");
    }

    #[test]
    fn merge_incremental_starred() {
        let existing = vec![
            parse_starred_item(&json!({
                "id": 1,
                "name": "repo1",
                "full_name": "acme/repo1",
                "html_url": "https://github.com/acme/repo1",
                "stargazers_count": 10,
                "owner": {"login": "acme"}
            }))
            .unwrap(),
            parse_starred_item(&json!({
                "id": 2,
                "name": "repo2",
                "full_name": "acme/repo2",
                "html_url": "https://github.com/acme/repo2",
                "stargazers_count": 20,
                "owner": {"login": "acme"}
            }))
            .unwrap(),
        ];
        let incoming = vec![
            parse_starred_item(&json!({
                "id": 3,
                "name": "repo3-new",
                "full_name": "acme/repo3-new",
                "html_url": "https://github.com/acme/repo3-new",
                "stargazers_count": 1,
                "owner": {"login": "acme"}
            }))
            .unwrap(),
            parse_starred_item(&json!({
                "id": 1,
                "name": "repo1",
                "full_name": "acme/repo1",
                "html_url": "https://github.com/acme/repo1",
                "stargazers_count": 15,
                "owner": {"login": "acme"}
            }))
            .unwrap(),
        ];
        let merged = merge_starred(&existing, &incoming);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].id, 3);
        assert_eq!(merged[1].id, 1);
        assert_eq!(merged[1].stargazers_count, 15);
        assert_eq!(merged[2].id, 2);
    }

    #[test]
    fn readme_base64_utf8() {
        let encoded = base64::engine::general_purpose::STANDARD.encode("# 你好\n");
        let decoded = decode_readme_content(Some("base64"), Some(&format!("{encoded}\n")));
        assert_eq!(decoded, "# 你好\n");
    }
}
