// Exa（原 providers/exa.py）：可信来源发现（论文、官方站点），出来源列表。

import { errorOf, json, request } from "../http.js"

/** 逗号 / 空白分隔的域名 → 数组（原 _normalize_domain_filter）。 */
export function domains(value) {
  if (!value) return null
  const parts = (Array.isArray(value) ? value : [value]).flatMap((part) =>
    String(part)
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  )
  return parts.length ? parts : null
}

export function searchRequest(cfg, params, retry) {
  const payload = {
    query: params.query,
    numResults: params.numResults ?? 5,
    type: params.type || "neural",
    useAutoprompt: true,
  }
  if (params.text || params.highlights)
    payload.contents = { text: !!params.text, highlights: !!params.highlights }
  if (params.startPublishedDate) payload.startPublishedDate = params.startPublishedDate
  const include = domains(params.includeDomains)
  const exclude = domains(params.excludeDomains)
  if (include) payload.includeDomains = include
  if (exclude) payload.excludeDomains = exclude
  if (params.category) payload.category = params.category
  return request(`${cfg.url.replace(/\/+$/, "")}/search`, {
    headers: { accept: "application/json", "x-api-key": cfg.key },
    json: payload,
    timeoutMs: cfg.timeoutMs,
    retry,
  })
}

export function normalizeResult(item, { text, highlights }) {
  const out = {
    id: item.id ?? null,
    title: item.title || "",
    url: item.url || item.id || "",
    publishedDate: item.publishedDate ?? null,
    author: item.author || "",
    score: item.score ?? null,
  }
  if (text && "text" in item) out.text = item.text || ""
  if (highlights && "highlights" in item) out.highlights = item.highlights || []
  if ("image" in item) out.image = item.image
  if ("favicon" in item) out.favicon = item.favicon
  return out
}

export function searchOutput(outcome, params, elapsedMs) {
  try {
    if (outcome instanceof Error) throw outcome
    // Exa 的 4xx 带响应正文，参数错误单列（原 _error_payload）
    const data = json(outcome, { detail: true })
    const results = (data.results ?? []).map((item) =>
      normalizeResult(item, { text: !!params.text, highlights: !!params.highlights })
    )
    return {
      ok: true,
      query: params.query,
      search_type: params.type || "neural",
      results,
      total: results.length,
      elapsed_ms: elapsedMs,
    }
  } catch (error) {
    return { ok: false, query: params.query, ...errorOf(error), elapsed_ms: elapsedMs }
  }
}

