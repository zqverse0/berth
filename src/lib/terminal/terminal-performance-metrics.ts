export type TerminalPerformanceMode = "spawn" | "attach"

export interface TerminalPerformanceSnapshot {
  terminalId: string
  mode: TerminalPerformanceMode
  ptyChunks: number
  transportFrames: number
  transportBytes: number
  termWrites: number
  termWriteBytes: number
  appliedSamples: number
  appliedLatencyP95Ms: number
  resyncs: number
  droppedBytes: number
  resizeRequests: number
  resizeApplied: number
  duplicateResizes: number
  /** xterm term.resize() 同步耗时(reflow 主体),样本数与 p50/p95。 */
  termResizeSamples: number
  termResizeP50Ms: number
  termResizeP95Ms: number
}

interface TerminalPerformanceCounters extends Omit<
  TerminalPerformanceSnapshot,
  | "appliedSamples"
  | "appliedLatencyP95Ms"
  | "termResizeSamples"
  | "termResizeP50Ms"
  | "termResizeP95Ms"
> {
  appliedLatencies: number[]
  termResizeLatencies: number[]
}

export interface TerminalPerformanceMetrics {
  snapshot: () => TerminalPerformanceSnapshot[]
  reset: () => void
}

declare global {
  interface Window {
    __berthTerminalMetrics?: TerminalPerformanceMetrics
  }
}

const MAX_LATENCY_SAMPLES = 512
const counters = new Map<string, TerminalPerformanceCounters>()

function isEnabled(): boolean {
  return process.env.NODE_ENV === "development"
}

function getCounters(
  terminalId: string,
  mode: TerminalPerformanceMode
): TerminalPerformanceCounters | null {
  if (!isEnabled()) return null
  const existing = counters.get(terminalId)
  if (existing) return existing
  const created: TerminalPerformanceCounters = {
    terminalId,
    mode,
    ptyChunks: 0,
    transportFrames: 0,
    transportBytes: 0,
    termWrites: 0,
    termWriteBytes: 0,
    appliedLatencies: [],
    resyncs: 0,
    droppedBytes: 0,
    resizeRequests: 0,
    resizeApplied: 0,
    duplicateResizes: 0,
    termResizeLatencies: [],
  }
  counters.set(terminalId, created)
  return created
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ]
}

function percentile95(samples: number[]): number {
  return percentile(samples, 0.95)
}

function snapshot(): TerminalPerformanceSnapshot[] {
  return Array.from(counters.values(), (entry) => ({
    terminalId: entry.terminalId,
    mode: entry.mode,
    ptyChunks: entry.ptyChunks,
    transportFrames: entry.transportFrames,
    transportBytes: entry.transportBytes,
    termWrites: entry.termWrites,
    termWriteBytes: entry.termWriteBytes,
    appliedSamples: entry.appliedLatencies.length,
    appliedLatencyP95Ms: percentile95(entry.appliedLatencies),
    resyncs: entry.resyncs,
    droppedBytes: entry.droppedBytes,
    resizeRequests: entry.resizeRequests,
    resizeApplied: entry.resizeApplied,
    duplicateResizes: entry.duplicateResizes,
    termResizeSamples: entry.termResizeLatencies.length,
    termResizeP50Ms: percentile(entry.termResizeLatencies, 0.5),
    termResizeP95Ms: percentile95(entry.termResizeLatencies),
  }))
}

const MAX_TERM_RESIZE_SAMPLES = 256

/**
 * 记录一次 xterm `term.resize()` 的同步耗时(reflow 主体,含全缓冲
 * 重折行)。拖动 preview 与松手 commit 都走这里——分布的量级对比直接
 * 指示主热点在哪一侧。
 */
export function recordTermResizeLatency(
  terminalId: string,
  mode: TerminalPerformanceMode,
  durationMs: number
): void {
  const entry = getCounters(terminalId, mode)
  if (!entry) return
  if (entry.termResizeLatencies.length >= MAX_TERM_RESIZE_SAMPLES) {
    entry.termResizeLatencies.shift()
  }
  entry.termResizeLatencies.push(durationMs)
}

if (typeof window !== "undefined" && isEnabled()) {
  window.__berthTerminalMetrics = {
    snapshot,
    reset: () => counters.clear(),
  }
}

export function recordTerminalTransportFrame(
  terminalId: string,
  mode: TerminalPerformanceMode,
  bytes: number
): void {
  const entry = getCounters(terminalId, mode)
  if (!entry) return
  entry.ptyChunks += 1
  entry.transportFrames += 1
  entry.transportBytes += bytes
}

export function recordTerminalWrite(
  terminalId: string,
  mode: TerminalPerformanceMode,
  bytes: number
): () => void {
  const entry = getCounters(terminalId, mode)
  if (!entry) return () => {}
  entry.termWrites += 1
  entry.termWriteBytes += bytes
  const startedAt = performance.now()
  return () => {
    const latency = performance.now() - startedAt
    if (entry.appliedLatencies.length === MAX_LATENCY_SAMPLES) {
      entry.appliedLatencies.shift()
    }
    entry.appliedLatencies.push(latency)
  }
}

export function recordTerminalResize(
  terminalId: string,
  mode: TerminalPerformanceMode,
  outcome: "requested" | "applied" | "duplicate"
): void {
  const entry = getCounters(terminalId, mode)
  if (!entry) return
  if (outcome === "requested") entry.resizeRequests += 1
  else if (outcome === "applied") entry.resizeApplied += 1
  else entry.duplicateResizes += 1
}

export function recordTerminalResync(
  terminalId: string,
  mode: TerminalPerformanceMode
): void {
  const entry = getCounters(terminalId, mode)
  if (entry) entry.resyncs += 1
}

export function recordTerminalDroppedBytes(
  terminalId: string,
  mode: TerminalPerformanceMode,
  bytes: number
): void {
  const entry = getCounters(terminalId, mode)
  if (entry) entry.droppedBytes += bytes
}
