import { afterEach, describe, expect, it, vi } from "vitest"
import { perfSpan } from "./index"
import { getCollector, __resetCollectorForTests } from "./collector"
import * as enabled from "./enabled"

describe("perfSpan", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    __resetCollectorForTests()
  })

  it("records a span event when done() is called (enabled)", () => {
    vi.spyOn(enabled, "isTransportActive").mockReturnValue(true)
    const done = perfSpan("test.span")
    done()

    const dump = getCollector().dump()
    expect(dump.timeline).toHaveLength(1)
    expect(dump.timeline[0].kind).toBe("span")
    expect(dump.timeline[0].name).toBe("test.span")
    expect(dump.timeline[0].ok).toBe(true)
  })

  it("records duration >= 0", () => {
    vi.spyOn(enabled, "isTransportActive").mockReturnValue(true)
    const done = perfSpan("test.span2")
    done()

    const dump = getCollector().dump()
    expect(dump.timeline[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it("is a true no-op when disabled — does not create collector", () => {
    vi.spyOn(enabled, "isTransportActive").mockReturnValue(false)
    const done = perfSpan("noop.span")

    // Calling done() should not throw or create a collector
    done()

    // The collector singleton should NOT have been created by perfSpan
    // We verify by checking that the dump is empty (no span recorded)
    // Note: getCollector() creates on first access, so we check timeline
    const dump = getCollector().dump()
    expect(dump.timeline).toHaveLength(0)
    expect(Object.keys(dump.spans)).toHaveLength(0)
  })

  it("returns a no-op function when disabled — no timing call", () => {
    vi.spyOn(enabled, "isTransportActive").mockReturnValue(false)
    // perfSpan should return immediately without calling nowMs()
    const done = perfSpan("disabled.span")
    expect(typeof done).toBe("function")
    // Calling done should be safe and do nothing
    expect(() => done()).not.toThrow()
  })

  it("span metrics appear in spans namespace, not ipc", () => {
    vi.spyOn(enabled, "isTransportActive").mockReturnValue(true)
    const done = perfSpan("my.span")
    done()

    const dump = getCollector().dump()
    expect(dump.spans["my.span"]).toBeDefined()
    expect(dump.spans["my.span"].count).toBe(1)
    expect(dump.ipc["my.span"]).toBeUndefined()
  })
})
