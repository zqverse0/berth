// 搜索：AI 回答 + 来源（缺省），或 `--mode sources` 只要来源列表。结果带同项目 30 天内的相同问题记录。

import * as records from "./core/records.js"
import * as route from "./core/route.js"
import { context, entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/search.js <问题> [选项]
  --mode sources            只要来源列表（智谱 / Tavily / Firecrawl，文档类问题加 Context7 / Exa），不等 AI 回答
  --platform <平台>          让 AI 侧重某平台（如 GitHub、Reddit）
  --extra-sources <N>       另取 N 条 Tavily / Firecrawl 来源
  --validation fast|balanced|strict
  --fallback auto|off
  --providers <列表>         限定服务商，如 xai,zhipu`

/** 搜索并写记录；`input.record` 给出时更新那条记录（页面先出来源、再补 AI 回答）。 */
export async function run(input) {
  const { deps, cfg, project, by } = await context()
  const query = String(input.query ?? "").trim()
  const existing = input.record ? [] : await records.find(deps, query, project?.root)
  const result = await route.search(deps, cfg, { ...input, query })
  result.existing_records = existing.filter((item) => item.id !== input.record)
  const entry = { kind: "search", query, mode: input.mode ?? "full", project, by, result }
  // 页面综合模式并发两次：来源列表那次不单独记，AI 搜索那次的记录已含补充来源
  if (input.noRecord) return result
  result.record = input.record
    ? await records.update(deps, input.record, result)
    : await records.write(deps, entry, cfg.retentionDays)
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
