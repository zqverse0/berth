// Firecrawl（原 service.call_firecrawl_*）：网页搜索补充来源、抓取网页正文。错误同 Tavily 返回 null。

import { json, request, send } from "../http.js"

const headers = (cfg) => ({ Authorization: `Bearer ${cfg.key}` })

export const searchRequest = (cfg, query, limit = 14) =>
  request(`${cfg.url}/search`, {
    headers: headers(cfg),
    json: { query, limit },
    timeoutMs: 90_000,
  })

export function searchOutput(outcome) {
  try {
    if (outcome instanceof Error) throw outcome
    const results = json(outcome).data?.web ?? []
    return results.length
      ? results.map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          description: r.description ?? "",
        }))
      : null
  } catch (error) {
    if (error?.reason === "cancelled") throw error
    return null
  }
}

/** 抓取正文：正文为空时加长 waitFor 重试，共 `attempts` 次；请求出错直接放弃。 */
export async function scrape(deps, cfg, url, attempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await send(
        deps,
        request(`${cfg.url}/scrape`, {
          headers: headers(cfg),
          json: {
            url,
            formats: ["markdown"],
            timeout: 60_000,
            waitFor: (attempt + 1) * 1500,
          },
          timeoutMs: 90_000,
        })
      )
      const markdown = json(response).data?.markdown ?? ""
      if (markdown.trim()) return markdown
    } catch (error) {
      if (error?.reason === "cancelled") throw error
      return null
    }
  }
  return null
}
