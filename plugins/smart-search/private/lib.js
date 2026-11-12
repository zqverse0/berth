// 入口脚本共用：把 `berth` 全局接成 core 的 deps，解析命令行，区分两种调用方式。
// Agent：`berth tools run smart-search private/<脚本>.js <参数>` → 参数数组，JSON 打到 stdout，返回退出码。
// 页面：`berth.scripts.run("private/<脚本>.js", input)` → input 对象，返回结果对象。

import * as config from "./core/config.js"

export async function context() {
  const deps = {
    http: berth.http,
    fs: berth.fs,
    now: () => Date.now(),
    stateDir: berth.storage.dir,
  }
  const [cfg, project, agent] = await Promise.all([
    config.resolve(deps),
    berth.env.project(),
    berth.env.agent(),
  ])
  return { deps, cfg, project, by: agent ?? { id: "user" } }
}

/** `--name value` / `--flag` / 位置参数。`flags` 列出不带值的开关。 */
export function parseArgs(argv, flags = []) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
    if (flags.includes(name)) options[name] = true
    else options[name] = argv[++index] ?? ""
  }
  return { positional, options }
}

/**
 * 入口：命令行时把 `cli(argv)` 的结果打成 JSON（`ok: false` 退出码 1，用法错误 2）；
 * 页面时返回 `api(input)` 的结果。
 */
export function entry({ cli, api, usage }) {
  return async (arg) => {
    if (!Array.isArray(arg)) return api(arg ?? {})
    if (arg[0] === "-h" || arg[0] === "--help") {
      console.log(usage)
      return 0
    }
    let result
    try {
      result = await cli(arg)
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(`${error.message}\n\n${usage}`)
        return 2
      }
      throw error
    }
    console.log(JSON.stringify(result, null, 2))
    return result?.ok === false ? 1 : 0
  }
}

export class UsageError extends Error {}
