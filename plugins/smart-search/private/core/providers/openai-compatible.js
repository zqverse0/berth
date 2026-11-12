// OpenAI 兼容的 chat/completions（原 providers/openai_compatible.py）：AI 回答 + 引用。
// stream=true 时仍发 SSE 请求，整段收完再解析；部分中转站 stream=false 也回 SSE，同一个解析器兜住。

import { check, request } from "../http.js"

export const NAME = "OpenAI-compatible"

export const SEARCH_PROMPT = `You are a helpful research assistant. Answer the user's question thoroughly using web search results.

Guidelines:
- Infer the user's true intent even when the question is vague. Consider multiple angles.
- Search broadly first (5+ perspectives), then go deep on the 2-3 most relevant ones.
- Prioritize authoritative sources: official docs, Wikipedia, academic papers, reputable journalism.
- Search in English first for breadth, switch to Chinese when the topic demands it.
- Every factual claim should cite its source. More credible sources strengthen the answer.
- Lead with the most likely answer, then provide supporting analysis.
- Define technical terms in plain language. Use real-world analogies for complex concepts.
- Format output in clean Markdown. Use LaTeX for formulas, code blocks for scripts.
- Be direct and concise. No filler or unnecessary follow-up questions.
`

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]
const pad = (n) => String(n).padStart(2, "0")

/** 本地时间上下文（原 get_local_time_info）；时区写成 UTC 偏移（QuickJS 没有时区名）。 */
export function timeContext(now) {
  const date = new Date(now)
  const offset = -date.getTimezoneOffset()
  const zone = `UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return (
    `[Current Time Context]\n` +
    `- Date: ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} (${WEEKDAYS[date.getDay()]})\n` +
    `- Time: ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}\n` +
    `- Timezone: ${zone}\n`
  )
}

export const userPrompt = (query, platform, now) =>
  timeContext(now) +
  "\n" +
  query +
  (platform
    ? "\n\nYou should search the web for the information you need, and focus on these platform: " +
      platform +
      "\n"
    : "")

export function searchRequest(provider, query, platform, now, retry) {
  return request(`${provider.url}/chat/completions`, {
    headers: {
      Authorization: `Bearer ${provider.key}`,
      Accept: "application/json, text/event-stream",
      "User-Agent": "smart-search/0.1.0",
    },
    json: {
      model: provider.model,
      messages: [
        { role: "system", content: SEARCH_PROMPT },
        { role: "user", content: userPrompt(query, platform, now) },
      ],
      stream: provider.stream,
    },
    timeoutMs: provider.timeoutMs,
    retry,
  })
}

/** 响应 → 回答正文（有引用时末尾附 `sources([...])`，由 sources.js 拆出）。 */
export function parseSearch(response) {
  const body = check(response).text ?? ""
  let content = ""
  let sources = []
  let data = null
  try {
    data = JSON.parse(body)
  } catch {
    data = null
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    sources = extractCitations(data)
    const message = data.choices?.[0]?.message
    if (message && typeof message === "object") {
      content = message.content || ""
      sources = mergeCitations(sources, normalizeCitations(message.citations))
    }
  }
  if (!content && body.trimStart().startsWith("data:")) content = parseStream(body)
  if (content && sources.length)
    content = `${content.trimEnd()}\n\nsources(${JSON.stringify(sources)})`
  return content
}

/** SSE 文本：累加 delta.content；一个都没有时把整段当 JSON 再试。 */
export function parseStream(body) {
  let content = ""
  const lines = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    lines.push(line)
    if (!line.startsWith("data:") || line === "data: [DONE]" || line === "data:[DONE]")
      continue
    try {
      const delta = JSON.parse(line.slice(5).trimStart()).choices?.[0]?.delta
      if (delta && "content" in delta) content += delta.content
    } catch {
      // 非 JSON 的 data 行跳过
    }
  }
  if (!content && lines.length) {
    try {
      content = JSON.parse(lines.join("")).choices?.[0]?.message?.content ?? ""
    } catch {
      // 不是 JSON
    }
  }
  return content
}

const isHttp = (url) =>
  typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))

export function normalizeCitations(citations) {
  if (!citations) return []
  const items = Array.isArray(citations) ? citations : [citations]
  const seen = new Set()
  const out = []
  for (const item of items) {
    const source = {}
    if (typeof item === "string") {
      const url = item.trim()
      if (!isHttp(url)) continue
      source.url = url
    } else if (item && typeof item === "object") {
      const url = item.url || item.href || item.link
      if (!isHttp(url)) continue
      source.url = url
      const title = item.title || item.name || item.label
      if (typeof title === "string" && title.trim()) source.title = title.trim()
    } else continue
    if (seen.has(source.url)) continue
    seen.add(source.url)
    out.push(source)
  }
  return out
}

export function mergeCitations(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists)
    for (const item of list ?? []) {
      const url = item?.url
      if (typeof url !== "string" || !url || seen.has(url)) continue
      seen.add(url)
      out.push(item)
    }
  return out
}

function extractCitations(data) {
  let sources = normalizeCitations(data.citations)
  for (const choice of data.choices ?? [])
    if (choice?.message && typeof choice.message === "object")
      sources = mergeCitations(sources, normalizeCitations(choice.message.citations))
  return sources
}
