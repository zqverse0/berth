// Context7（原 providers/context7.py）：库 / 框架文档。公开接口，key 可选。

import { check, errorOf, request } from "../http.js"

const headers = (cfg) => ({
  Accept: "application/json, text/plain",
  "X-Context7-Source": "smart-search",
  ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
})

const get = (cfg, path, retry) =>
  request(`${cfg.url}${path}`, {
    method: "GET",
    headers: headers(cfg),
    timeoutMs: cfg.timeoutMs,
    retry,
  })

export const libraryRequest = (cfg, name, query, retry) =>
  get(cfg, `/api/v2/search?query=${encodeURIComponent(`${name} ${query ?? ""}`.trim())}`, retry)

export const docsRequest = (cfg, libraryId, query, retry) =>
  get(
    cfg,
    `/api/v2/context?libraryId=${encodeURIComponent(libraryId)}&query=${encodeURIComponent(query)}`,
    retry
  )

/** 正文是 JSON 就解析，否则当纯文本（原 _get_with_retry）。 */
function body(response) {
  const text = check(response).text
  try {
    return JSON.parse(text)
  } catch {
    return { content: text, results: [] }
  }
}

const normalizeLibrary = (item) => ({
  id: item.id || "",
  title: item.title || "",
  description: item.description || "",
  trust_score: item.trustScore ?? null,
  benchmark_score: item.benchmarkScore ?? null,
  total_snippets: item.totalSnippets ?? null,
  stars: item.stars ?? null,
  provider: "context7",
})

const failed = (base, error, elapsedMs) => ({
  ok: false,
  ...base,
  provider: "context7",
  ...errorOf(error),
  elapsed_ms: elapsedMs,
})

export function libraryOutput(outcome, name, query, elapsedMs) {
  const base = { query: `${name} ${query ?? ""}`.trim() }
  try {
    if (outcome instanceof Error) throw outcome
    const data = body(outcome)
    const raw = Array.isArray(data) ? data : (data.results ?? [])
    const results = raw.map(normalizeLibrary)
    return {
      ok: true,
      ...base,
      provider: "context7",
      results,
      total: results.length,
      elapsed_ms: elapsedMs,
    }
  } catch (error) {
    return failed(base, error, elapsedMs)
  }
}

export function docsOutput(outcome, libraryId, query, elapsedMs) {
  const base = { library_id: libraryId, query }
  try {
    if (outcome instanceof Error) throw outcome
    const data = body(outcome)
    const isObject = data && typeof data === "object" && !Array.isArray(data)
    const code = isObject ? (data.codeSnippets ?? []) : []
    const info = isObject ? (data.infoSnippets ?? []) : []
    return {
      ok: true,
      ...base,
      provider: "context7",
      code_snippets: code,
      info_snippets: info,
      results: [...code, ...info],
      total: code.length + info.length,
      content: isObject ? JSON.stringify(data) : String(data),
      // 文档正文：v2 接口回的是 Markdown 文本；回 JSON 片段时给片段原文
      text: typeof data?.content === "string" ? data.content : JSON.stringify([...code, ...info], null, 2),
      elapsed_ms: elapsedMs,
    }
  } catch (error) {
    return failed(base, error, elapsedMs)
  }
}
