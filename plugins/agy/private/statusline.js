// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// agy statusLine：渲染状态栏，并把 CLI 推给状态栏的配额存成本机快照，
// 供 Berth 按 tool.json `usage.path` 读取用量。
//
// agy 只认全局 ~/.gemini/antigravity-cli/settings.json 的 statusLine，launch.js 在用户未自配时写入
// `berth tools run agy private/statusline.js`。
// 数据由 agy 自己推送（stdin 的 `quota.<bucket>.remaining_fraction / reset_time`，agy 1.3.3 实测），
// 不联网、不读凭证。只在输入带 `quota` 时覆盖快照。剩余比例换算成已用百分比，因为 usage 契约只认已用百分比。

const SNAPSHOT = "~/.cache/berth/agy-statusline.json"
// [bucket 前缀, 状态栏标签]：gemini = Gemini 模型组，3p = Claude / GPT 模型组
const GROUPS = [
  ["gemini", "G"],
  ["3p", "C/G"],
]

function usedQuota(/** @type {any} */ data) {
  const quota = data.quota
  /** @type {Record<string, {used_percent: number, reset_time: unknown}>} */
  const used = {}
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return used
  for (const [bucket, value] of Object.entries(quota)) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.remaining_fraction !== "number"
    )
      continue
    used[bucket] = {
      used_percent: Math.round((1 - value.remaining_fraction) * 1000) / 10,
      reset_time: value.reset_time ?? null,
    }
  }
  return used
}

async function saveSnapshot(/** @type {any} */ data) {
  const quota = usedQuota(data)
  if (!Object.keys(quota).length) return
  await berth.fs.writeText(
    SNAPSHOT,
    JSON.stringify({ plan_tier: data.plan_tier ?? null, quota })
  )
}

const paint = (/** @type {string} */ text, /** @type {string} */ code) =>
  `\x1b[${code}m${text}\x1b[0m`
const danger = (/** @type {number} */ pct) =>
  pct >= 80 ? "31" : pct >= 50 ? "33" : "32" // 越高越危险

function render(/** @type {any} */ data) {
  const name = data.model?.display_name || "?"
  const ctx = Math.trunc(Number(data.context_window?.used_percentage) || 0)
  const parts = [paint(name, "1;36"), paint(`ctx ${ctx}%`, danger(ctx))]
  const quota = usedQuota(data)
  for (const [prefix, label] of GROUPS) {
    const windows = [
      ["5h", "5h"],
      ["weekly", "7d"],
    ]
      .map(([window, short]) => [quota[`${prefix}-${window}`], short])
      .filter(([w]) => w)
      .map(([w, short]) =>
        paint(
          `${short} ${Math.trunc(/** @type {any} */ (w).used_percent)}%`,
          danger(/** @type {any} */ (w).used_percent)
        )
      )
    if (windows.length) parts.push(`${label} ` + windows.join(" "))
  }
  return parts.join(" │ ")
}

export default async function () {
  let data
  try {
    data = JSON.parse(await berth.process.stdin())
  } catch {
    return 0
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return 0
  try {
    await saveSnapshot(data)
  } catch {} // 快照失败不能拖垮状态栏
  console.log(render(data))
  return 0
}
