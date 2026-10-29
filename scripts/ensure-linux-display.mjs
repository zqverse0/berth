#!/usr/bin/env node
//
// Ensure a Linux display is available for Tauri/GTK when the shell was started
// without one (common: SSH + tmux on a machine that already has a local :0).
//
// - Import and call ensureLinuxDisplay() to mutate process.env in-place.
// - Or run: node scripts/ensure-linux-display.mjs  (prints what it did).
//
// Does nothing on non-Linux, or when DISPLAY / WAYLAND_DISPLAY is already set
// (still may fill XAUTHORITY if missing).

import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { resolve as resolvePath } from "node:path"
import process from "node:process"

const log = (msg) => console.log(`[ensure-linux-display] ${msg}`)

function candidateXauthorities() {
  const out = []
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) {
    out.push(join(runtime, "gdm", "Xauthority"))
    // GNOME / mutter may drop a transient Xwayland auth file under runtime.
    try {
      for (const name of readdirSync(runtime)) {
        if (name.startsWith(".mutter-Xwaylandauth")) {
          out.push(join(runtime, name))
        }
      }
    } catch {
      // ignore
    }
  }
  out.push(join(homedir(), ".Xauthority"))
  return out
}

/**
 * @returns {{ applied: boolean, display?: string, xauthority?: string, reason: string }}
 */
export function ensureLinuxDisplay() {
  if (process.platform !== "linux") {
    return { applied: false, reason: "not-linux" }
  }

  const hadDisplay = Boolean(
    process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim()
  )

  if (!hadDisplay) {
    const x0 = "/tmp/.X11-unix/X0"
    if (existsSync(x0)) {
      process.env.DISPLAY = ":0"
      log(`DISPLAY was unset; using ${process.env.DISPLAY} (found ${x0})`)
    } else {
      return {
        applied: false,
        reason:
          "no-display: DISPLAY/WAYLAND_DISPLAY unset and /tmp/.X11-unix/X0 missing",
      }
    }
  }

  if (!process.env.XAUTHORITY?.trim()) {
    for (const path of candidateXauthorities()) {
      if (existsSync(path)) {
        process.env.XAUTHORITY = path
        log(`XAUTHORITY was unset; using ${path}`)
        break
      }
    }
  }

  return {
    applied: !hadDisplay || Boolean(process.env.XAUTHORITY),
    display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
    xauthority: process.env.XAUTHORITY,
    reason: hadDisplay ? "display-already-set" : "display-filled",
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href

if (isMain) {
  const result = ensureLinuxDisplay()
  if (result.reason.startsWith("no-display")) {
    console.error(`[ensure-linux-display] ${result.reason}`)
    console.error(
      "[ensure-linux-display] Tauri/GTK will fail without a display. Export DISPLAY (e.g. :0) or run from a desktop session."
    )
  } else {
    log(
      `ok display=${result.display ?? "(none)"} xauthority=${result.xauthority ?? "(none)"} (${result.reason})`
    )
  }
}
