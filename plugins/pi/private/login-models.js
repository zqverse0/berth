// @ts-check
/// <reference path="../../berth-plugin.d.ts" />
// tool.json `logins[].models.command`：把 `pi --list-models` 的表格转成 JSON。
//
// 用法：login-models.js <pi-provider>，只输出该来源（如 openai-codex）的模型，
// id 带来源前缀（`openai-codex/gpt-5.5`），Pi 的 `--model` 可直接用它选中这个登录。
// 数据由 Pi 自己列出，不读凭证、不联网。

export default async function (/** @type {string[]} */ argv) {
  if (argv.length !== 1 || !argv[0]) {
    console.error("usage: login-models.js <pi-provider>")
    return 2
  }
  const provider = argv[0]
  const result = await berth.process.exec("pi", ["--list-models"], {
    timeoutMs: 15000,
  })
  if (result.code !== 0) {
    console.error(
      result.stderr.trim() || `pi --list-models exited with ${result.code}`
    )
    return 1
  }
  const models = []
  for (const line of result.stdout.split("\n").slice(1)) {
    // 首行是表头
    const columns = line.split(/\s+/).filter(Boolean)
    if (columns.length >= 2 && columns[0] === provider)
      models.push({ id: `${provider}/${columns[1]}`, name: columns[1] })
  }
  console.log(JSON.stringify({ models }))
  return 0
}
