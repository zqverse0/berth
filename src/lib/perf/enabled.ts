/**
 * Performance instrumentation feature flag.
 *
 * Disabled by default. Enabled via `localStorage.berth.perf = "1"` and
 * requires a page reload to take effect (the transport singleton is
 * created once and not hot-swapped).
 *
 * Production mode is always disabled regardless of localStorage.
 *
 * Two independent states are tracked:
 * - **configured**: the localStorage switch is set (read via `perfEnabled()`).
 * - **active**: the current Transport singleton was actually wrapped by
 *   `withPerf()` at creation time. This is set once during singleton creation
 *   and does not change until the next page load.
 *
 * After `__perf.on()` but before reload, configured = true but active = false.
 */

const STORAGE_KEY = "berth.perf"

function isProduction(): boolean {
  return process.env.NODE_ENV === "production"
}

function isTest(): boolean {
  return process.env.NODE_ENV === "test"
}

/** Read the localStorage switch. SSR-safe. */
function readStorageFlag(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

/** Write the localStorage switch. SSR-safe no-op. */
export function setEnabled(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, "1")
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Storage unavailable (private mode, quota, SSR) — ignore.
  }
}

/**
 * Whether perf instrumentation is configured (localStorage switch is set
 * and not in production). This does NOT mean the current Transport is
 * actually wrapped — see `isTransportActive()` for that.
 */
export function perfEnabled(): boolean {
  if (isProduction()) return false
  if (isTest()) return readStorageFlag()
  return readStorageFlag()
}

// ── Transport active state ─────────────────────────────────────────────

let _transportActive = false

/**
 * Mark whether the current Transport singleton was wrapped with the perf
 * proxy. Called by `withPerf()` at singleton creation time. Does not
 * hot-swap an already-created Transport.
 */
export function setTransportActive(value: boolean): void {
  _transportActive = value
}

/**
 * Whether the current Transport singleton is actually wrapped with the
 * perf proxy. This is distinct from `perfEnabled()` (the configured flag):
 * after `__perf.on()` but before reload, `perfEnabled()` is true but
 * `isTransportActive()` is false.
 */
export function isTransportActive(): boolean {
  return _transportActive
}

/** @internal exposed for tests */
export const _internal = { STORAGE_KEY }

/** @internal test-only reset */
export function __resetTransportActiveForTests(): void {
  _transportActive = false
}
