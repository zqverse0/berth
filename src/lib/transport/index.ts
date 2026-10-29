import { assertTauriEnvironment, detectEnvironment } from "./detect"
import type { Transport } from "./types"
import { TauriTransport } from "./tauri-transport"
import { installPerfBridge, withPerf } from "@/lib/perf"

export type { Transport, UnsubscribeFn, CallOptions } from "./types"
export { isRemoteBrowser } from "./detect"

let _shellTransport: Transport | null = null

function createTauriTransport(): Transport {
  assertTauriEnvironment()
  // Install the developer console bridge once (no-op in production / SSR).
  installPerfBridge()
  // Wrap with perf proxy when enabled; returns base unchanged when disabled.
  return withPerf(new TauriTransport())
}

export function getTransport(): Transport {
  if (!_shellTransport) {
    _shellTransport = createTauriTransport()
  }
  return _shellTransport
}

export function isDesktop(): boolean {
  return detectEnvironment() === "tauri"
}
