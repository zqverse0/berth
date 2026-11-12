// 存到知识库「来源」：`.berth/knowledge/来源/<标题>.md`（kind other、digested false，之后由用户自己看、自己整理）。
// 只在用户要求时调用。记录里有这个网址的正文就直接用，没有先抓；抓取失败不写。

import * as records from "./core/records.js"
import * as route from "./core/route.js"
import { context, entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/save.js <网址> [--title <标题>] [--query <当时的问题>]`

/** 正文第一个一级 / 二级标题，没有就用网址。 */
const titleOf = (markdown, url) =>
  markdown.match(/^#{1,2}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() || url.replace(/^https?:\/\//, "").replace(/\/$/, "")

export async function save(input) {
  const { deps, cfg, project, by } = await context()
  const url = String(input.url ?? "").trim()
  if (!/^https?:\/\//.test(url))
    return { ok: false, url, error_type: "parameter_error", error: "url must be http(s)" }
  const existing = await berth.knowledge.findSource(url)
  if (existing) return { ok: true, url, path: existing.path, existed: true }
  let content = input.content || (await records.pageFor(deps, url))
  if (!content) {
    const fetched = await route.fetchPage(deps, cfg, url)
    await records.write(
      deps,
      { kind: "fetch", query: url, project, by, result: { ...fetched, content: undefined }, pages: fetched.ok ? [{ url, content: fetched.content }] : [] },
      cfg.retentionDays
    )
    if (!fetched.ok) return { ok: false, url, error_type: fetched.error_type, error: `抓取失败，未保存：${fetched.error}` }
    content = fetched.content
  }
  const meta = { via: "smart-search", ...(input.query ? { query: String(input.query) } : {}) }
  try {
    const { path } = await berth.knowledge.addSource({
      url,
      title: String(input.title || titleOf(content, url)),
      markdown: content,
      meta,
    })
    return { ok: true, url, path, existed: false }
  } catch (error) {
    if (error?.reason === "conflict") return { ok: true, url, path: error.data?.path, existed: true }
    throw error
  }
}

/** 页面用：一组网址里哪些已存（`{ <url>: path }`）。 */
async function check(urls) {
  const saved = {}
  for (const url of urls ?? []) {
    const found = await berth.knowledge.findSource(url).catch(() => null)
    if (found) saved[url] = found.path
  }
  return saved
}

export default entry({
  usage: USAGE,
  api: (input) => (input.action === "check" ? check(input.urls) : save(input)),
  cli: (argv) => {
    const { positional, options } = parseArgs(argv)
    if (positional.length !== 1) throw new UsageError("需要一个网址")
    return save({ url: positional[0], title: options.title, query: options.query })
  },
})
