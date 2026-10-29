//! GitHub 趋势仓库发现。
//!
//! 趋势源沿用 GithubStarsManager 的 GitHub Trending RSS 思路，但请求由 Rust
//! 代理，避免前端跨域和把 GitHub token 暴露给浏览器。RSS 是主数据源，GitHub
//! API 只负责尽力补充公开仓库元数据。

use std::time::Duration;

use chrono::Utc;
use futures::future::join_all;
use reqwest::Client;
use scraper::{Html, Selector};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::git::credential;
use berth_project_core::service::app_metadata_service;

const TRENDING_CACHE_PREFIX: &str = "github_trending_cache_";
const TRENDING_FEED_BASE: &str =
    "https://mshibanami.github.io/GitHubTrendingRSS/{time_range}/all.xml";
const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";
const TRENDING_LIMIT: usize = 20;
const MAX_DESCRIPTION_CHARS: usize = 280;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GithubTrendingOwner {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GithubTrendingRepo {
    pub rank: i64,
    pub name: String,
    pub full_name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub stargazers_count: Option<i64>,
    pub forks_count: Option<i64>,
    pub language: Option<String>,
    /// SPDX id，来自 API 补齐；旧缓存没有此字段
    #[serde(default)]
    pub license: Option<String>,
    pub owner: GithubTrendingOwner,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GithubTrendingResult {
    pub repos: Vec<GithubTrendingRepo>,
    pub fetched_at: String,
    pub time_range: String,
    pub rate_limit_remaining: Option<i64>,
}

pub fn trending_cache_ttl(time_range: &str) -> Duration {
    match time_range {
        "daily" => Duration::from_secs(4 * 3600),    // 4 小时
        "weekly" => Duration::from_secs(12 * 3600),  // 12 小时
        "monthly" => Duration::from_secs(24 * 3600), // 24 小时
        _ => Duration::from_secs(4 * 3600),
    }
}

pub fn is_cache_valid(cached: &GithubTrendingResult, ttl: Duration) -> bool {
    if let Ok(fetched_at) = chrono::DateTime::parse_from_rfc3339(&cached.fetched_at) {
        let age = Utc::now().signed_duration_since(fetched_at.with_timezone(&Utc));
        if age.num_seconds() < 0 {
            return true;
        }
        if let Ok(std_age) = age.to_std() {
            return std_age < ttl;
        }
    }
    false
}

/// 无 token 时存下的缓存没有 Stars / Forks / 语言（RSS 不带）；
/// 有 token 后应重新拉取补齐。只有走过 API 补齐才会记录 `rate_limit_remaining`。
pub fn needs_enrichment(cached: &GithubTrendingResult, has_token: bool) -> bool {
    has_token && cached.rate_limit_remaining.is_none()
}

async fn load_cached_trending(
    conn: &DatabaseConnection,
    cache_key: &str,
) -> Option<GithubTrendingResult> {
    let raw = app_metadata_service::get_value(conn, cache_key)
        .await
        .ok()
        .flatten()?;
    serde_json::from_str(&raw).ok()
}

async fn save_cached_trending(
    conn: &DatabaseConnection,
    cache_key: &str,
    result: &GithubTrendingResult,
) -> Result<(), AppCommandError> {
    let serialized = serde_json::to_string(result).map_err(|err| {
        AppCommandError::database_error("Failed to serialize trending cache")
            .with_detail(err.to_string())
    })?;
    app_metadata_service::upsert_value(conn, cache_key, &serialized)
        .await
        .map_err(|err| {
            AppCommandError::database_error("Failed to write trending cache")
                .with_detail(err.to_string())
        })?;
    Ok(())
}

pub async fn github_trending_core(
    conn: &DatabaseConnection,
    time_range: &str,
    force: bool,
) -> Result<GithubTrendingResult, AppCommandError> {
    let feed_url = trending_feed_url(time_range).ok_or_else(|| {
        AppCommandError::invalid_input("time_range must be daily, weekly, or monthly")
    })?;

    let cache_key = format!("{TRENDING_CACHE_PREFIX}{time_range}");
    let cached = load_cached_trending(conn, &cache_key).await;
    let token = load_optional_github_token(conn).await;

    if !force {
        if let Some(cached) = &cached {
            if is_cache_valid(cached, trending_cache_ttl(time_range))
                && !needs_enrichment(cached, token.is_some())
            {
                return Ok(cached.clone());
            }
        }
    }

    let client = build_http_client()?;
    let feed = match fetch_feed(&client, feed_url).await {
        Ok(feed) => feed,
        Err(err) => {
            // 如果拉取失败但有历史缓存（即使过期），降级返回历史缓存
            if let Some(cached) = cached {
                tracing::warn!(
                    time_range = %time_range,
                    error = %err,
                    "GitHub trending feed fetch failed; falling back to stale cache"
                );
                return Ok(cached);
            }
            return Err(err);
        }
    };

    let repos = parse_trending_feed(&feed)?;
    if repos.is_empty() {
        if let Some(cached) = cached {
            return Ok(cached);
        }
        return Err(AppCommandError::network(
            "GitHub trending feed returned no repositories",
        ));
    }

    let enriched = if token.is_some() {
        join_all(
            repos
                .into_iter()
                .map(|repo| enrich_repo(&client, repo, token.as_deref())),
        )
        .await
    } else {
        // 未配置 GitHub Token 时，不进行 20 次未认证 API 请求，避免耗尽 IP 频控（每小时 60 次）
        // RSS 数据已包含基础元数据（名称、描述、Stars、Forks、头像），直接秒级出结果
        repos
            .into_iter()
            .map(|repo| EnrichedRepo {
                repo,
                rate_limit_remaining: None,
            })
            .collect()
    };

    let rate_limit_remaining = enriched
        .iter()
        .filter_map(|result| result.rate_limit_remaining)
        .min();
    let repos = enriched.into_iter().map(|result| result.repo).collect();

    let result = GithubTrendingResult {
        repos,
        fetched_at: Utc::now().to_rfc3339(),
        time_range: time_range.to_string(),
        rate_limit_remaining,
    };

    let _ = save_cached_trending(conn, &cache_key, &result).await;

    Ok(result)
}

fn trending_feed_url(time_range: &str) -> Option<String> {
    match time_range {
        "daily" | "weekly" | "monthly" => {
            Some(TRENDING_FEED_BASE.replace("{time_range}", time_range))
        }
        _ => None,
    }
}

fn build_http_client() -> Result<Client, AppCommandError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent("berth")
        .build()
        .map_err(|err| {
            AppCommandError::network("Failed to initialize GitHub trending client")
                .with_detail(err.to_string())
        })
}

async fn fetch_feed(client: &Client, feed_url: String) -> Result<String, AppCommandError> {
    let response = client
        .get(feed_url)
        .header("Accept", "application/rss+xml, application/xml;q=0.9")
        .send()
        .await
        .map_err(|err| {
            AppCommandError::network("Failed to load GitHub trending feed")
                .with_detail(err.to_string())
        })?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppCommandError::network(format!(
            "GitHub trending feed returned {status}"
        )));
    }

    response.text().await.map_err(|err| {
        AppCommandError::network("Failed to read GitHub trending feed").with_detail(err.to_string())
    })
}

fn parse_trending_feed(feed: &str) -> Result<Vec<GithubTrendingRepo>, AppCommandError> {
    let document = Html::parse_document(feed);
    let item_selector = Selector::parse("item").expect("static RSS item selector");
    let title_selector = Selector::parse("title").expect("static RSS title selector");
    let link_selector = Selector::parse("link").expect("static RSS link selector");
    let description_selector =
        Selector::parse("description").expect("static RSS description selector");

    let mut repos = Vec::with_capacity(TRENDING_LIMIT);
    for (index, item) in document
        .select(&item_selector)
        .take(TRENDING_LIMIT)
        .enumerate()
    {
        let title = item
            .select(&title_selector)
            .next()
            .map(|node| node.text().collect::<String>())
            .unwrap_or_default();
        let link = item
            .select(&link_selector)
            .next()
            .map(|node| node.text().collect::<String>())
            .unwrap_or_default();
        let raw_description = item
            .select(&description_selector)
            .next()
            .map(|node| node.text().collect::<String>())
            .unwrap_or_default();

        let Some((owner, name)) = parse_repo_identity(&title, &link) else {
            continue;
        };
        let full_name = format!("{owner}/{name}");
        repos.push(GithubTrendingRepo {
            rank: index as i64 + 1,
            name,
            full_name: full_name.clone(),
            description: clean_feed_description(&raw_description),
            html_url: format!("https://github.com/{full_name}"),
            stargazers_count: parse_feed_metric(&raw_description, '⭐'),
            forks_count: parse_feed_metric(&raw_description, '🍴'),
            language: None,
            license: None,
            owner: GithubTrendingOwner {
                login: owner.clone(),
                avatar_url: format!("https://github.com/{owner}.png?size=64"),
            },
        });
    }

    Ok(repos)
}

fn parse_repo_identity(title: &str, link: &str) -> Option<(String, String)> {
    parse_repo_path(title).or_else(|| parse_repo_path(link))
}

fn parse_repo_path(value: &str) -> Option<(String, String)> {
    let value = value.trim();
    let value = value
        .split_once("github.com/")
        .map(|(_, path)| path)
        .unwrap_or(value);
    let value = value.split_whitespace().next()?.trim_matches('/');
    let value = value
        .split('?')
        .next()?
        .split('#')
        .next()?
        .trim_matches('/');
    let mut parts = value.split('/');
    let owner = parts.next()?.trim();
    let name = parts.next()?.trim();
    if parts.next().is_some() || !valid_repo_segment(owner) || !valid_repo_segment(name) {
        return None;
    }
    Some((owner.to_string(), name.to_string()))
}

fn valid_repo_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn clean_feed_description(raw: &str) -> Option<String> {
    let fragment = Html::parse_fragment(raw);
    let text = fragment.root_element().text().collect::<Vec<_>>().join(" ");
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }

    let mut chars = normalized.chars();
    let truncated: String = chars.by_ref().take(MAX_DESCRIPTION_CHARS).collect();
    if chars.next().is_some() {
        Some(format!("{truncated}…"))
    } else {
        Some(normalized)
    }
}

fn parse_feed_metric(raw: &str, marker: char) -> Option<i64> {
    let marker_index = raw.find(marker)? + marker.len_utf8();
    let token = raw[marker_index..].split_whitespace().next()?;
    let digits: String = token.chars().filter(|ch| ch.is_ascii_digit()).collect();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

struct EnrichedRepo {
    repo: GithubTrendingRepo,
    rate_limit_remaining: Option<i64>,
}

async fn enrich_repo(
    client: &Client,
    mut repo: GithubTrendingRepo,
    token: Option<&str>,
) -> EnrichedRepo {
    let url = format!("{GITHUB_API_BASE}/repos/{}", repo.full_name);
    let mut request = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            tracing::debug!(repository = %repo.full_name, error = %err, "GitHub trending metadata request failed");
            return EnrichedRepo {
                repo,
                rate_limit_remaining: None,
            };
        }
    };
    let rate_limit_remaining = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let status = response.status();
    if !status.is_success() {
        tracing::debug!(repository = %repo.full_name, %status, "GitHub trending metadata unavailable");
        return EnrichedRepo {
            repo,
            rate_limit_remaining,
        };
    }

    let body = match response.json::<Value>().await {
        Ok(body) => body,
        Err(err) => {
            tracing::debug!(repository = %repo.full_name, error = %err, "GitHub trending metadata response invalid");
            return EnrichedRepo {
                repo,
                rate_limit_remaining,
            };
        }
    };
    apply_repo_details(&mut repo, &body);

    EnrichedRepo {
        repo,
        rate_limit_remaining,
    }
}

fn apply_repo_details(repo: &mut GithubTrendingRepo, value: &Value) {
    repo.stargazers_count = json_i64(value, "stargazers_count").or(repo.stargazers_count);
    repo.forks_count = json_i64(value, "forks_count").or(repo.forks_count);
    if value.get("description").is_some() {
        repo.description = json_string(value, "description");
    }
    repo.language = json_string(value, "language").or(repo.language.take());
    if let Some(license) = value.get("license") {
        repo.license = crate::git::github_starred::to_license_spdx_id(license);
    }

    if let Some(owner) = value.get("owner") {
        if let Some(login) = json_string(owner, "login") {
            repo.owner.login = login;
        }
        if let Some(avatar_url) = json_string(owner, "avatar_url") {
            repo.owner.avatar_url = avatar_url;
        }
    }
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn json_i64(value: &Value, key: &str) -> Option<i64> {
    let value = value.get(key)?;
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|number| number as i64))
}

async fn load_optional_github_token(conn: &DatabaseConnection) -> Option<String> {
    let settings = credential::load_github_accounts(conn).await?;
    let account = crate::git::github_starred::pick_default_account(&settings.accounts)?;
    if crate::git::github_starred::github_api_base(&account.server_url) != GITHUB_API_BASE {
        return None;
    }
    match crate::platform::keyring_store::get_token(&account.id).await {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!("Optional GitHub credential unavailable: {error}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_url_only_accepts_supported_ranges() {
        assert_eq!(
            trending_feed_url("daily").as_deref(),
            Some("https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml")
        );
        assert_eq!(trending_feed_url("yearly"), None);
    }

    #[test]
    fn parses_rss_items_and_cleans_html_descriptions() {
        let feed = r#"
            <rss><channel>
              <item>
                <title>octo/demo</title>
                <link>https://github.com/octo/demo</link>
                <description>&lt;p&gt;A &lt;strong&gt;useful&lt;/strong&gt; project.&lt;/p&gt;</description>
              </item>
            </channel></rss>
        "#;

        let repos = parse_trending_feed(feed).expect("feed should parse");
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].rank, 1);
        assert_eq!(repos[0].full_name, "octo/demo");
        assert_eq!(repos[0].description.as_deref(), Some("A useful project."));
        assert_eq!(
            repos[0].owner.avatar_url,
            "https://github.com/octo.png?size=64"
        );
    }

    #[test]
    fn skips_malformed_repository_names() {
        let feed = r#"
            <rss><channel>
              <item><title>not-a-repository</title><link>not-a-url</link></item>
              <item><title>octo/demo</title><link>https://github.com/octo/demo</link></item>
            </channel></rss>
        "#;

        let repos = parse_trending_feed(feed).expect("feed should parse");
        assert_eq!(
            repos
                .iter()
                .map(|repo| repo.full_name.as_str())
                .collect::<Vec<_>>(),
            ["octo/demo"]
        );
        assert_eq!(repos[0].rank, 2);
    }

    #[test]
    fn parses_feed_metrics_when_present() {
        assert_eq!(parse_feed_metric("⭐ 1,234 🍴 56", '⭐'), Some(1234));
        assert_eq!(parse_feed_metric("⭐ 1,234 🍴 56", '🍴'), Some(56));
    }

    #[test]
    fn cache_ttl_matches_expected_durations() {
        assert_eq!(trending_cache_ttl("daily"), Duration::from_secs(4 * 3600));
        assert_eq!(trending_cache_ttl("weekly"), Duration::from_secs(12 * 3600));
        assert_eq!(
            trending_cache_ttl("monthly"),
            Duration::from_secs(24 * 3600)
        );
        assert_eq!(trending_cache_ttl("other"), Duration::from_secs(4 * 3600));
    }

    #[test]
    fn cache_validity_respects_ttl() {
        let fresh_result = GithubTrendingResult {
            repos: vec![],
            fetched_at: Utc::now().to_rfc3339(),
            time_range: "daily".into(),
            rate_limit_remaining: None,
        };
        assert!(is_cache_valid(&fresh_result, Duration::from_secs(60)));

        let old_result = GithubTrendingResult {
            repos: vec![],
            fetched_at: (Utc::now() - chrono::Duration::hours(5)).to_rfc3339(),
            time_range: "daily".into(),
            rate_limit_remaining: None,
        };
        assert!(!is_cache_valid(&old_result, Duration::from_secs(4 * 3600)));
    }

    #[test]
    fn unenriched_cache_refetches_once_a_token_exists() {
        let mut result = GithubTrendingResult {
            repos: vec![],
            fetched_at: Utc::now().to_rfc3339(),
            time_range: "weekly".into(),
            rate_limit_remaining: None,
        };
        assert!(needs_enrichment(&result, true));
        assert!(!needs_enrichment(&result, false));
        result.rate_limit_remaining = Some(4900);
        assert!(!needs_enrichment(&result, true));
    }
}
