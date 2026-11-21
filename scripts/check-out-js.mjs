// next build 之后逐个解析产物 JS：SWC 压缩偶尔产出非法语法（如模板字符串里的 \00），
// WebKit 会整块拒绝执行、卡在启动页，必须在打包时拦下。
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Script } from "node:vm"

const dir = "out/_next/static"
const bad = []
for (const rel of readdirSync(dir, { recursive: true })) {
  if (!rel.endsWith(".js")) continue
  try {
    new Script(readFileSync(join(dir, rel), "utf8"), { filename: rel })
  } catch (e) {
    bad.push(`${rel}: ${e.message}`)
  }
}
if (bad.length) {
  console.error(`产物 JS 语法错误：\n${bad.join("\n")}`)
  process.exit(1)
}
