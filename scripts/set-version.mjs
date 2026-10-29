import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const version = process.argv[2]?.trim()
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

if (!version || !semverPattern.test(version)) {
  console.error("Usage: pnpm version:set <semver>")
  console.error("Example: pnpm version:set 0.21.4-rc.1")
  process.exit(1)
}

function updateJson(relativePath) {
  const filePath = path.join(root, relativePath)
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"))
  value.version = version
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function replaceOne(relativePath, pattern, replacement, label) {
  const filePath = path.join(root, relativePath)
  const source = fs.readFileSync(filePath, "utf8")
  const matches = source.match(pattern)

  if (!matches || matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${label} in ${relativePath}, found ${matches?.length ?? 0}`
    )
  }

  fs.writeFileSync(filePath, source.replace(pattern, replacement))
}

updateJson("package.json")
updateJson("src-tauri/tauri.conf.json")
// Rust 侧所有 crate 都继承 workspace 版本，只改这一处
replaceOne(
  "src-tauri/Cargo.toml",
  /(?<=\[workspace\.package\]\nversion = ")[^"]+(?=")/g,
  version,
  "workspace package version"
)
// 锁文件里本地 crate 没有 source 行：全部 berth-* 本地条目一起改，保证 --locked 可用
const lockPath = path.join(root, "src-tauri/Cargo.lock")
fs.writeFileSync(
  lockPath,
  fs
    .readFileSync(lockPath, "utf8")
    .replace(
      /(\[\[package\]\]\nname = "berth-[^"]+"\nversion = ")[^"]+("\n(?!source))/g,
      `$1${version}$2`
    )
)

console.log(`Berth version updated to ${version}`)
