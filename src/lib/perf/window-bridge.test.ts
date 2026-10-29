import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installPerfBridge, __resetBridgeForTests } from "./window-bridge"
import { __resetCollectorForTests, getCollector } from "./collector"
import * as enabled from "./enabled"

describe("window-bridge", () => {
  beforeEach(() => {
    __resetBridgeForTests()
    __resetCollectorForTests()
    enabled.__resetTransportActiveForTests()
    vi.spyOn(enabled, "perfEnabled").mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetBridgeForTests()
    __resetCollectorForTests()
    enabled.__resetTransportActiveForTests()
  })

  it("installs __perf on window", () => {
    installPerfBridge()
    expect(window.__perf).toBeDefined()
    expect(typeof window.__perf!.on).toBe("function")
    expect(typeof window.__perf!.off).toBe("function")
    expect(typeof window.__perf!.status).toBe("function")
    expect(typeof window.__perf!.reset).toBe("function")
    expect(typeof window.__perf!.begin).toBe("function")
    expect(typeof window.__perf!.end).toBe("function")
    expect(typeof window.__perf!.dump).toBe("function")
    expect(typeof window.__perf!.copy).toBe("function")
  })

  it("is HMR-safe — second install does not replace bridge", () => {
    installPerfBridge()
    const first = window.__perf
    installPerfBridge()
    expect(window.__perf).toBe(first)
  })

  it("status returns configured and active state", () => {
    installPerfBridge()
    // Default: not configured, not active
    expect(window.__perf!.status()).toEqual({
      configured: false,
      active: false,
    })
  })

  it("status distinguishes configured from active after on()", () => {
    installPerfBridge()
    // Simulate: user calls __perf.on() — sets localStorage but does NOT reload
    vi.spyOn(enabled, "perfEnabled").mockReturnValue(true)
    // Transport was NOT recreated, so active is still false
    expect(enabled.isTransportActive()).toBe(false)

    const status = window.__perf!.status()
    expect(status.configured).toBe(true)
    expect(status.active).toBe(false)
  })

  it("status shows active=true when transport was actually wrapped", () => {
    installPerfBridge()
    vi.spyOn(enabled, "perfEnabled").mockReturnValue(true)
    // Simulate that the transport singleton was wrapped at creation
    enabled.setTransportActive(true)

    const status = window.__perf!.status()
    expect(status.configured).toBe(true)
    expect(status.active).toBe(true)
  })

  it("reset clears collector data", () => {
    installPerfBridge()
    getCollector().record("ipc", "cmd", 0, 10, true)
    window.__perf!.reset()
    const dump = window.__perf!.dump()
    expect(Object.keys(dump.ipc)).toHaveLength(0)
  })

  it("begin/end records scene", () => {
    installPerfBridge()
    window.__perf!.begin("test.scene")
    window.__perf!.end()
    const dump = window.__perf!.dump()
    expect(dump.scene).not.toBeNull()
    expect(dump.scene!.name).toBe("test.scene")
  })

  it("records frames slower than 34ms as jank.frame only while a scene runs", () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      frames.push(cb)
    )
    vi.stubGlobal("cancelAnimationFrame", () => frames.splice(0))
    vi.spyOn(performance, "now").mockReturnValue(0)
    installPerfBridge()
    window.__perf!.begin("resize")
    frames.shift()!(16) // smooth frame
    frames.shift()!(80) // 64ms gap -> jank
    window.__perf!.end()
    expect(frames).toHaveLength(0)
    const jank = getCollector().spanStats("jank.frame")
    expect(jank?.count).toBe(1)
    expect(jank?.max).toBe(64)
    vi.unstubAllGlobals()
  })

  it("on() calls setEnabled(true) and returns message", () => {
    const setSpy = vi.spyOn(enabled, "setEnabled")
    installPerfBridge()
    const msg = window.__perf!.on()
    expect(setSpy).toHaveBeenCalledWith(true)
    expect(msg).toMatch(/reload/i)
  })

  it("off() calls setEnabled(false) and returns message", () => {
    const setSpy = vi.spyOn(enabled, "setEnabled")
    installPerfBridge()
    const msg = window.__perf!.off()
    expect(setSpy).toHaveBeenCalledWith(false)
    expect(msg).toMatch(/reload/i)
  })

  it("does not install in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    __resetBridgeForTests()
    installPerfBridge()
    expect(window.__perf).toBeUndefined()
  })
})
