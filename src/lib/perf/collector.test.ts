import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  PerfCollector,
  percentileSorted,
  nowMs,
  clockType,
  __resetCollectorForTests,
} from "./collector"

describe("percentileSorted", () => {
  it("returns NaN for empty array", () => {
    expect(percentileSorted([], 50)).toBeNaN()
  })

  it("returns the only element for single-element array", () => {
    expect(percentileSorted([42], 50)).toBe(42)
    expect(percentileSorted([42], 95)).toBe(42)
    expect(percentileSorted([42], 100)).toBe(42)
  })

  it("computes p50 with nearest-rank on small arrays", () => {
    // [1, 2, 3, 4, 5] → p50: rank = ceil(0.5 * 5) = 3 → index 2 → value 3
    expect(percentileSorted([1, 2, 3, 4, 5], 50)).toBe(3)
  })

  it("computes p95 with nearest-rank", () => {
    // 20 elements: rank = ceil(0.95 * 20) = 19 → index 18
    const arr = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(percentileSorted(arr, 95)).toBe(19)
  })

  it("p100 returns max", () => {
    expect(percentileSorted([1, 3, 5, 7], 100)).toBe(7)
  })
})

describe("nowMs / clockType", () => {
  it("returns a number", () => {
    expect(typeof nowMs()).toBe("number")
  })

  it("clockType returns performance.now in jsdom", () => {
    // jsdom provides performance.now
    expect(clockType()).toBe("performance.now")
  })
})

describe("PerfCollector", () => {
  let collector: PerfCollector

  beforeEach(() => {
    collector = new PerfCollector()
  })

  afterEach(() => {
    __resetCollectorForTests()
  })

  it("records count and failures", () => {
    collector.record("ipc", "cmd_a", 0, 10, true)
    collector.record("ipc", "cmd_a", 0, 20, false)
    collector.record("ipc", "cmd_a", 0, 30, true)

    const stats = collector.stats("cmd_a")
    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(3)
    expect(stats!.failures).toBe(1)
  })

  it("returns null for unknown metric", () => {
    expect(collector.stats("nonexistent")).toBeNull()
  })

  it("p50/p95/max on small sample", () => {
    collector.record("ipc", "cmd_b", 0, 10, true)
    collector.record("ipc", "cmd_b", 0, 20, true)
    collector.record("ipc", "cmd_b", 0, 30, true)

    const stats = collector.stats("cmd_b")!
    // sorted: [10, 20, 30]
    // p50: rank = ceil(0.5 * 3) = 2 → index 1 → 20
    expect(stats.p50).toBe(20)
    // p95: rank = ceil(0.95 * 3) = 3 → index 2 → 30
    expect(stats.p95).toBe(30)
    expect(stats.max).toBe(30)
  })

  it("count is not affected by sample ring eviction", () => {
    // Record more than SAMPLE_CAPACITY (1000) events
    for (let i = 0; i < 1500; i++) {
      collector.record("ipc", "cmd_c", 0, i, true)
    }
    const stats = collector.stats("cmd_c")!
    expect(stats.count).toBe(1500)
    // recentSamples (ring window) holds at most 1000
    expect(stats.recentSamples).toBe(1000)
  })

  it("timeline preserves order and respects capacity", () => {
    for (let i = 0; i < 5; i++) {
      collector.record("ipc", `cmd_${i}`, i * 100, 10, true)
    }
    const dump = collector.dump()
    expect(dump.timeline.length).toBe(5)
    expect(dump.timeline[0].name).toBe("cmd_0")
    expect(dump.timeline[4].name).toBe("cmd_4")
  })

  it("timeline capacity is bounded", () => {
    for (let i = 0; i < 1500; i++) {
      collector.record("ipc", "cmd_x", 0, 1, true)
    }
    const dump = collector.dump()
    expect(dump.timeline.length).toBe(1000)
  })

  it("does not store args or return values", () => {
    collector.record("ipc", "cmd_d", 0, 10, true)
    const dump = collector.dump()
    const event = dump.timeline[0]
    expect(event).toHaveProperty("kind")
    expect(event).toHaveProperty("name")
    expect(event).toHaveProperty("startedAtMs")
    expect(event).toHaveProperty("durationMs")
    expect(event).toHaveProperty("ok")
    expect(Object.keys(event).sort()).toEqual(
      ["durationMs", "kind", "name", "ok", "startedAtMs"].sort()
    )
  })

  it("scene wall-clock", () => {
    collector.beginScene("test.scene")
    // Simulate some time passing
    collector.record("ipc", "cmd_e", 0, 5, true)
    collector.endScene()

    const dump = collector.dump()
    expect(dump.scene).not.toBeNull()
    expect(dump.scene!.name).toBe("test.scene")
    expect(dump.scene!.wallClockMs).toBeGreaterThanOrEqual(0)
    expect(dump.scene!.endedAtMs).not.toBeNull()
  })

  it("reset clears everything", () => {
    collector.record("ipc", "cmd_f", 0, 10, true)
    collector.beginScene("scene1")
    collector.endScene()
    collector.reset()

    const dump = collector.dump()
    expect(Object.keys(dump.ipc)).toHaveLength(0)
    expect(Object.keys(dump.spans)).toHaveLength(0)
    expect(dump.timeline).toHaveLength(0)
    expect(dump.scene).toBeNull()
  })

  it("dump includes metadata", () => {
    const dump = collector.dump()
    expect(dump.clockType).toMatch(/^(performance\.now|Date\.now)$/)
    expect(dump.sampleCapacity).toBe(1000)
    expect(dump.timelineCapacity).toBe(1000)
    expect(typeof dump.dumpedAt).toBe("number")
  })

  describe("separate IPC and span namespaces", () => {
    it("IPC and span with same name do not collide", () => {
      collector.record("ipc", "file.open", 0, 50, true)
      collector.record("ipc", "file.open", 0, 60, true)
      collector.record("span", "file.open", 0, 200, true)

      const dump = collector.dump()
      expect(dump.ipc["file.open"]).toBeDefined()
      expect(dump.spans["file.open"]).toBeDefined()
      expect(dump.ipc["file.open"].count).toBe(2)
      expect(dump.spans["file.open"].count).toBe(1)
      expect(dump.ipc["file.open"].p50).toBe(50)
      expect(dump.spans["file.open"].p50).toBe(200)
    })

    it("spanStats retrieves span metrics independently", () => {
      collector.record("span", "test.span", 0, 100, true)
      collector.record("span", "test.span", 0, 200, false)

      expect(collector.spanStats("test.span")).not.toBeNull()
      expect(collector.spanStats("test.span")!.count).toBe(2)
      expect(collector.spanStats("test.span")!.failures).toBe(1)
      // IPC should not have this name
      expect(collector.stats("test.span")).toBeNull()
    })
  })

  describe("dump format includes computed stats", () => {
    it("dump includes count/failures/p50/p95/max/recentSamples directly", () => {
      collector.record("ipc", "cmd_x", 0, 10, true)
      collector.record("ipc", "cmd_x", 0, 20, true)
      collector.record("ipc", "cmd_x", 0, 30, false)

      const dump = collector.dump()
      const metric = dump.ipc["cmd_x"]
      expect(metric).toBeDefined()
      expect(metric.count).toBe(3)
      expect(metric.failures).toBe(1)
      expect(metric.p50).toBe(20) // sorted [10,20,30], rank=ceil(0.5*3)=2, idx=1
      expect(metric.p95).toBe(30) // rank=ceil(0.95*3)=3, idx=2
      expect(metric.max).toBe(30)
      expect(metric.recentSamples).toBe(3)
    })

    it("dump does NOT contain raw samples array", () => {
      collector.record("ipc", "cmd_y", 0, 10, true)
      const dump = collector.dump()
      const metric = dump.ipc["cmd_y"]
      expect(metric).not.toHaveProperty("samples")
    })

    it("recentSamples label indicates window semantics", () => {
      // Under capacity
      collector.record("ipc", "cmd_z", 0, 5, true)
      collector.record("ipc", "cmd_z", 0, 10, true)
      const dump = collector.dump()
      expect(dump.ipc["cmd_z"].recentSamples).toBe(2)
      expect(dump.ipc["cmd_z"].recentSamples).toBeLessThanOrEqual(
        dump.sampleCapacity
      )
    })
  })
})
