// Exa：可信来源发现（论文、官方站点、限定域名）。

import * as records from "./core/records.js"
import * as route from "./core/route.js"
import { context, entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/exa.js <问题> [选项]
  --num <N>                 结果数，默认 5
  --include-domains <a,b>   只搜这些域名
  --exclude-domains <a,b>
  --start-date <YYYY-MM-DD> 发布日期下限
  --category <类别>          如 research paper、news、company
  --type neural|keyword|auto
  --text / --highlights     附正文 / 摘录`

export async function run(input) {
  const { deps, cfg, project, by } = await context()
  const query = String(input.query ?? "").trim()
  const existing = await records.find(deps, query, project?.root)
  const result = await route.exaSearch(deps, cfg, {
    query,
    numResults: Number(input.num) || 5,
    type: input.type,
    includeDomains: input.includeDomains,
    excludeDomains: input.excludeDomains,
    startPublishedDate: input.startDate,
    category: input.category,
    text: !!input.text,
    highlights: !!input.highlights,
  })
  result.existing_records = existing
  result.record = await records.write(
    deps,
    { kind: "search", query, mode: "exa", project, by, result },
    cfg.retentionDays
  )
  return result
}

export default entry({
  usage: USAGE,
  api: run,
  cli: (argv) => {
    const { positional, options } = parseArgs(argv, ["text", "highlights"])
    if (!positional.length) throw new UsageError("缺少问题")
    return run({ ...options, query: positional.join(" ") })
  },
})
