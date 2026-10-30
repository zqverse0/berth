#!/usr/bin/env node
//
// Drop-in wrapper for the package.json `tauri` script.
// On Linux, fills DISPLAY/XAUTHORITY when missing (SSH/tmux), then execs the
// real `@tauri-apps/cli` binary entry (`tauri.js`) with the original args.
//
// Usage (via pnpm):
//   pnpm tauri dev
//   pnpm tauri build
//

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { chmodSync, mkdirSync } from "node:fs"
import process from "node:process"
import { ensureLinuxDisplay } from "./ensure-linux-display.mjs"
import { configureDevInstance, linkDevPlugins } from "./dev-instance-env.mjs"

ensureLinuxDisplay()

const require = createRequire(import.meta.url)

// IMPORTANT: package "main" is main.js (library API only). Spawning that file
// with node loads the module and exits 0 immediately — no CLI. The bin entry
// is tauri.js (see @tauri-apps/cli package.json "bin.tauri").
let tauriJs
try {
  tauriJs = require.resolve("@tauri-apps/cli/tauri.js")
} catch {
  try {
    const pkgJson = require.resolve("@tauri-apps/cli/package.json")
    tauriJs = join(dirname(pkgJson), "tauri.js")
  } catch {
    console.error(
      "[tauri-with-display] @tauri-apps/cli not found — run pnpm install first"
    )
    process.exit(1)
  }
}

const args = process.argv.slice(2)
const isDev = args[0] === "dev"

if (isDev) {
  try {
    configureDevInstance(process.env)
    linkDevPlugins(process.env, join(import.meta.dirname, ".."))
  } catch (error) {
    console.error(`[tauri-with-display] ${error.message}`)
    process.exit(1)
  }
  console.log(`[tauri-with-display] dev assets at ${process.env.BERTH_HOME}`)
  console.log(`[tauri-with-display] dev plugins at ${join(import.meta.dirname, "..", "plugins")}`)
  console.log(
    `[tauri-with-display] dev database at ${process.env.BERTH_DATA_DIR}/${process.env.BERTH_DATA_FILE}`
  )

  const hasConfigOverride = args.some(
    (arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config=")
  )
  if (!hasConfigOverride) {
    args.push("--config", "src-tauri/tauri.dev.conf.json")
    console.log("[tauri-with-display] dev identity isolated as app.berth.dev")
  }

  // 默认 GUI socket 的父目录必须为当前用户独占；自定义 socket 不改目录权限。
  const socketDir = join(
    process.env.XDG_RUNTIME_DIR?.trim() || "/tmp",
    "berth-dev"
  )
  if (
    process.env.BERTH_GUI_ENDPOINT === join(socketDir, "gui") ||
    process.env.BERTH_TMPDIR === socketDir
  ) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 })
    chmodSync(socketDir, 0o700)
  }
  console.log(
    `[tauri-with-display] dev GUI control endpoint isolated at ${process.env.BERTH_GUI_ENDPOINT}`
  )
  console.log(
    `[tauri-with-display] dev terminal daemon isolated under ${process.env.BERTH_TMPDIR}`
  )
}

const child = spawn(process.execPath, [tauriJs, ...args], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on("error", (err) => {
  console.error("[tauri-with-display] failed to spawn tauri CLI:", err)
  process.exit(1)
})
