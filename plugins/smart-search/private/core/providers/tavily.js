// Tavily（原 service.call_tavily_*）：网页搜索补充来源、抓取网页正文（Markdown）。
// 原实现吞掉所有错误返回 None；这里同样返回 null，只有取消照常抛出。

import { json, request } from "../http.js"

const headers = (cfg) => ({ Authorization: `Bearer ${cfg.key}` })

export const searchRequest = (cfg, query, maxResults = 6) =>
  request(`${cfg.url}/search`, {
    headers: headers(cfg),
    json: {
      query,
      max_results: maxResults,
      search_depth: "advanced",
      include_raw_content: false,
      include_answer: false,
    },
    timeoutMs: cfg.timeoutMs,
  })

export function searchOutput(outcome) {
  try {
    if (outcome instanceof Error) throw outcome
    const results = json(outcome).results ?? []
    return results.length
      ? results.map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          content: r.content ?? "",
          score: r.score ?? 0,
        }))
      : null
  } catch (error) {
    if (error?.reason === "cancelled") throw error
    return null
  }
}

export const extractRequest = (cfg, url) =>
  request(`${cfg.url}/extract`, {
    headers: headers(cfg),
    json: { urls: [url], format: "markdown" },
    timeoutMs: 60_000,
  })

export function extractOutput(outcome) {
  try {
    if (outcome instanceof Error) throw outcome
    const content = json(outcome).results?.[0]?.raw_content ?? ""
    return content.trim() ? content : null
  } catch (error) {
    if (error?.reason === "cancelled") throw error
    return null
  }
}
