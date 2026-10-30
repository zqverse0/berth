// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 发现视图共用：调 gh、仓库名校验、界面文字（按 req.locale）、缓存键与列表行。

const STRINGS = {
  en: {
    trending: "GitHub Trending",
    stars: "Stars",
    daily: "Today",
    weekly: "This week",
    monthly: "This month",
    trendingEmpty: "No trending repositories found.",
    starsEmpty: "No starred repositories.",
    readme: "Read README",
    openOnGithub: "Open on GitHub",
    star: "Star",
    unstar: "Unstar",
    copyLink: "Copy link",
    clone: "Clone",
    cloneTo: "Clone to another folder…",
    sendToAgent: "Send to Agent",
    copyClone: "Copy clone command",
    starsTip: (/** @type {string} */ n) => `${n} stars`,
    forksTip: (/** @type {string} */ n) => `${n} forks`,
    updated: (/** @type {number} */ minutes) =>
      minutes < 1
        ? "Updated just now"
        : minutes < 60
          ? `Updated ${minutes} min ago`
          : `Updated ${Math.floor(minutes / 60)} h ago`,
    noReadme: "No README found.",
  },
  "zh-CN": {
    trending: "GitHub 趋势",
    stars: "星标",
    daily: "今天",
    weekly: "本周",
    monthly: "本月",
    trendingEmpty: "暂时没有找到趋势仓库。",
    starsEmpty: "还没有星标仓库。",
    readme: "阅读 README",
    openOnGithub: "在 GitHub 打开",
    star: "加入星标",
    unstar: "取消星标",
    copyLink: "复制链接",
    clone: "克隆",
    cloneTo: "克隆到其他目录…",
    sendToAgent: "发给 Agent",
    copyClone: "复制 clone 命令",
    starsTip: (/** @type {string} */ n) => `${n} 个 Star`,
    forksTip: (/** @type {string} */ n) => `${n} 个 Fork`,
    updated: (/** @type {number} */ minutes) =>
      minutes < 1
        ? "刚刚更新"
        : minutes < 60
          ? `更新于 ${minutes} 分钟前`
          : `更新于 ${Math.floor(minutes / 60)} 小时前`,
    noReadme: "没有 README。",
  },
}

/** @param {string} locale */
export const strings = (locale) =>
  locale in STRINGS ? STRINGS[/** @type {"en"} */ (locale)] : STRINGS.en

export const RANGES = /** @type {const} */ (["daily", "weekly", "monthly"])

/** storage 键：星标列表；各时间范围的趋势（含星标数与是否已加星）。star.js 就地更新两者。 */
export const STARS_KEY = "stars"
export const trendingKey = (/** @type {string} */ range) => `trending:${range}`

/** `owner/name`，拒绝其他形状（拼进 gh 参数前校验）。 */
export function repoName(/** @type {unknown} */ value) {
  if (typeof value !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value)) {
    throw new Error(`not a repository: ${String(value)}`)
  }
  return value
}

/** 运行 gh，返回 stdout；失败抛出 gh 的错误输出。 */
export async function gh(/** @type {string[]} */ args) {
  const { code, stdout, stderr } = await berth.process.exec("gh", args, {
    timeoutMs: 30_000,
  })
  if (code !== 0) {
    throw new Error(
      (stderr || stdout).trim() || `gh ${args[0]} exited with ${code}`
    )
  }
  return stdout
}

/** 与内置列表同一写法：1234 → 1.2k */
export function compact(/** @type {number} */ n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * @typedef {{ full_name: string, description?: string | null, stars?: number | null, forks?: number | null, language?: string | null, starred: boolean | null }} Repo
 * `starred` 为 null：不知道星标状态（gh 未登录），不给星标按钮。
 */

/**
 * 仓库 → 列表行（与内置发现相同的动作与顺序）：点击读 README；克隆、星标是行尾按钮（已加星常驻、琥珀色）；
 * 其余进「…」菜单。
 * @param {Repo} repo
 * @param {ReturnType<typeof strings>} s
 * @returns {import("berth").ListItem}
 */
export function repoItem(repo, s) {
  const [owner] = repo.full_name.split("/")
  const url = `https://github.com/${repo.full_name}`
  /** @type {import("berth").ViewAction[]} */
  const actions = [
    {
      type: "open-view",
      title: s.readme,
      icon: "book",
      view: "readme",
      params: { repo: repo.full_name },
    },
  ]
  actions.push({
    type: "clone",
    title: s.clone,
    icon: "download",
    inline: "hover",
    url: `${url}.git`,
  })
  if (repo.starred !== null) {
    const { full_name, description, stars, forks, language } = repo
    actions.push({
      type: "script",
      title: repo.starred ? s.unstar : s.star,
      icon: repo.starred ? "star-filled" : "star",
      inline: repo.starred ? "always" : "hover",
      script: "views/star.js",
      // 带上概况：加星后 star.js 直接放进星标缓存，不必重拉整个列表。
      input: {
        repo: { full_name, description, stars, forks, language },
        star: !repo.starred,
      },
      refresh: true,
    })
  }
  const summary = repo.description?.replace(/\s+/g, " ").trim()
  actions.push(
    {
      type: "send-to-agent",
      title: s.sendToAgent,
      icon: "send",
      // 单行（终端不支持 bracketed paste 也不会被拆开提交），末尾留空格便于接着输入。
      text: `${repo.full_name} (${url})${summary ? ` — ${summary}` : ""} `,
    },
    { type: "open-url", title: s.openOnGithub, icon: "external-link", url },
    {
      type: "clone",
      title: s.cloneTo,
      icon: "folder-input",
      url: `${url}.git`,
      pickDirectory: true,
    },
    { type: "copy", title: s.copyLink, icon: "link", text: url },
    {
      type: "copy",
      title: s.copyClone,
      icon: "copy",
      text: `git clone ${url}.git`,
    }
  )
  /** @type {import("berth").ListItem["accessories"]} */
  const accessories = []
  if (repo.stars != null)
    accessories.push({
      text: compact(repo.stars),
      icon: "star",
      tooltip: s.starsTip(compact(repo.stars)),
    })
  if (repo.forks != null)
    accessories.push({
      text: compact(repo.forks),
      icon: "fork",
      tooltip: s.forksTip(compact(repo.forks)),
    })
  if (repo.language) accessories.push({ text: repo.language })
  return {
    id: repo.full_name,
    title: repo.full_name,
    subtitle: repo.description ?? undefined,
    icon: `https://github.com/${owner}.png?size=64`,
    accessories,
    actions,
  }
}
