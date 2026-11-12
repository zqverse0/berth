// 回答与来源拆分、去重合并（原 sources.py、utils.extract_unique_urls）。AI 回答末尾的
// `sources([...])`、「参考资料」小节、<details> 块或尾部链接行都拆成来源列表。

const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
const INLINE_CITATION = /\[\[(\d+)\]\]\((https?:\/\/[^)]+)\)/g
const URL = /https?:\/\/[^\s<>"'`，。、；：！？》）】)]+/g
const SOURCES_HEADING =
  /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(sources?|references?|citations?|信源|参考资料|参考|引用|来源列表|来源)\s*(?:\*\*|__)?(?:\s*[（(][^)\n]*[)）])?\s*[:：]?\s*$/gim
const SOURCES_FUNCTION =
  /(^|\n)\s*(sources|source|citations|citation|references|reference|citation_card|source_cards|source_card)\s*\(/gim
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi
const LEADING_POLICY = [
  /^I\s+cannot\s+(comply|assist|help|provide|fulfill)/i,
  /^I\s+(can't|won't|will\s+not|am\s+unable\s+to)\s+(comply|assist|help|provide|fulfill)/i,
  /^I('m|\s+am)\s+not\s+able\s+to/i,
  /^(Sorry|Apologies|I\s+apologize),?\s+(but\s+)?I\s+(cannot|can't|won't)/i,
  /^As\s+an?\s+AI(\s+language\s+model)?/i,
  /^我(无法|不能|没有办法)(遵从|遵守|协助|帮助|提供|满足)/i,
  /^(抱歉|对不起|很遗憾)[，,]?\s*我(无法|不能)/i,
]
const POLICY_META = [
  "policy", "policies", "guideline", "guidelines", "content policy",
  "usage policy", "terms of service", "acceptable use",
  "策略", "政策", "准则", "使用条款", "服务条款",
]
const POLICY_CONTEXT = [
  "prompt injection", "jailbreak", "system prompt", "hidden instruction",
  "bypass", "override", "ignore previous",
  "提示注入", "越狱", "系统提示", "隐藏指令",
]

const isHttp = (url) =>
  typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))

/** Python `str.rstrip(chars)`。 */
const rstripChars = (text, chars) => {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1])) end--
  return text.slice(0, end)
}

export function extractUniqueUrls(text) {
  const seen = new Set()
  const urls = []
  for (const match of (text ?? "").matchAll(URL)) {
    const url = rstripChars(match[0], ".,;:!?")
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

export function mergeSources(...lists) {
  const seen = new Set()
  const merged = []
  for (const list of lists)
    for (const item of list ?? []) {
      const url = item?.url
      if (typeof url !== "string" || !url.trim()) continue
      if (seen.has(url.trim())) continue
      seen.add(url.trim())
      merged.push(item)
    }
  return merged
}

const looksLikePolicy = (text) => {
  const normalized = text.replace(/[*_`#~[\](){}]/g, "").toLowerCase().trim()
  if (!normalized) return false
  if (LEADING_POLICY.some((pattern) => pattern.test(normalized))) return true
  const meta = POLICY_META.filter((word) => normalized.includes(word)).length
  const context = POLICY_CONTEXT.filter((word) => normalized.includes(word)).length
  return meta >= 2 || context >= 2 || (meta >= 1 && context >= 1)
}

/** 去掉 <think> 块与开头的拒答 / 策略声明段落。 */
export function sanitizeAnswer(text) {
  const raw = (text ?? "").replace(THINK_BLOCK, "").trim()
  if (!raw) return ""
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  let leading = true
  const kept = []
  for (const paragraph of paragraphs) {
    if (leading && looksLikePolicy(paragraph)) continue
    leading = false
    kept.push(paragraph)
  }
  return kept.join("\n\n").trim()
}

/** AI 回答 → `[正文, 来源]`。 */
export function splitAnswerAndSources(text) {
  let raw = (text ?? "").trim()
  if (!raw) return ["", []]
  raw = sanitizeAnswer(raw) || raw
  const inline = inlineCitationSources(raw)
  for (const split of [splitFunctionCall, splitHeading, splitDetails, splitTailLinks]) {
    const result = split(raw)
    if (result) return [result[0], mergeSources(result[1], inline)]
  }
  return [raw, inline]
}

function splitFunctionCall(text) {
  const matches = [...text.matchAll(SOURCES_FUNCTION)]
  for (const match of matches.reverse()) {
    const open = match.index + match[0].length - 1
    const args = balancedCallAtEnd(text, open)
    if (args === null) continue
    const sources = parsePayload(args)
    if (!sources.length) continue
    return [text.slice(0, match.index).trimEnd(), sources]
  }
  return null
}

/** `(` 起到与之配对、且其后只剩空白的 `)` 之间的文本。 */
function balancedCallAtEnd(text, open) {
  if (text[open] !== "(") return null
  let depth = 1
  let quote = null
  let escape = false
  for (let index = open + 1; index < text.length; index++) {
    const ch = text[index]
    if (quote) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === "(") depth++
    else if (ch === ")" && --depth === 0) {
      if (text.slice(index + 1).trim()) return null
      return text.slice(open + 1, index)
    }
  }
  return null
}

function splitHeading(text) {
  for (const match of [...text.matchAll(SOURCES_HEADING)].reverse()) {
    const sources = sourcesFromText(text.slice(match.index))
    if (sources.length) return [text.slice(0, match.index).trimEnd(), sources]
  }
  return null
}

function splitDetails(text) {
  const lower = text.toLowerCase()
  const close = lower.lastIndexOf("</details>")
  if (close === -1 || text.slice(close + 10).trim()) return null
  const open = lower.lastIndexOf("<details", close)
  if (open === -1) return null
  const sources = sourcesFromText(text.slice(open, close + 10))
  return sources.length >= 2 ? [text.slice(0, open).trimEnd(), sources] : null
}

const isLinkOnly = (line) => {
  const stripped = line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim()
  if (!stripped) return false
  return isHttp(stripped) || /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/.test(stripped)
}

function splitTailLinks(text) {
  const lines = text.split("\n")
  let index = lines.length - 1
  while (index >= 0 && !lines[index].trim()) index--
  if (index < 0) return null
  const end = index
  let links = 0
  for (; index >= 0; index--) {
    const line = lines[index].trim()
    if (!line) continue
    if (!isLinkOnly(line)) break
    links++
  }
  if (links < 2) return null
  const sources = sourcesFromText(lines.slice(index + 1, end + 1).join("\n"))
  return sources.length ? [lines.slice(0, index + 1).join("\n").trimEnd(), sources] : null
}

/** `sources(...)` 的参数：JSON，或 Python 字面量（单引号、True / None、元组）。 */
function parsePayload(payload) {
  const text = (payload ?? "").trim().replace(/;+$/, "")
  if (!text) return []
  let data
  try {
    data = JSON.parse(text)
  } catch {
    try {
      data = JSON.parse(pythonLiteralToJson(text))
    } catch {
      return sourcesFromText(text)
    }
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of ["sources", "citations", "references", "urls"])
      if (key in data) return normalizeSources(data[key])
  }
  return normalizeSources(data)
}

/** Python 字面量 → JSON 文本：单引号字符串转双引号，True / False / None，元组括号。 */
function pythonLiteralToJson(text) {
  let out = ""
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (ch === "'" || ch === '"') {
      let value = ""
      for (index++; index < text.length && text[index] !== ch; index++) {
        if (text[index] === "\\" && index + 1 < text.length) value += text[++index]
        else value += text[index]
      }
      if (index >= text.length) throw new Error("unterminated string")
      out += JSON.stringify(value)
    } else if (ch === "(") out += "["
    else if (ch === ")") out += "]"
    else out += ch
  }
  return out
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/,\s*([\]}])/g, "$1")
}

function normalizeSources(data) {
  const items = Array.isArray(data) ? data : [data]
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (typeof item === "string") {
      for (const url of extractUniqueUrls(item))
        if (!seen.has(url)) {
          seen.add(url)
          out.push({ url })
        }
    } else if (Array.isArray(item) && item.length >= 2) {
      const [title, url] = item
      if (isHttp(url) && !seen.has(url)) {
        seen.add(url)
        const source = { url }
        if (typeof title === "string" && title.trim()) source.title = title.trim()
        out.push(source)
      }
    } else if (item && typeof item === "object") {
      const url = item.url || item.href || item.link
      if (!isHttp(url) || seen.has(url)) continue
      seen.add(url)
      const source = { url }
      const title = item.title || item.name || item.label
      if (typeof title === "string" && title.trim()) source.title = title.trim()
      const description = item.description || item.snippet || item.content
      if (typeof description === "string" && description.trim())
        source.description = description.trim()
      out.push(source)
    }
  }
  return out
}

function sourcesFromText(text) {
  const seen = new Set()
  const sources = []
  for (const [, title, link] of (text ?? "").matchAll(MD_LINK)) {
    const url = (link ?? "").trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    sources.push(title.trim() ? { title: title.trim(), url } : { url })
  }
  for (const url of extractUniqueUrls(text))
    if (!seen.has(url)) {
      seen.add(url)
      sources.push({ url })
    }
  return sources
}

function inlineCitationSources(text) {
  const seen = new Set()
  const sources = []
  for (const [, number, link] of (text ?? "").matchAll(INLINE_CITATION)) {
    const url = (link ?? "").trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    sources.push({ title: number, url })
  }
  return sources
}
