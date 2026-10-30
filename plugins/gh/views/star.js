// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// 加入星标 / 取消星标（视图动作），并就地更新星标与趋势缓存，重新渲染不必再请求 GitHub。

import { gh, RANGES, repoName, STARS_KEY, trendingKey } from "./common.js"

/** @param {{ repo: import("./common.js").Repo, star: boolean }} input */
export default async function (input) {
  const repo = input?.repo
  const name = repoName(repo?.full_name)
  const star = Boolean(input.star)
  await gh(["api", "-X", star ? "PUT" : "DELETE", `user/starred/${name}`])
  const delta = star ? 1 : -1
  /** @param {import("./common.js").Repo} item */
  const toggled = (item) => ({
    ...item,
    starred: star,
    stars: item.stars == null ? item.stars : item.stars + delta,
  })

  /** @type {import("./common.js").Repo[] | undefined} */
  const stars = await berth.storage.get(STARS_KEY)
  if (Array.isArray(stars)) {
    const rest = stars.filter((item) => item.full_name !== name)
    await berth.storage.set(STARS_KEY, star ? [toggled(repo), ...rest] : rest)
  }
  for (const range of RANGES) {
    const key = trendingKey(range)
    /** @type {{ at: number, repos: import("./common.js").Repo[] } | undefined} */
    const cached = await berth.storage.get(key)
    if (!cached?.repos?.some((item) => item.full_name === name)) continue
    await berth.storage.set(key, {
      ...cached,
      repos: cached.repos.map((item) =>
        item.full_name === name ? toggled(item) : item
      ),
    })
  }
}
