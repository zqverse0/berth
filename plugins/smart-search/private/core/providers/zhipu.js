// 智谱 Web Search（原 providers/zhipu.py）：中文实时来源列表，不出 AI 回答。

import { errorOf, json, request } from "../http.js"

export function searchRequest(cfg, params, retry) {
  const payload = {
    // 智谱限制查询长度：按字符截 70 个
    search_query: [...params.query].slice(0, 70).join(""),
    search_engine: params.engine || cfg.engine,
    search_intent: true,
    count: params.count ?? 10,
    search_recency_filter: params.recency || "noLimit",
    content_size: params.contentSize || "medium",
  }
  if (params.domain) payload.search_domain_filter = params.domain
  return request(`${cfg.url}/paas/v4/web_search`, {
    headers: { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" },
    json: payload,
    timeoutMs: cfg.timeoutMs,
    retry,
  })
}

export const normalizeResult = (item) => ({
  title: item.title || "",
  url: item.link || item.url || "",
  description: item.content || "",
  provider: "zhipu",
  source: item.media || "",
  published_date: item.publish_date || "",
  icon: item.icon || "",
  refer: item.refer || "",
})

/** 响应或错误 → 原 CLI 的输出对象。 */
export function searchOutput(outcome, params, cfg, elapsedMs) {
  const base = { query: params.query, provider: "zhipu" }
  try {
    if (outcome instanceof Error) throw outcome
    const data = json(outcome)
    const results = (data.search_result ?? []).map(normalizeResult)
    return {
      ok: true,
      ...base,
      search_engine: params.engine || cfg.engine,
      results,
      total: results.length,
      search_intent: data.search_intent ?? [],
      request_id: data.request_id ?? "",
      elapsed_ms: elapsedMs,
    }
  } catch (error) {
    return { ok: false, ...base, ...errorOf(error), elapsed_ms: elapsedMs }
  }
}
