// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// Claude Code statusLine：渲染状态栏，并把 CLI 推给状态栏的 JSON 存成本机快照，供 Berth 按
// tool.json `usage.path` 读取用量。会话设置里的命令：`berth tools run claude private/statusline.js`。
//
// 数据由 Claude Code 自己推送，不联网、不读凭证。只在输入带 `rate_limits`（Pro/Max 订阅、会话
// 收到首个响应后）时覆盖快照，API Key / 中转会话不会把订阅额度冲掉。快照只保留 `rate_limits` 与 `model`。

const SNAPSHOT = "~/.cache/berth/claude-statusline.json"

const paint = (/** @type {string} */ text, /** @type {string} */ code) =>
  `\x1b[${code}m${text}\x1b[0m`
const danger = (/** @type {number} */ pct) =>
  pct >= 80 ? "31" : pct >= 50 ? "33" : "32" // 越高越危险
const good = (/** @type {number} */ pct) =>
  pct >= 70 ? "32" : pct >= 40 ? "33" : "31" // 越高越好

/** @param {any} data */
function render(data) {
  const ctx = data.context_window ?? {}
  const usage = ctx.current_usage ?? {}
  const read = usage.cache_read_input_tokens ?? 0
  const total =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + read
  const usedPct = Math.trunc(ctx.used_percentage ?? 0)
  const hit = total ? Math.floor((read * 100) / total) : 0
  const size = Math.floor((ctx.context_window_size ?? 0) / 1000)
  const effort = data.effort?.level // 模型不支持强度参数时缺省
  const model = data.model?.display_name ?? "?"
  const parts = [
    paint(effort ? `${model} · ${effort}` : model, "1;36"),
    paint(
      `ctx ${Math.floor(total / 1000)}k/${size}k ${usedPct}%`,
      danger(usedPct)
    ),
    paint(`cache ${hit}%`, good(hit)),
  ]
  const limits = data.rate_limits ?? {}
  const quota = [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
  ]
    .map(([key, label]) => [label, limits[key]?.used_percentage])
    .filter(([, pct]) => typeof pct === "number")
    .map(([label, pct]) =>
      paint(`${label} ${Math.trunc(Number(pct))}%`, danger(Number(pct)))
    )
  if (quota.length) parts.push(quota.join(" "))
  return parts.join(" │ ")
}

export default async function () {
  let data
  try {
    data = JSON.parse(await berth.process.stdin())
  } catch {
    return 0
  }
  if (!data || typeof data !== "object") return 0
  if (data.rate_limits && typeof data.rate_limits === "object") {
    const snapshot = Object.fromEntries(
      ["rate_limits", "model"]
        .filter((key) => key in data)
        .map((key) => [key, data[key]])
    )
    // 快照失败不能拖垮状态栏。
    await berth.fs.writeText(SNAPSHOT, JSON.stringify(snapshot)).catch(() => {})
  }
  console.log(render(data))
  return 0
}
