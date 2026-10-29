import { beforeEach, describe, expect, it, vi } from "vitest"

describe("terminal performance metrics", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("NODE_ENV", "development")
  })

  it("records bounded write latency and transport counters", async () => {
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(14)
    const metrics = await import("./terminal-performance-metrics")

    metrics.recordTerminalTransportFrame("terminal-1", "attach", 12)
    metrics.recordTerminalWrite("terminal-1", "attach", 12)()

    expect(window.__berthTerminalMetrics?.snapshot()).toEqual([
      expect.objectContaining({
        terminalId: "terminal-1",
        ptyChunks: 1,
        transportFrames: 1,
        transportBytes: 12,
        termWrites: 1,
        termWriteBytes: 12,
        appliedSamples: 1,
        appliedLatencyP95Ms: 4,
      }),
    ])
    now.mockRestore()
  })

  it("tracks resize outcomes and resync diagnostics", async () => {
    const metrics = await import("./terminal-performance-metrics")

    metrics.recordTerminalResize("terminal-2", "spawn", "requested")
    metrics.recordTerminalResize("terminal-2", "spawn", "applied")
    metrics.recordTerminalResize("terminal-2", "spawn", "duplicate")
    metrics.recordTerminalResync("terminal-2", "spawn")
    metrics.recordTerminalDroppedBytes("terminal-2", "spawn", 7)

    expect(window.__berthTerminalMetrics?.snapshot()).toEqual([
      expect.objectContaining({
        resizeRequests: 1,
        resizeApplied: 1,
        duplicateResizes: 1,
        resyncs: 1,
        droppedBytes: 7,
      }),
    ])
  })
})
