// Context7：查库 / 框架文档。先 library 找库 id，再 docs 取文档片段。

import * as records from "./core/records.js"
import * as route from "./core/route.js"
import { context, entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/c7.js library <库名> [问题]
berth tools run smart-search private/c7.js docs <库 id，如 /vercel/next.js> <问题>`

/** input：{ query }（页面「文档」模式：找库后取第一个库的文档），或 { library, query } / { libraryId, query }。 */
export async function run(input) {
  const { deps, cfg, project, by } = await context()
  const query = String(input.query ?? "").trim()
  let result
  if (input.libraryId) result = await route.context7Docs(deps, cfg, input.libraryId, query)
  else if (input.library) result = await route.context7Library(deps, cfg, input.library, query)
  else {
    // 整句搜库时排在第一的常不是要找的库：前 5 个里取可信度最高的，候选一并返回供切换
    const found = await route.context7Library(deps, cfg, query, "")
    const best = found.ok
      ? found.results.slice(0, 5).reduce((a, b) => ((b.trust_score ?? 0) > (a.trust_score ?? 0) ? b : a), found.results[0])
      : null
    result = best ? { ...(await route.context7Docs(deps, cfg, best.id, query)), libraries: found.results.slice(0, 5) } : found
  }
  result.record = await records.write(
    deps,
    { kind: "search", query: input.libraryId ? `${input.libraryId} ${query}` : input.library ? `${input.library} ${query}`.trim() : query, mode: "context7", project, by, result },
    cfg.retentionDays
  )
  return result
}

export default entry({
  usage: USAGE,
  api: run,
  cli: (argv) => {
    const { positional } = parseArgs(argv)
    const [action, target, ...rest] = positional
    if (action === "library" && target) return run({ library: target, query: rest.join(" ") })
    if (action === "docs" && target && rest.length) return run({ libraryId: target, query: rest.join(" ") })
    throw new UsageError("用法不对")
  },
})
