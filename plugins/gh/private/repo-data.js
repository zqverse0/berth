// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 仓库可视化详情的数据脚本：经 `berth.scripts.run("private/repo-data.js", { repo })` 调用。
// 优先走 `gh api`（支持登录态高配额与私有仓库）；gh 不可用或未登录时自动回退到公开 GitHub API。

import { gh, repoName } from "../views/common.js"

const API_BASE = "https://api.github.com"

/** 调 GitHub API 返回文本；优先 gh，失败回退 berth.http.fetch。 */
async function apiText(
  /** @type {string} */ endpoint,
  /** @type {string} */ accept = "application/vnd.github+json"
) {
  try {
    return await gh(["api", endpoint, "-H", `Accept: ${accept}`])
  } catch {
    const res = await berth.http.fetch(`${API_BASE}/${endpoint}`, {
      headers: {
        Accept: accept,
        "User-Agent": "Berth-GH-Plugin",
      },
      timeoutMs: 20_000,
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub API ${endpoint}: HTTP ${res.status}`)
    }
    return res.text
  }
}

/** @returns {Promise<any>} */
async function apiJson(/** @type {string} */ endpoint) {
  return JSON.parse(await apiText(endpoint))
}

/** @returns {Promise<boolean | null>} */
async function checkStarred(/** @type {string} */ repo) {
  try {
    const { code } = await berth.process.exec(
      "gh",
      ["api", `user/starred/${repo}`],
      { timeoutMs: 10_000 }
    )
    if (code === 0) return true
    if (code === 1) return false
    return null
  } catch {
    return null
  }
}

/**
 * 清洗 GitHub 渲染后的 README HTML：移除脚本/样式/内联事件/危险协议，
 * 并把相对图片与链接补全为 GitHub 绝对地址。
 */
function sanitizeReadmeHtml(
  /** @type {string} */ html,
  /** @type {string} */ repo,
  /** @type {string} */ branch
) {
  const safeBranch = encodeURIComponent(branch || "HEAD")
  const isRelative = (/** @type {string} */ url) =>
    Boolean(url) && !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)
  const rawUrl = (/** @type {string} */ url) =>
    `https://raw.githubusercontent.com/${repo}/${safeBranch}/${url.replace(/^\.?\//, "")}`
  const blobUrl = (/** @type {string} */ url) =>
    `https://github.com/${repo}/blob/${safeBranch}/${url.replace(/^\.?\//, "")}`

  return html
    .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi,
      ""
    )
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\b(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(
      /(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi,
      (_, head, url, tail) =>
        `${head}${isRelative(url) ? rawUrl(url) : url}${tail}`
    )
    .replace(
      /(<a\b[^>]*\bhref\s*=\s*["'])([^"']+)(["'])/gi,
      (_, head, url, tail) =>
        `${head}${isRelative(url) ? blobUrl(url) : url}${tail}`
    )
}

/** @param {{ repo?: string }} input */
export default async function (input) {
  const repo = repoName(input?.repo)
  const info = await apiJson(`repos/${repo}`)
  const defaultBranch = String(info.default_branch || "main")

  const [languages, contents, releases, issuesRaw, readmeHtml, starred] =
    await Promise.all([
      apiJson(`repos/${repo}/languages`).catch(() => ({})),
      apiJson(`repos/${repo}/contents`).catch(() => []),
      apiJson(`repos/${repo}/releases?per_page=6`).catch(() => []),
      apiJson(
        `repos/${repo}/issues?state=open&per_page=16&sort=updated&direction=desc`
      ).catch(() => []),
      apiText(`repos/${repo}/readme`, "application/vnd.github.html+json")
        .then((html) => sanitizeReadmeHtml(html, repo, defaultBranch))
        .catch(() => null),
      checkStarred(repo),
    ])

  const langEntries = Object.entries(languages || {}).filter(
    ([, bytes]) => typeof bytes === "number" && bytes > 0
  )
  const totalBytes = langEntries.reduce((sum, [, n]) => sum + Number(n), 0)
  const languageBreakdown = langEntries
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([name, bytes]) => ({
      name,
      bytes: Number(bytes),
      percent: totalBytes > 0 ? (Number(bytes) / totalBytes) * 100 : 0,
    }))

  const files = Array.isArray(contents)
    ? contents
        .map((/** @type {any} */ item) => ({
          name: String(item.name || ""),
          type: item.type === "dir" ? "dir" : "file",
          size: typeof item.size === "number" ? item.size : 0,
          url: String(item.html_url || ""),
        }))
        .sort((a, b) =>
          a.type === b.type
            ? a.name.localeCompare(b.name)
            : a.type === "dir"
              ? -1
              : 1
        )
    : []

  const allItems = Array.isArray(issuesRaw) ? issuesRaw : []
  /** @param {any} item */
  const mapIssue = (item) => ({
    number: Number(item.number),
    title: String(item.title || ""),
    url: String(item.html_url || ""),
    author: String(item.user?.login || ""),
    comments: Number(item.comments || 0),
    updatedAt: String(item.updated_at || ""),
    draft: Boolean(item.draft),
    labels: Array.isArray(item.labels)
      ? item.labels.map((/** @type {any} */ l) => ({
          name: String(l.name || ""),
          color: String(l.color || ""),
        }))
      : [],
  })
  const pulls = allItems
    .filter((item) => Boolean(item.pull_request))
    .map(mapIssue)
  const issues = allItems.filter((item) => !item.pull_request).map(mapIssue)

  const mappedReleases = Array.isArray(releases)
    ? releases.map((/** @type {any} */ rel) => ({
        tag: String(rel.tag_name || ""),
        name: String(rel.name || rel.tag_name || ""),
        publishedAt: String(rel.published_at || rel.created_at || ""),
        prerelease: Boolean(rel.prerelease),
        url: String(rel.html_url || ""),
        body: String(rel.body || "").slice(0, 1200),
      }))
    : []

  return {
    repo: {
      fullName: String(info.full_name || repo),
      owner: String(info.owner?.login || repo.split("/")[0]),
      avatar: String(info.owner?.avatar_url || ""),
      name: String(info.name || repo.split("/")[1]),
      description: info.description ? String(info.description) : "",
      homepage: info.homepage ? String(info.homepage) : "",
      url: String(info.html_url || `https://github.com/${repo}`),
      cloneUrl: String(info.clone_url || `https://github.com/${repo}.git`),
      defaultBranch,
      stars: Number(info.stargazers_count || 0),
      forks: Number(info.forks_count || 0),
      watchers: Number(info.subscribers_count ?? info.watchers_count ?? 0),
      openIssues: Number(info.open_issues_count || 0),
      language: info.language ? String(info.language) : null,
      license:
        info.license?.spdx_id && info.license.spdx_id !== "NOASSERTION"
          ? String(info.license.spdx_id)
          : info.license?.name
            ? String(info.license.name)
            : null,
      topics: Array.isArray(info.topics) ? info.topics.map(String) : [],
      archived: Boolean(info.archived),
      isPrivate: Boolean(info.private),
      pushedAt: String(info.pushed_at || ""),
      createdAt: String(info.created_at || ""),
      starred,
    },
    languages: languageBreakdown,
    files,
    releases: mappedReleases,
    issues,
    pulls,
    readmeHtml,
  }
}
