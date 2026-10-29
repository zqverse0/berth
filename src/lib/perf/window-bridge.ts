/**
 * Developer console bridge for perf instrumentation.
 *
 * Mounts `window.__perf` with:
 * - on() / off()       — toggle localStorage switch (reload required)
 * - status()           — configured flag + whether current Transport is wrapped
 * - reset()            — clear all collected data
 * - begin(name)        — start a named measurement scene
 * - end()              — end the current scene
 * - dump()             — return structured JSON snapshot
 * - copy()             — dump() + copy to clipboard (if available)
 *
 * SSR-safe, HMR-safe, production-safe.
 */

import { perfEnabled, setEnabled, isTransportActive } from "./enabled"
import { getCollector, nowMs, type PerfDump } from "./collector"

// Frames slower than two 60Hz frames are recorded as span `jank.frame`.
const JANK_FRAME_MS = 34
let stopFrameWatch: (() => void) | null = null

function watchFrames(): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {}
  let last = nowMs()
  let handle = requestAnimationFrame(function tick(now) {
    const gap = now - last
    if (gap > JANK_FRAME_MS) {
      getCollector().record("span", "jank.frame", last, gap, true)
    }
    last = now
    handle = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(handle)
}

// ── Window type extension ──────────────────────────────────────────────

export interface PerfBridge {
  on(): string
  off(): string
  /**
   * Returns both the configured localStorage state and whether the current
   * Transport singleton was actually wrapped at creation time.
   *
   * After `on()` but before reload: `configured = true`, `active = false`.
   * After reload with flag set: `configured = true`, `active = true`.
   */
  status(): { configured: boolean; active: boolean }
  reset(): string
  begin(name: string): string
  end(): string
  dump(): PerfDump
  copy(): Promise<string>
}

declare global {
  interface Window {
    __perf?: PerfBridge
  }
}

// ── Installation ───────────────────────────────────────────────────────

let _installed = false

export function installPerfBridge(): void {
  if (typeof window === "undefined") return
  if (process.env.NODE_ENV === "production") return
  if (_installed && window.__perf) return

  const bridge: PerfBridge = {
    on() {
      setEnabled(true)
      return "Perf enabled. Reload the page / WebView for the transport proxy to take effect."
    },
    off() {
      setEnabled(false)
      return "Perf disabled. Reload the page / WebView to restore the original transport."
    },
    status() {
      return {
        configured: perfEnabled(),
        active: isTransportActive(),
      }
    },
    reset() {
      getCollector().reset()
      return "Perf data reset."
    },
    begin(name: string) {
      stopFrameWatch?.()
      getCollector().beginScene(name)
      stopFrameWatch = watchFrames()
      return `Scene "${name}" started.`
    },
    end() {
      stopFrameWatch?.()
      stopFrameWatch = null
      getCollector().endScene()
      return "Scene ended."
    },
    dump() {
      return getCollector().dump()
    },
    async copy() {
      const data = JSON.stringify(getCollector().dump(), null, 2)
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(data)
      }
      return data
    },
  }

  window.__perf = bridge
  _installed = true
}

/** @internal test-only: allow re-installation */
export function __resetBridgeForTests(): void {
  _installed = false
  if (typeof window !== "undefined") {
    delete window.__perf
  }
}
