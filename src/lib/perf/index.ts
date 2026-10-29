/**
 * Performance instrumentation — public API.
 *
 * Phase A: automatic IPC measurement via transport decorator.
 * Phase B (conditional): manual span support via perfSpan().
 *
 * @module
 */

import { getCollector, nowMs } from "./collector"
import { isTransportActive } from "./enabled"

export { perfEnabled, setEnabled, isTransportActive } from "./enabled"
export {
  PerfCollector,
  getCollector,
  nowMs,
  clockType,
  percentileSorted,
  type PerfEvent,
  type MetricSummary,
  type SceneMeta,
  type PerfDump,
} from "./collector"
export { withPerf } from "./transport-proxy"
export { installPerfBridge, type PerfBridge } from "./window-bridge"

// ── Phase B: manual span (available but unused until Phase B approved) ─

/**
 * Start a manual performance span. Returns a done() callback that
 * records the span when invoked.
 *
 * When disabled or in production, returns a no-op function without
 * creating a collector or performing any timing — zero overhead.
 *
 * Usage:
 * ```ts
 * // @perf-probe
 * const done = perfSpan("file.open")
 * // ... business logic ...
 * // @perf-probe
 * done()
 * ```
 */
export function perfSpan(name: string): () => void {
  if (!isTransportActive()) return () => {}

  const collector = getCollector()
  const start = nowMs()
  return () => {
    collector.record("span", name, start, nowMs() - start, true)
  }
}
