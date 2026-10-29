/**
 * Perf data collector — bounded aggregation and timeline.
 *
 * All durations in milliseconds from a monotonic clock source.
 * No args, return values, error objects, or user content are stored.
 *
 * IPC and span metrics are tracked in separate namespaces so that
 * identical names cannot collide (e.g. a span "file.open" and an
 * IPC command "file.open" produce distinct entries).
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface PerfEvent {
  kind: "ipc" | "span"
  name: string
  startedAtMs: number
  durationMs: number
  ok: boolean
}

/**
 * Summary statistics for a single metric in the dump output.
 *
 * `p50`, `p95`, `max` are computed from the most recent up to
 * `recentSamples` durations (bounded ring window, capacity = `sampleCapacity`).
 * `count` and `failures` are unbounded full-lifetime counters.
 */
export interface MetricSummary {
  count: number
  failures: number
  p50: number
  p95: number
  max: number
  /**
   * Number of recent durations used for percentile computation.
   * ≤ sampleCapacity (1000). When < count, older samples have been
   * evicted from the ring window.
   */
  recentSamples: number
}

export interface SceneMeta {
  name: string
  startedAtMs: number
  endedAtMs: number | null
  wallClockMs: number | null
}

export interface PerfDump {
  /** Monotonic clock source used ("performance.now" | "Date.now"). */
  clockType: "performance.now" | "Date.now"
  /** Maximum recent samples retained per metric for percentile computation. */
  sampleCapacity: number
  /** Maximum events retained in timeline. */
  timelineCapacity: number
  /**
   * Per-command IPC metrics. Keyed by command name.
   * Separated from spans to prevent name collisions.
   */
  ipc: Record<string, MetricSummary>
  /**
   * Per-span metrics (Phase B manual probes). Keyed by span name.
   * Separated from IPC to prevent name collisions.
   */
  spans: Record<string, MetricSummary>
  /** Bounded timeline of recent events (oldest → newest). */
  timeline: PerfEvent[]
  /** Active or last-completed scene metadata, if any. */
  scene: SceneMeta | null
  /** Unix ms timestamp of the dump. */
  dumpedAt: number
}

// ── Constants ──────────────────────────────────────────────────────────

const SAMPLE_CAPACITY = 1000
const TIMELINE_CAPACITY = 1000

// ── Clock ──────────────────────────────────────────────────────────────

function hasPerformanceNow(): boolean {
  return (
    typeof performance !== "undefined" && typeof performance.now === "function"
  )
}

/** Monotonic clock source. Falls back to Date.now() if unavailable. */
export function nowMs(): number {
  if (hasPerformanceNow()) return performance.now()
  return Date.now()
}

export function clockType(): "performance.now" | "Date.now" {
  return hasPerformanceNow() ? "performance.now" : "Date.now"
}

// ── Ring buffer helpers ────────────────────────────────────────────────

class RingBuffer {
  private buf: number[]
  private head = 0
  private size = 0
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.buf = new Array<number>(capacity)
  }

  push(value: number): void {
    this.buf[this.head] = value
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size++
  }

  /** Return elements oldest → newest. */
  toArray(): number[] {
    if (this.size === 0) return []
    if (this.size < this.capacity) {
      return this.buf.slice(0, this.size)
    }
    // Full: head points at oldest
    const start = this.head
    return [...this.buf.slice(start), ...this.buf.slice(0, start)]
  }

  clear(): void {
    this.head = 0
    this.size = 0
  }
}

class EventRingBuffer {
  private buf: PerfEvent[]
  private head = 0
  private size = 0
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.buf = new Array<PerfEvent>(capacity)
  }

  push(event: PerfEvent): void {
    this.buf[this.head] = event
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size++
  }

  /** Return events oldest → newest. */
  toArray(): PerfEvent[] {
    if (this.size === 0) return []
    if (this.size < this.capacity) {
      return this.buf.slice(0, this.size)
    }
    const start = this.head
    return [...this.buf.slice(start), ...this.buf.slice(0, start)]
  }

  clear(): void {
    this.head = 0
    this.size = 0
  }
}

// ── Percentile ─────────────────────────────────────────────────────────

/**
 * Nearest-rank percentile on a pre-sorted array.
 * Returns NaN for empty arrays.
 */
export function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(rank, sorted.length) - 1]
}

// ── Internal metric entry ──────────────────────────────────────────────

interface InternalMetric {
  count: number
  failures: number
  ring: RingBuffer
}

function computeSummary(entry: InternalMetric): MetricSummary {
  const sorted = [...entry.ring.toArray()].sort((a, b) => a - b)
  return {
    count: entry.count,
    failures: entry.failures,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : NaN,
    recentSamples: sorted.length,
  }
}

// ── Collector ──────────────────────────────────────────────────────────

export class PerfCollector {
  /** IPC metrics keyed by command name. */
  private ipcMetrics = new Map<string, InternalMetric>()
  /** Span metrics keyed by span name. */
  private spanMetrics = new Map<string, InternalMetric>()
  private timeline = new EventRingBuffer(TIMELINE_CAPACITY)
  private scene: SceneMeta | null = null

  /** Record a completed call/span. */
  record(
    kind: PerfEvent["kind"],
    name: string,
    startedAtMs: number,
    durationMs: number,
    ok: boolean
  ): void {
    // Timeline
    this.timeline.push({ kind, name, startedAtMs, durationMs, ok })

    // Metrics — separate namespaces for ipc vs span
    const map = kind === "ipc" ? this.ipcMetrics : this.spanMetrics
    let entry = map.get(name)
    if (!entry) {
      entry = { count: 0, failures: 0, ring: new RingBuffer(SAMPLE_CAPACITY) }
      map.set(name, entry)
    }
    entry.count++
    if (!ok) entry.failures++
    entry.ring.push(durationMs)
  }

  /** Begin a named measurement scene. */
  beginScene(name: string): void {
    this.scene = {
      name,
      startedAtMs: nowMs(),
      endedAtMs: null,
      wallClockMs: null,
    }
  }

  /** End the current scene. */
  endScene(): void {
    if (!this.scene) return
    const end = nowMs()
    this.scene.endedAtMs = end
    this.scene.wallClockMs = end - this.scene.startedAtMs
  }

  /** Reset all collected data. */
  reset(): void {
    this.ipcMetrics.clear()
    this.spanMetrics.clear()
    this.timeline.clear()
    this.scene = null
  }

  /** Export a structured snapshot. */
  dump(): PerfDump {
    const ipc: Record<string, MetricSummary> = {}
    for (const [name, entry] of this.ipcMetrics) {
      ipc[name] = computeSummary(entry)
    }

    const spans: Record<string, MetricSummary> = {}
    for (const [name, entry] of this.spanMetrics) {
      spans[name] = computeSummary(entry)
    }

    return {
      clockType: clockType(),
      sampleCapacity: SAMPLE_CAPACITY,
      timelineCapacity: TIMELINE_CAPACITY,
      ipc,
      spans,
      timeline: this.timeline.toArray(),
      scene: this.scene ? { ...this.scene } : null,
      dumpedAt: Date.now(),
    }
  }

  /** Compute aggregate stats for an IPC metric by name. */
  stats(name: string): MetricSummary | null {
    const entry = this.ipcMetrics.get(name)
    if (!entry) return null
    return computeSummary(entry)
  }

  /** Compute aggregate stats for a span metric by name. */
  spanStats(name: string): MetricSummary | null {
    const entry = this.spanMetrics.get(name)
    if (!entry) return null
    return computeSummary(entry)
  }
}

// ── Singleton ──────────────────────────────────────────────────────────

let _collector: PerfCollector | null = null

export function getCollector(): PerfCollector {
  if (!_collector) _collector = new PerfCollector()
  return _collector
}

/** @internal test-only reset */
export function __resetCollectorForTests(): void {
  _collector = null
}
