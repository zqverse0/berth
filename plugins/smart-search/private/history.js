// 搜索记录：列出、查看（含抓取正文）、按问题查找、删除。

import * as records from "./core/records.js"
import { context, entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/history.js [list] [--all] [--limit N]   最近的记录（缺省只看当前项目）
berth tools run smart-search private/history.js find <问题>                   同项目 30 天内问过的相同问题
berth tools run smart-search private/history.js show <记录 id>                结果与抓取正文
berth tools run smart-search private/history.js remove <记录 id>`

/** input：{ action: list | find | show | remove, all?, limit?, query?, id? } */
export async function run(input) {
  const { deps, project } = await context()
  switch (input.action ?? "list") {
    case "list":
      return {
        ok: true,
        records: await records.list(deps, {
          project: input.all ? undefined : project?.root,
          limit: Number(input.limit) || 50,
        }),
      }
    case "find":
      return { ok: true, records: await records.find(deps, input.query, project?.root) }
    case "show":
      return { ok: true, record: await records.show(deps, input.id) }
    case "remove":
      await records.remove(deps, input.id)
      return { ok: true }
    default:
      throw new Error(`unknown action ${input.action}`)
  }
}

export default entry({
  usage: USAGE,
  api: run,
  cli: (argv) => {
    const { positional, options } = parseArgs(argv, ["all"])
    const [action = "list", ...rest] = positional
    if (action === "list") return run({ action, ...options })
    if (action === "find" && rest.length) return run({ action, query: rest.join(" ") })
    if ((action === "show" || action === "remove") && rest.length === 1) return run({ action, id: rest[0] })
    throw new UsageError("用法不对")
  },
})
