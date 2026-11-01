#!/usr/bin/env node
// 构建页面插件：每个 plugins/<id>/src/vite.config.mjs 构建到 plugins/<id>/page/（不进 git）。
// dev 实例的 $BERTH_HOME/tools 链到 plugins/，构建后直接生效；scripts/publish-plugins 发布前也跑它。
//
//   node scripts/build-plugins.mjs [<插件 id> ...]   缺省构建全部
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const plugins = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins")
const wanted = process.argv.slice(2)
const ids = readdirSync(plugins).filter(
  (id) =>
    existsSync(join(plugins, id, "src", "vite.config.mjs")) &&
    (!wanted.length || wanted.includes(id))
)
for (const id of wanted) {
  if (!ids.includes(id)) {
    console.error(`build-plugins: ${id} has no src/vite.config.mjs`)
    process.exit(1)
  }
}
for (const id of ids) {
  console.log(`build-plugins: ${id}`)
  await build({
    configFile: join(plugins, id, "src", "vite.config.mjs"),
    logLevel: "warn",
  })
}
