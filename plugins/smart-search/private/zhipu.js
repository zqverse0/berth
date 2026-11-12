// 智谱 Web Search：中文、国内、实时信息的来源列表。

import * as records from "./core/records.js"
import * as route from "./core/route.js"
import { context, entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/zhipu.js <问题> [选项]
  --count <N>               结果数，默认 10
  --engine <引擎>            search_std | search_pro | search_pro_sogou | search_pro_quark
  --recency oneDay|oneWeek|oneMonth|oneYear|noLimit
  --domain <域名>            只搜该域名`

export async function run(input) {
  const { deps, cfg, project, by } = await context()
  const query = String(input.query ?? "").trim()
  const existing = await records.find(deps, query, project?.root)
  const result = await route.zhipuSearch(deps, cfg, {
    query,
    count: Number(input.count) || 10,
    engine: input.engine,
    recency: input.recency,
    domain: input.domain,
  })
  result.existing_records = existing
  result.record = await records.write(
    deps,
    { kind: "search", query, mode: "zhipu", project, by, result },
    cfg.retentionDays
  )
  return result
}

export default entry({
  usage: USAGE,
  api: run,
  cli: (argv) => {
    const { positional, options } = parseArgs(argv)
    if (!positional.length) throw new UsageError("缺少问题")
    return run({ ...options, query: positional.join(" ") })
  },
})
