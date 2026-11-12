// 路由与兜底链（原 service.py 的 search / fetch / exa_search / zhipu_search / context7_* /
// _run_*_fallback / 意图判断 / 连通测试）。结构照搬；并发的地方走 http.fetchAll。
// deps：{ http, now }；cfg：config.resolve 的结果。

import { errorOf, request, send, sendAll } from "./http.js"
import { mergeSources, splitAnswerAndSources } from "./sources.js"
import * as context7 from "./providers/context7.js"
import * as exa from "./providers/exa.js"
import * as firecrawl from "./providers/firecrawl.js"
import * as openai from "./providers/openai-compatible.js"
import * as tavily from "./providers/tavily.js"
import * as xai from "./providers/xai-responses.js"
import * as zhipu from "./providers/zhipu.js"

const SOURCE_WARNING =
  "extra_sources are retrieved in parallel and are not automatically used to verify generated content; " +
  "use fetch on key URLs for claim-level evidence."
const MINIMUM_PROFILE_ERROR =
  "最低配置不满足：必须至少配置 main_search、docs_search、web_fetch 三类能力各一个 provider。"
const DOCS_INTENT = [
  "api", "sdk", "library", "framework", "docs", "documentation", "reference", "react",
  "next.js", "vue", "python", "prisma", "langchain", "openai", "context7",
  "接口", "文档", "库", "框架", "函数", "参数", "配置",
]
const ZH_CURRENT_INTENT = [
  "今天", "最新", "国内", "中国", "政策", "新闻", "实时", "刚刚", "本周", "本月",
  "战报", "比分", "赛程", "赛果", "季后赛", "比赛", "nba", "足球", "篮球",
]
const MAIN_ALIASES = {
  "xai-responses": ["xai-responses", "xai", "grok", "grok-web-tools"],
  "openai-compatible": ["openai-compatible", "openai", "chat-completions", "primary"],
}
const WEB_ERROR_TYPES = ["rate_limited", "auth_error", "timeout", "network_error", "runtime_error"]

const has = (query, words) => {
  const lower = query.toLowerCase()
  return words.some((word) => lower.includes(word))
}
export const isDocsIntent = (query) => has(query, DOCS_INTENT)
export const isZhCurrentIntent = (query) => has(query, ZH_CURRENT_INTENT)
export const isFetchIntent = (query) => has(query, ["http://", "https://"])

const elapsed = (deps, start) => Math.round(deps.now() - start)

const attempt = (deps, capability, provider, status, start, extra = {}) => ({
  capability,
  provider,
  status,
  error_type: extra.error_type ?? "",
  error: extra.error ?? "",
  elapsed_ms: elapsed(deps, start),
  result_count: extra.count ?? 0,
})

/** 同一能力试过不止一家即用了兜底。 */
export function fallbackUsed(attempts) {
  const counts = {}
  for (const item of attempts)
    if (["ok", "empty", "error"].includes(item.status))
      counts[item.capability] = (counts[item.capability] ?? 0) + 1
  return Object.values(counts).some((count) => count > 1)
}

const providersUsed = (attempts) => [
  ...new Set(attempts.filter((item) => item.status === "ok" && item.provider).map((item) => item.provider)),
]

const providerFilter = (providers) =>
  !providers || providers.trim().toLowerCase() === "auto"
    ? null
    : new Set(providers.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))

/** 搜索结果里的来源统一成 `{url, provider, title?, description?, published_date?, source?}`。 */
export function normalizeSources(results, provider) {
  const out = []
  for (const item of results ?? []) {
    const url = (item.url || item.link || "").trim()
    if (!url) continue
    const source = { url, provider: item.provider || provider }
    const title = (item.title || "").trim()
    if (title) source.title = title
    const description = (item.description || item.content || item.snippet || "").trim()
    if (description) source.description = description
    const published = item.published_date || item.publishedDate || item.publish_date
    if (published) source.published_date = published
    const origin = item.source || item.media
    if (origin) source.source = origin
    out.push(source)
  }
  return out
}

/** Tavily / Firecrawl 补充来源（Firecrawl 在前，按 url 去重）。 */
export function extraResultsToSources(tavilyResults, firecrawlResults) {
  const seen = new Set()
  const out = []
  const add = (items, provider, field) => {
    for (const result of items ?? []) {
      const url = (result.url || "").trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      const item = { url, provider }
      const title = (result.title || "").trim()
      if (title) item.title = title
      const description = (result[field] || "").trim()
      if (description) item.description = description
      out.push(item)
    }
  }
  add(firecrawlResults, "firecrawl", "description")
  add(tavilyResults, "tavily", "content")
  return out
}

// ───────────── 单家服务商 ─────────────

const notConfigured = (key) => ({
  ok: false,
  error_type: "config_error",
  error: `${key} 未配置。在 smart-search 侧栏的「配置」里填写，或 \`berth tools call smart-search private/config.js --input '{"action":"set","key":"${key}","value":"…"}'\`。`,
})

export async function zhipuSearch(deps, cfg, params) {
  if (!cfg.zhipu) return notConfigured("ZHIPU_API_KEY")
  const start = deps.now()
  let outcome
  try {
    outcome = await send(deps, zhipu.searchRequest(cfg.zhipu, params, cfg.retry))
  } catch (error) {
    outcome = rethrowCancel(error)
  }
  return zhipu.searchOutput(outcome, params, cfg.zhipu, elapsed(deps, start))
}

export async function exaSearch(deps, cfg, params) {
  if (!cfg.exa) return notConfigured("EXA_API_KEY")
  const start = deps.now()
  let outcome
  try {
    outcome = await send(deps, exa.searchRequest(cfg.exa, params, cfg.retry))
  } catch (error) {
    outcome = rethrowCancel(error)
  }
  return exa.searchOutput(outcome, params, elapsed(deps, start))
}

export async function context7Library(deps, cfg, name, query = "") {
  const start = deps.now()
  let outcome
  try {
    outcome = await send(deps, context7.libraryRequest(cfg.context7, name, query, cfg.retry))
  } catch (error) {
    outcome = rethrowCancel(error)
  }
  return context7.libraryOutput(outcome, name, query, elapsed(deps, start))
}

export async function context7Docs(deps, cfg, libraryId, query) {
  const start = deps.now()
  let outcome
  try {
    outcome = await send(deps, context7.docsRequest(cfg.context7, libraryId, query, cfg.retry))
  } catch (error) {
    outcome = rethrowCancel(error)
  }
  return context7.docsOutput(outcome, libraryId, query, elapsed(deps, start))
}

function rethrowCancel(error) {
  if (error?.reason === "cancelled") throw error
  return error instanceof Error ? error : new Error(String(error))
}

// ───────────── 兜底链 ─────────────

/** 网页来源：zhipu → tavily → firecrawl，第一家有结果即停。 */
export async function webSearchFallback(deps, cfg, query, { count = 5, providers = "auto", fallback = "auto" } = {}) {
  const filter = providerFilter(providers)
  let chain = ["zhipu", "tavily", "firecrawl"].filter((id) => cfg[id] && (!filter || filter.has(id)))
  if (fallback === "off") chain = chain.slice(0, 1)
  const attempts = []
  for (const provider of chain) {
    const start = deps.now()
    try {
      let sources = []
      if (provider === "zhipu") {
        const data = await zhipuSearch(deps, cfg, { query, count })
        if (data.ok) sources = normalizeSources(data.results, "zhipu")
        else {
          const status = WEB_ERROR_TYPES.includes(data.error_type) ? "error" : "empty"
          attempts.push(attempt(deps, "web_search", provider, status, start, data))
          continue
        }
      } else if (provider === "tavily") {
        const outcome = await send(deps, tavily.searchRequest(cfg.tavily, query, count)).catch(rethrowCancel)
        sources = normalizeSources(tavily.searchOutput(outcome), "tavily")
      } else {
        const outcome = await send(deps, firecrawl.searchRequest(cfg.firecrawl, query, count)).catch(rethrowCancel)
        sources = normalizeSources(firecrawl.searchOutput(outcome), "firecrawl")
      }
      if (sources.length) {
        attempts.push(attempt(deps, "web_search", provider, "ok", start, { count: sources.length }))
        return [sources, attempts]
      }
      attempts.push(attempt(deps, "web_search", provider, "empty", start))
    } catch (error) {
      attempts.push(attempt(deps, "web_search", provider, "error", start, { ...errorOf(error), error_type: "runtime_error" }))
    }
  }
  return [[], attempts]
}

/** 文档来源：context7（公开）→ exa。 */
export async function docsSearchFallback(deps, cfg, query, { providers = "auto", fallback = "auto" } = {}) {
  const filter = providerFilter(providers)
  let chain = ["context7", ...(cfg.exa ? ["exa"] : [])].filter((id) => !filter || filter.has(id))
  if (fallback === "off") chain = chain.slice(0, 1)
  const attempts = []
  for (const provider of chain) {
    const start = deps.now()
    let sources = []
    let data
    if (provider === "exa") {
      data = await exaSearch(deps, cfg, { query, numResults: 5, highlights: true })
      if (data.ok) sources = normalizeSources(data.results, "exa")
    } else {
      data = await context7Library(deps, cfg, query, query)
      if (data.ok)
        sources = data.results
          .filter((item) => item.id)
          .map((item) => ({
            url: `context7:${item.id}`,
            title: item.title || item.id || "Context7",
            description: item.description || "",
            provider: "context7",
          }))
    }
    if (sources.length) {
      attempts.push(attempt(deps, "docs_search", provider, "ok", start, { count: sources.length }))
      return [sources, attempts]
    }
    const status = !data.ok && data.error_type && data.error_type !== "parse_error" ? "error" : "empty"
    attempts.push(attempt(deps, "docs_search", provider, status, start, data.ok ? {} : data))
  }
  return [[], attempts]
}

/** 抓正文：tavily extract → firecrawl scrape。 */
export async function webFetchFallback(deps, cfg, url, { fallback = "auto" } = {}) {
  let chain = ["tavily", "firecrawl"].filter((id) => cfg[id])
  if (fallback === "off") chain = chain.slice(0, 1)
  const attempts = []
  for (const provider of chain) {
    const start = deps.now()
    try {
      const content =
        provider === "tavily"
          ? tavily.extractOutput(await send(deps, tavily.extractRequest(cfg.tavily, url)).catch(rethrowCancel))
          : await firecrawl.scrape(deps, cfg.firecrawl, url, cfg.retryAttempts)
      if (content?.trim()) {
        attempts.push(attempt(deps, "web_fetch", provider, "ok", start, { count: 1 }))
        return [{ ok: true, url, provider, content }, attempts]
      }
      attempts.push(attempt(deps, "web_fetch", provider, "empty", start))
    } catch (error) {
      if (error?.reason === "cancelled") throw error
      attempts.push(attempt(deps, "web_fetch", provider, "error", start, { error_type: "runtime_error", error: String(error?.message ?? error) }))
    }
  }
  return [null, attempts]
}

// ───────────── 入口能力 ─────────────

export async function fetchPage(deps, cfg, url) {
  const start = deps.now()
  const [result, attempts] = await webFetchFallback(deps, cfg, url)
  if (result)
    return { ...result, provider_attempts: attempts, fallback_used: fallbackUsed(attempts), elapsed_ms: elapsed(deps, start) }
  const configured = cfg.tavily || cfg.firecrawl
  return {
    ok: false,
    url,
    provider: "",
    content: "",
    error_type: configured ? "network_error" : "config_error",
    error: configured ? "所有提取服务均未能获取内容" : "TAVILY_API_KEY 和 FIRECRAWL_API_KEY 均未配置",
    provider_attempts: attempts,
    fallback_used: fallbackUsed(attempts),
    elapsed_ms: elapsed(deps, start),
  }
}

/** 各能力有没有可用的服务商；`standard` 要求 main / docs / fetch 各一家。 */
export function minimumProfile(cfg) {
  const missing = []
  if (cfg.minimumProfile !== "off") {
    if (!cfg.xai && !cfg.openai) missing.push("main_search")
    if (!cfg.context7) missing.push("docs_search")
    if (!cfg.tavily && !cfg.firecrawl) missing.push("web_fetch")
  }
  return missing
}

function mainChain(cfg, providers, fallback) {
  const filter = providerFilter(providers)
  const chain = [
    cfg.xai && { id: "xai-responses", mode: "xai-responses", module: xai, provider: cfg.xai },
    cfg.openai && { id: "openai-compatible", mode: "chat-completions", module: openai, provider: cfg.openai },
  ].filter((item) => item && (!filter || MAIN_ALIASES[item.id].some((alias) => filter.has(alias))))
  return fallback === "off" ? chain.slice(0, 1) : chain
}

/** 主搜索出错 → 原 _primary_search_exception_result 的类型与消息。 */
function mainError(name, error, response) {
  if (response && !(response.status >= 200 && response.status < 300))
    return { error_type: "network_error", error: `${name} HTTP ${response.status}: ${String(response.text ?? "").slice(0, 300)}` }
  const message = String(error?.message ?? error)
  if (/timed out|timeout/i.test(message)) return { error_type: "network_error", error: `${name} 请求超时: ${message}` }
  if (error?.reason === "internal") return { error_type: "network_error", error: `${name} 网络错误: ${message}` }
  return { error_type: "runtime_error", error: `${name} 运行错误: ${message}` }
}

const failure = (deps, start, query, error_type, error, extra = {}) => ({
  ok: false,
  error_type,
  error,
  query,
  content: "",
  primary_sources: [],
  extra_sources: [],
  provider_attempts: [],
  fallback_used: false,
  ...extra,
  elapsed_ms: elapsed(deps, start),
})

/**
 * 搜索。`mode: "sources"` 只走来源兜底链（网页 + 文档意图时的文档），几十秒内出列表；
 * 缺省是完整搜索：AI 回答（主搜索链）+ 补充来源，与原 CLI 一致。
 */
export async function search(deps, cfg, params) {
  const start = deps.now()
  const query = String(params.query ?? "").trim()
  const validation = (params.validation || cfg.validation).toLowerCase()
  const fallback = (params.fallback || cfg.fallback).toLowerCase()
  const providers = params.providers || "auto"
  if (!query) return failure(deps, start, query, "parameter_error", "query is empty")
  if (!["fast", "balanced", "strict"].includes(validation))
    return failure(deps, start, query, "parameter_error", `Invalid validation level: ${validation}`)
  if (!["auto", "off"].includes(fallback))
    return failure(deps, start, query, "parameter_error", `Invalid fallback mode: ${fallback}`)
  const docsIntent = isDocsIntent(query)
  const zhCurrent = isZhCurrentIntent(query)
  const fetchIntent = isFetchIntent(query)

  if (params.mode === "sources") {
    const attempts = []
    const [web, webAttempts] = await webSearchFallback(deps, cfg, query, { count: 8, providers, fallback })
    attempts.push(...webAttempts)
    let docs = []
    if (docsIntent) {
      const [found, docsAttempts] = await docsSearchFallback(deps, cfg, query, { providers, fallback })
      docs = found
      attempts.push(...docsAttempts)
    }
    const sources = mergeSources(web, docs)
    const ok = sources.length > 0
    return {
      ok,
      error_type: ok ? "" : cfg.zhipu || cfg.tavily || cfg.firecrawl ? "network_error" : "config_error",
      error: ok ? "" : cfg.zhipu || cfg.tavily || cfg.firecrawl ? "搜索失败或无结果" : "ZHIPU / TAVILY / FIRECRAWL 均未配置",
      query,
      mode: "sources",
      content: "",
      primary_sources: sources,
      extra_sources: [],
      providers_used: providersUsed(attempts),
      provider_attempts: attempts,
      fallback_used: fallbackUsed(attempts),
      elapsed_ms: elapsed(deps, start),
    }
  }

  const missing = minimumProfile(cfg)
  if (missing.length)
    return failure(deps, start, query, "config_error", `${MINIMUM_PROFILE_ERROR} 缺失能力: ${missing.join(", ")}`, { validation_level: validation })
  const chain = mainChain(cfg, providers, fallback)
  if (!chain.length)
    return failure(deps, start, query, "config_error", "No configured main_search provider matches --providers.", { validation_level: validation })

  const supplemental = [
    ...(docsIntent ? ["docs_search"] : []),
    ...(zhCurrent || validation === "strict" ? ["web_search"] : []),
    ...(fetchIntent ? ["web_fetch"] : []),
  ]
  const routing = {
    docs_intent: docsIntent,
    zh_current_intent: zhCurrent,
    web_current_intent: zhCurrent,
    fetch_intent: fetchIntent,
    supplemental_paths: supplemental,
    validation_level: validation,
    fallback_mode: fallback,
    providers,
    main_search_chain: chain.map((item) => item.id),
    openai_compatible_stream: !!chain.find((item) => item.id === "openai-compatible")?.provider.stream,
  }

  const attempts = []
  let primary = null
  let used = null
  let lastError = null
  for (const item of chain) {
    const begin = deps.now()
    const name = item.module.NAME
    let response
    try {
      response = await send(deps, item.module.searchRequest(item.provider, query, params.platform ?? "", deps.now(), cfg.retry))
      const candidate = item.module.parseSearch(response)
      if (candidate) {
        primary = candidate
        used = item
        attempts.push(attempt(deps, "main_search", name, "ok", begin, { count: 1 }))
        break
      }
      lastError = { error_type: "network_error", error: `${name} 返回空结果`, mode: item.mode }
      attempts.push(attempt(deps, "main_search", name, "empty", begin))
    } catch (error) {
      if (error?.reason === "cancelled") throw error
      lastError = { ...mainError(name, error, response), mode: item.mode }
      attempts.push(attempt(deps, "main_search", name, "error", begin, lastError))
    }
  }
  if (primary === null)
    return failure(deps, start, query, lastError?.error_type ?? "network_error", lastError?.error ?? "搜索失败或无结果", {
      primary_api_mode: lastError?.mode ?? chain[0].mode,
      provider_attempts: attempts,
      providers_used: providersUsed(attempts),
      fallback_used: fallbackUsed(attempts),
      routing_decision: routing,
      validation_level: validation,
    })

  // 补充来源：Tavily 与 Firecrawl 按 6:4 分配，并发
  const extra = Number(params.extraSources) || 0
  let tavilyCount = 0
  let firecrawlCount = 0
  if (extra > 0) {
    if (cfg.tavily && cfg.firecrawl) {
      tavilyCount = Math.max(1, Math.round(extra * 0.6))
      firecrawlCount = extra - tavilyCount
    } else if (cfg.tavily) tavilyCount = extra
    else if (cfg.firecrawl) firecrawlCount = extra
  }
  const specs = [
    ...(tavilyCount ? [tavily.searchRequest(cfg.tavily, query, tavilyCount)] : []),
    ...(firecrawlCount ? [firecrawl.searchRequest(cfg.firecrawl, query, firecrawlCount)] : []),
  ]
  const replies = await sendAll(deps, specs)
  const tavilyResults = tavilyCount ? tavily.searchOutput(replies[0]) : null
  const firecrawlResults = firecrawlCount ? firecrawl.searchOutput(replies[tavilyCount ? 1 : 0]) : null

  const [answer, primarySources] = splitAnswerAndSources(primary)
  let extraSources = extraResultsToSources(tavilyResults, firecrawlResults)
  for (const [provider, results] of [["tavily", tavilyResults], ["firecrawl", firecrawlResults]])
    if (results?.length) attempts.push(attempt(deps, "web_search", provider, "ok", start, { count: results.length }))

  const more = []
  if (validation === "balanced" || validation === "strict") {
    if (docsIntent) {
      const [found, docsAttempts] = await docsSearchFallback(deps, cfg, query, { providers, fallback })
      attempts.push(...docsAttempts)
      more.push(...found)
    }
    if (zhCurrent || validation === "strict") {
      const [found, webAttempts] = await webSearchFallback(deps, cfg, query, { count: Math.max(1, extra || 3), providers, fallback })
      attempts.push(...webAttempts)
      more.push(...found)
    }
    if (fetchIntent) {
      const [page, fetchAttempts] = await webFetchFallback(deps, cfg, query, { fallback })
      attempts.push(...fetchAttempts)
      if (page) more.push({ url: page.url, provider: page.provider, description: page.content.slice(0, 300) })
    }
  }
  extraSources = mergeSources(extraSources, more)
  const sources = mergeSources(primarySources, extraSources)
  let ok = !!(answer || sources.length)
  if (validation === "strict" && !sources.length) ok = false
  return {
    ok,
    error_type: ok ? "" : validation === "strict" ? "evidence_error" : "network_error",
    error: ok ? "" : validation === "strict" ? "strict 模式证据不足" : "搜索失败或无结果",
    query,
    platform: params.platform ?? "",
    model: used.provider.model,
    primary_api_mode: used.mode,
    content: answer,
    primary_sources: primarySources,
    extra_sources: extraSources,
    source_warning: extraSources.length ? SOURCE_WARNING : "",
    routing_decision: routing,
    providers_used: providersUsed(attempts),
    provider_attempts: attempts,
    fallback_used: fallbackUsed(attempts),
    validation_level: validation,
    elapsed_ms: elapsed(deps, start),
  }
}

// ───────────── 连通测试 ─────────────

/** 逐家测连通（并发）：`{ <服务商>: { status: ok | warning | error | timeout | not_configured, message } }`。 */
export async function testConnections(deps, cfg) {
  const auth = (key) => ({ Authorization: `Bearer ${key}` })
  const short = { timeoutMs: 20_000 }
  const plans = {
    xai: cfg.xai && {
      spec: request(`${cfg.xai.url}/responses`, { headers: auth(cfg.xai.key), json: { model: cfg.xai.model, input: [{ role: "user", content: "Reply with exactly: ok" }], stream: false }, ...short }),
    },
    openai: cfg.openai && {
      spec: request(`${cfg.openai.url.replace(/\/+$/, "")}/chat/completions`, { headers: auth(cfg.openai.key), json: { model: cfg.openai.model, messages: [{ role: "user", content: "Reply with exactly: ok" }], stream: false, max_tokens: 8 }, ...short }),
    },
    exa: cfg.exa && {
      spec: request(`${cfg.exa.url.replace(/\/+$/, "")}/search`, { headers: { "x-api-key": cfg.exa.key }, json: { query: "test", numResults: 1, type: "keyword" }, timeoutMs: 10_000 }),
    },
    tavily: cfg.tavily && {
      spec: request(`${cfg.tavily.url}/search`, { headers: auth(cfg.tavily.key), json: { query: "test", max_results: 1, search_depth: "basic" }, timeoutMs: cfg.tavily.timeoutMs }),
    },
    zhipu: cfg.zhipu && { spec: zhipu.searchRequest(cfg.zhipu, { query: "test", count: 1 }) },
    context7: { spec: context7.libraryRequest(cfg.context7, "react", "hooks") },
    firecrawl: cfg.firecrawl && {
      spec: request(`${cfg.firecrawl.url}/search`, { headers: auth(cfg.firecrawl.key), json: { query: "test", limit: 1 }, timeoutMs: 20_000 }),
    },
  }
  const names = Object.keys(plans).filter((name) => plans[name])
  const replies = await sendAll(deps, names.map((name) => plans[name].spec))
  const result = Object.fromEntries(
    Object.keys(plans).map((name) => [name, { status: "not_configured", message: "未配置" }])
  )
  names.forEach((name, index) => {
    const reply = replies[index]
    if (reply instanceof Error) {
      const { error_type, error } = errorOf(reply)
      result[name] = { status: error_type === "timeout" ? "timeout" : "error", message: error }
    } else if (reply.status === 200) result[name] = { status: "ok", message: "可用 (HTTP 200)" }
    else result[name] = { status: "warning", message: `HTTP ${reply.status}: ${String(reply.text).slice(0, 100)}` }
  })
  return result
}
