import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Transport } from "@/lib/transport/types"
import { withPerf } from "./transport-proxy"
import { __resetCollectorForTests, getCollector } from "./collector"
import * as enabled from "./enabled"

function makeFakeTransport(overrides?: Partial<Transport>): Transport {
  return {
    call: vi.fn(async () => "ok") as unknown as Transport["call"],
    subscribe: vi.fn(async () => () => {}),
    isDesktop: () => true,
    ...overrides,
  }
}

describe("withPerf", () => {
  beforeEach(() => {
    vi.spyOn(enabled, "perfEnabled").mockReturnValue(true)
    enabled.__resetTransportActiveForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetCollectorForTests()
    enabled.__resetTransportActiveForTests()
  })

  it("returns base identity when disabled", () => {
    vi.spyOn(enabled, "perfEnabled").mockReturnValue(false)
    const base = makeFakeTransport()
    const wrapped = withPerf(base)
    expect(wrapped).toBe(base)
  })

  it("returns a proxy (not base) when enabled", () => {
    const base = makeFakeTransport()
    const wrapped = withPerf(base)
    expect(wrapped).not.toBe(base)
  })

  it("records successful call and resolves original value", async () => {
    const base = makeFakeTransport({
      call: vi.fn(async () => ({ data: 42 })) as unknown as Transport["call"],
    })
    const wrapped = withPerf(base)

    const result = await wrapped.call("test_cmd", { foo: "bar" })
    expect(result).toEqual({ data: 42 })

    const stats = getCollector().stats("test_cmd")
    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(1)
    expect(stats!.failures).toBe(0)
  })

  it("records failure and rethrows original error", async () => {
    const originalError = new Error("boom")
    const base = makeFakeTransport({
      call: vi.fn(async () => {
        throw originalError
      }),
    })
    const wrapped = withPerf(base)

    await expect(wrapped.call("fail_cmd")).rejects.toBe(originalError)

    const stats = getCollector().stats("fail_cmd")
    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(1)
    expect(stats!.failures).toBe(1)
  })

  it("preserves optional method existence — undefined stays undefined", () => {
    const base = makeFakeTransport()
    // base has no optional callRaw or destroy method.
    const wrapped = withPerf(base)
    expect(wrapped.callRaw).toBeUndefined()
    expect(wrapped.destroy).toBeUndefined()
  })

  it("preserves defined optional methods and calls through", async () => {
    const unsub = vi.fn()
    const base = makeFakeTransport({
      subscribe: vi.fn(async () => unsub),
    })
    const wrapped = withPerf(base)

    const result = await wrapped.subscribe("evt", () => {})
    expect(result).toBe(unsub)
  })

  it("preserves isDesktop() return value", () => {
    const base = makeFakeTransport({ isDesktop: () => true })
    const wrapped = withPerf(base)
    expect(wrapped.isDesktop()).toBe(true)
  })

  it("does not record subscribe or isDesktop as IPC events", async () => {
    const base = makeFakeTransport()
    const wrapped = withPerf(base)

    await wrapped.subscribe("evt", () => {})
    wrapped.isDesktop()

    const dump = getCollector().dump()
    expect(Object.keys(dump.ipc)).toHaveLength(0)
    expect(dump.timeline).toHaveLength(0)
  })

  it("records duration as non-negative number", async () => {
    const base = makeFakeTransport()
    const wrapped = withPerf(base)

    await wrapped.call("dur_cmd")

    const dump = getCollector().dump()
    expect(dump.timeline[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  describe("this binding for all callable methods", () => {
    it("binds this for class-based transport with private state", async () => {
      // Simulate a class-based transport where methods access private state
      class ClassTransport implements Transport {
        #secret = "class-private"

        async call<T>(
          command: string,
          args?: Record<string, unknown>
        ): Promise<T> {
          void command
          void args
          return `result:${this.#secret}` as unknown as T
        }

        subscribe<T>(
          event: string,
          handler: (payload: T) => void
        ): Promise<() => void> {
          void event
          void handler
          // Access private state via this
          return Promise.resolve(() => this.#secret)
        }

        isDesktop(): boolean {
          return this.#secret === "class-private"
        }

        getSecret(): string {
          return this.#secret
        }
      }

      const base = new ClassTransport()
      const wrapped = withPerf(base)

      // isDesktop should still work (accesses #secret via this)
      expect(wrapped.isDesktop()).toBe(true)

      // subscribe should work (accesses #secret via this)
      const unsub = await wrapped.subscribe("evt", () => {})
      expect(typeof unsub).toBe("function")
    })

    it("binds destroy() to the original target", () => {
      let destroyed = false
      const base = makeFakeTransport({
        destroy: () => {
          destroyed = true
        },
      })
      const wrapped = withPerf(base)
      wrapped.destroy!()
      expect(destroyed).toBe(true)
    })
  })

  describe("transport active state", () => {
    it("sets transport active when wrapping", () => {
      expect(enabled.isTransportActive()).toBe(false)
      const base = makeFakeTransport()
      withPerf(base)
      expect(enabled.isTransportActive()).toBe(true)
    })

    it("does not set transport active when disabled", () => {
      vi.spyOn(enabled, "perfEnabled").mockReturnValue(false)
      const base = makeFakeTransport()
      withPerf(base)
      expect(enabled.isTransportActive()).toBe(false)
    })
  })
})
