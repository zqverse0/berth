// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// Berth `usage.command`：从 Grok CLI 自己的日志里取最近一次订阅额度。
//
// Grok 每次拉取额度都会在 ~/.grok/logs/unified.jsonl 记一条
// `billing: fetched credits config`。这里只读本机日志、不读凭证、不联网。
// 输出 {"credits": ..., "tier": ..., "updatedAt": 毫秒}；`creditUsagePercent` 缺省按 0
// （Grok 在 0% 时不写该字段）。

const LOG = "~/.grok/logs/unified.jsonl"
const MARKER = "billing: fetched credits config"
const TAIL_BYTES = 8 * 1024 * 1024 // 只读日志尾部，日志再大也不整份读入

export default async function () {
  if (!(await berth.fs.stat(LOG))) {
    console.error("grok log not found")
    return 1
  }
  const lines = (await berth.fs.readText(LOG, { tailBytes: TAIL_BYTES })).split(
    "\n"
  )
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line.includes(MARKER)) continue
    /** @type {any} */
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const ctx = event?.ctx || {}
    const credits = { ...(ctx.config || {}) }
    if (!("creditUsagePercent" in credits)) credits.creditUsagePercent = 0 // Grok 在 0% 时不写该字段
    /** @type {Record<string, unknown>} */
    const out = { credits, tier: ctx.subscriptionTier ?? null }
    if (typeof event?.ts === "string") {
      const updatedAt = Date.parse(event.ts)
      if (!Number.isNaN(updatedAt)) out.updatedAt = updatedAt
    }
    console.log(JSON.stringify(out))
    return 0
  }
  console.error("no billing record in recent Grok logs")
  return 1
}
