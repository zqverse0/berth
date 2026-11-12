// xAI Responses API（原 providers/xai_responses.py）：`/responses` + web_search / x_search 工具。

import { check, request } from "../http.js"
import { SEARCH_PROMPT, userPrompt } from "./openai-compatible.js"

export const NAME = "xAI Responses"

export function searchRequest(provider, query, platform, now, retry) {
  return request(`${provider.url}/responses`, {
    headers: {
      Authorization: `Bearer ${provider.key}`,
      Accept: "application/json",
      "User-Agent": "smart-search/0.1.0",
    },
    json: {
      model: provider.model,
      instructions: SEARCH_PROMPT,
      input: [{ role: "user", content: userPrompt(query, platform, now) }],
      stream: false,
      tools: provider.tools.map((type) => ({ type })),
    },
    timeoutMs: provider.timeoutMs,
    retry,
  })
}

/** output_text 拼成回答，url_citation 注解附在末尾 `sources([...])`。 */
export function parseSearch(response) {
  const data = JSON.parse(check(response).text)
  const parts = []
  const sources = []
  const seen = new Set()
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (!item || typeof item !== "object") continue
    for (const content of item.content ?? []) {
      if (content?.type !== "output_text") continue
      if (typeof content.text === "string" && content.text) parts.push(content.text)
      for (const note of content.annotations ?? []) {
        if (note?.type !== "url_citation") continue
        const url = note.url
        if (
          typeof url !== "string" ||
          !(url.startsWith("http://") || url.startsWith("https://")) ||
          seen.has(url)
        )
          continue
        seen.add(url)
        const source = { url }
        if (typeof note.title === "string" && note.title.trim())
          source.title = note.title.trim()
        sources.push(source)
      }
    }
  }
  let answer = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  if (sources.length)
    answer = `${answer}\n\nsources(${JSON.stringify(sources)})`.trim()
  return answer
}
