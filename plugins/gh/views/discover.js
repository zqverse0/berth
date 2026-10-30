// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 发现：GitHub 趋势（GitHubTrendingRSS，下拉选今天 / 本周 / 本月）与自己的星标（gh api）。
// 两者都缓存在 storage：切换时直接返回，刷新才重拉；加星 / 取消星标由 star.js 就地更新缓存。

import {
  gh,
  RANGES,
  repoItem,
  STARS_KEY,
  strings,
  trendingKey,
} from "./common.js"

const FEED = "https://mshibanami.github.io/GitHubTrendingRSS/{range}/all.xml"
// 与内置发现相同的缓存时长：今天 4 小时、本周 12 小时、本月 24 小时。
const HOUR = 3600 * 1000
const TRENDING_TTL_MS = {
  daily: 4 * HOUR,
  weekly: 12 * HOUR,
  monthly: 24 * HOUR,
}
const LIMIT = 25

/** @type {import("berth").ViewHooks} */
export default {
  async render(req) {
    const s = strings(req.locale)
    const filters = [
      { id: "trending", title: s.trending },
      { id: "stars", title: s.stars },
    ]
    if (req.filter === "stars") {
      const repos = await starred(req.refresh)
      return {
        type: "list",
        filters,
        searchable: true,
        items: repos.map((repo) => repoItem(repo, s)),
        empty: s.starsEmpty,
      }
    }
    const range = RANGES.find((id) => id === req.dropdown) ?? "daily"
    const { at, repos } = await trending(range, req.refresh)
    return {
      type: "list",
      filters,
      dropdown: { items: RANGES.map((id) => ({ id, title: s[id] })) },
      note: s.updated(Math.floor((Date.now() - at) / 60_000)),
      items: repos.map((repo) => repoItem(repo, s)),
      empty: s.trendingEmpty,
    }
  },
}

/** @returns {Promise<import("./common.js").Repo[]>} */
async function starred(/** @type {boolean} */ refresh) {
  const cached = refresh ? undefined : await berth.storage.get(STARS_KEY)
  if (Array.isArray(cached)) return cached
  const out = await gh([
    "api",
    "user/starred?per_page=100",
    "--paginate",
    "--jq",
    ".[] | {full_name, description, stars: .stargazers_count, forks: .forks_count, language}",
  ])
  const repos = out
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ ...JSON.parse(line), starred: true }))
  await berth.storage.set(STARS_KEY, repos)
  return repos
}

/**
 * @param {"daily" | "weekly" | "monthly"} range
 * @param {boolean} refresh
 * @returns {Promise<{ at: number, repos: import("./common.js").Repo[] }>}
 */
async function trending(range, refresh) {
  const key = trendingKey(range)
  /** @type {{ at: number, repos: import("./common.js").Repo[] } | undefined} */
  const cached = await berth.storage.get(key)
  if (!refresh && cached && Date.now() - cached.at < TRENDING_TTL_MS[range]) {
    return cached
  }
  const response = await berth.http.fetch(FEED.replace("{range}", range))
  if (response.status !== 200) {
    throw new Error(`GitHub trending feed: HTTP ${response.status}`)
  }
  const fresh = {
    at: Date.now(),
    repos: await enrich(parseFeed(response.text)),
  }
  await berth.storage.set(key, fresh)
  return fresh
}

/** RSS 的 item → 仓库名与简介（简介取第一段文字）。 */
function parseFeed(/** @type {string} */ xml) {
  const repos = []
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(item)?.[1]?.trim() ?? ""
    if (!/^[\w.-]+\/[\w.-]+$/.test(title)) continue
    const html = unescape(
      /<description>([\s\S]*?)<\/description>/.exec(item)?.[1] ?? ""
    )
    const first = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ""
    const text = unescape(first.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
    repos.push({ full_name: title, description: text || null })
    if (repos.length >= LIMIT) break
  }
  return repos
}

function unescape(/** @type {string} */ text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * 一次 GraphQL 补全星标数、Fork 数、语言与我是否已加星；gh 未登录或失败时只显示名称与简介。
 * @param {{ full_name: string, description: string | null }[]} repos
 */
async function enrich(repos) {
  const fields = repos
    .map((repo, i) => {
      const [owner, name] = repo.full_name.split("/")
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount forkCount primaryLanguage { name } viewerHasStarred }`
    })
    .join("\n")
  /** @type {Record<string, any>} */
  let data = {}
  try {
    data =
      JSON.parse(await gh(["api", "graphql", "-f", `query={ ${fields} }`]))
        .data ?? {}
  } catch {
    // 未登录 gh 或限流：降级为不带数字的列表。
  }
  return repos.map((repo, i) => {
    const info = data[`r${i}`]
    return {
      ...repo,
      stars: info?.stargazerCount ?? null,
      forks: info?.forkCount ?? null,
      language: info?.primaryLanguage?.name ?? null,
      starred: info ? Boolean(info.viewerHasStarred) : null,
    }
  })
}
