// 配置：服务商 key 与参数。key 只写不读，读出来是 `…末4位`。

import * as config from "./core/config.js"
import * as route from "./core/route.js"
import { entry, parseArgs, UsageError } from "./lib.js"

const USAGE = `berth tools run smart-search private/config.js get
berth tools run smart-search private/config.js set <键> <值>
berth tools run smart-search private/config.js unset <键>
berth tools run smart-search private/config.js import      从旧 CLI（${config.LEGACY_FILE}）导入
berth tools run smart-search private/config.js test        逐家测连通`

const deps = () => ({
  http: berth.http,
  fs: berth.fs,
  now: () => Date.now(),
  stateDir: berth.storage.dir,
})

/** input：{ action: get | set | unset | import | test, key?, value? } */
export async function run(input) {
  const d = deps()
  try {
    switch (input.action ?? "get") {
      case "get":
        return { ok: true, config: await config.view(d) }
      case "set":
        await config.set(d, input.key, input.value)
        return { ok: true, config: await config.view(d) }
      case "unset":
        await config.unset(d, input.key)
        return { ok: true, config: await config.view(d) }
      case "import":
        return { ok: true, imported: await config.importLegacy(d), config: await config.view(d) }
      case "test":
        return { ok: true, providers: await route.testConnections(d, await config.resolve(d)) }
      default:
        throw new Error(`unknown action ${input.action}`)
    }
  } catch (error) {
    if (error?.reason === "cancelled") throw error
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export default entry({
  usage: USAGE,
  api: run,
  cli: (argv) => {
    const { positional } = parseArgs(argv)
    const [action = "get", key, ...value] = positional
    if (action === "set" && key && value.length) return run({ action, key, value: value.join(" ") })
    if (action === "unset" && key) return run({ action, key })
    if (["get", "import", "test"].includes(action)) return run({ action })
    throw new UsageError("用法不对")
  },
})
