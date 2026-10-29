// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// tool.json `usage.command`：从 Codex 自己写的会话记录里取最近一次订阅额度。
//
// Codex 每轮都把服务端返回的 `rate_limits` 写进 ~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl。
// 这里只读本机文件、不读凭证、不联网；只认 ChatGPT 订阅（limit_id=codex）的记录，中转站会话不会覆盖。
// 输出 {"rate_limits": …, "updatedAt": 毫秒}。

const SESSIONS = "~/.codex/sessions"
const MAX_FILES = 40 // ponytail: 只扫最近 40 个会话，更久没用订阅就视为暂无数据

const list = (/** @type {string} */ dir) => berth.fs.list(dir).catch(() => [])

/** 文件里最后一条订阅额度记录。 */
function latest(/** @type {string} */ text) {
  let found = null
  for (const line of text.split("\n")) {
    if (!line.includes('"rate_limits"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const limits = event?.payload?.rate_limits
    if (
      limits &&
      typeof limits === "object" &&
      limits.limit_id === "codex" &&
      limits.primary
    ) {
      found = { rate_limits: limits, timestamp: event.timestamp }
    }
  }
  return found
}

export default async function () {
  const files = []
  for (const year of await list(SESSIONS)) {
    for (const month of await list(`${SESSIONS}/${year}`)) {
      for (const day of await list(`${SESSIONS}/${year}/${month}`)) {
        for (const name of await list(`${SESSIONS}/${year}/${month}/${day}`)) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue
          const path = `${SESSIONS}/${year}/${month}/${day}/${name}`
          const stat = await berth.fs.stat(path)
          if (stat?.kind === "file") files.push({ path, mtime: stat.mtimeMs })
        }
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const { path } of files.slice(0, MAX_FILES)) {
    const record = latest(await berth.fs.readText(path))
    if (!record) continue
    const updatedAt =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN
    console.log(
      JSON.stringify(
        Number.isNaN(updatedAt)
          ? { rate_limits: record.rate_limits }
          : { rate_limits: record.rate_limits, updatedAt }
      )
    )
    return 0
  }
  console.error("no ChatGPT subscription rate limits in recent Codex sessions")
  return 1
}
