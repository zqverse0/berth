// 抓网页正文（Tavily extract → Firecrawl scrape），Markdown。正文存进记录。

import * as records from "./core/records.js"
import * as route from "./core/route.js"
import { context, entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/fetch.js <网址>`

/** `input.record` 给出时把正文追加到那条搜索记录，否则新建一条抓取记录。 */
export async function run(input) {
  const { deps, cfg, project, by } = await context()
  const url = String(input.url ?? "").trim()
  if (!/^https?:\/\//.test(url))
    return { ok: false, url, error_type: "parameter_error", error: "url must be http(s)" }
  const result = await route.fetchPage(deps, cfg, url)
  const pages = result.ok ? [{ url, content: result.content }] : []
  if (input.record) {
    if (result.ok) await records.addPage(deps, input.record, pages[0])
    result.record = input.record
  } else {
    result.record = await records.write(
      deps,
      { kind: "fetch", query: url, project, by, result: { ...result, content: undefined }, pages },
      cfg.retentionDays
    )
  }
  return result
}

export default entry({
  usage: USAGE,
  api: run,
  cli: (argv) => {
    const { positional } = parseArgs(argv)
    if (positional.length !== 1) throw new UsageError("需要一个网址")
    return run({ url: positional[0] })
  },
})
