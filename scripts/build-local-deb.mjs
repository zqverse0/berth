import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const srcTauri = path.join(root, "src-tauri")
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(srcTauri, "tauri.conf.json"), "utf8")
)
const version = tauriConfig.version

/**
 * Match cargo/tauri output layout.
 * Honour CARGO_TARGET_DIR (absolute stays absolute; relative resolves under src-tauri).
 * Same rule as src-tauri/scripts/prepare-sidecars.mjs.
 */
function resolveCargoTargetDir() {
  return path.resolve(srcTauri, process.env.CARGO_TARGET_DIR || "target")
}

const packageManager = process.env.npm_execpath
if (!packageManager) {
  throw new Error("npm_execpath is unavailable; run this script through pnpm")
}

const result = spawnSync(
  process.execPath,
  [
    packageManager,
    "exec",
    "tauri",
    "build",
    "--bundles",
    "deb",
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  ],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }
)

if (result.error) {
  throw result.error
}

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const targetDir = resolveCargoTargetDir()
const bundleDir = path.join(targetDir, "release", "bundle", "deb")

if (!fs.existsSync(bundleDir)) {
  throw new Error(
    [
      `Debian bundle directory not found: ${bundleDir}`,
      `CARGO_TARGET_DIR=${process.env.CARGO_TARGET_DIR ?? "(unset)"}`,
      "If cargo wrote the .deb elsewhere, set CARGO_TARGET_DIR to that target root and re-run.",
    ].join("\n")
  )
}

const candidates = fs
  .readdirSync(bundleDir)
  .filter(
    (name) => name.startsWith(`berth_${version}_`) && name.endsWith(".deb")
  )
  .sort()

if (candidates.length !== 1) {
  throw new Error(
    `Expected one Berth ${version} Debian bundle in ${bundleDir}, found: ${candidates.join(", ") || "none"}`
  )
}

const source = path.join(bundleDir, candidates[0])
const outputDir = path.join(root, "outputs")
const destination = path.join(outputDir, candidates[0])
fs.mkdirSync(outputDir, { recursive: true })
fs.copyFileSync(source, destination)

console.log(`Debian package copied to ${destination}`)
