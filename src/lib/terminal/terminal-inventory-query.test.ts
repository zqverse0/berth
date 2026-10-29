import { afterEach, describe, expect, it, vi } from "vitest"
import type { TerminalDescriptor } from "@/lib/types"

const api = vi.hoisted(() => ({
  listTerminalSessions: vi.fn(),
}))

vi.mock("@/lib/api", () => api)

import {
  _resetTerminalInventoryQuery,
  fetchTerminalInventory,
  getTerminalInventoryQueryState,
  getTerminalInventorySnapshot,
  refreshTerminalInventory,
  subscribeTerminalInventory,
} from "./terminal-inventory-query"

function descriptor(id: string): TerminalDescriptor {
  return {
    terminalId: id,
    title: id,
    cwd: "/tmp",
    status: "running",
    folderId: 1,
    pid: 1,
    createdAt: "",
    agentType: null,
    shell: "bash",
  } as unknown as TerminalDescriptor
}

afterEach(() => {
  api.listTerminalSessions.mockReset()
  _resetTerminalInventoryQuery()
})

describe("fetchTerminalInventory", () => {
  it("coalesces concurrent callers into a single API call", async () => {
    const descriptors = [descriptor("t1"), descriptor("t2")]
    let resolvePromise!: (value: TerminalDescriptor[]) => void
    api.listTerminalSessions.mockReturnValue(
      new Promise<TerminalDescriptor[]>((resolve) => {
        resolvePromise = resolve
      })
    )

    const callA = fetchTerminalInventory()
    const callB = fetchTerminalInventory()
    const callC = fetchTerminalInventory()

    // All three callers share the same underlying API call.
    expect(api.listTerminalSessions).toHaveBeenCalledTimes(1)

    resolvePromise(descriptors)

    const [resultA, resultB, resultC] = await Promise.all([callA, callB, callC])
    expect(resultA).toEqual(descriptors)
    expect(resultB).toEqual(descriptors)
    expect(resultC).toEqual(descriptors)
  })

  it("releases the in-flight slot on failure so the next call retries", async () => {
    api.listTerminalSessions
      .mockRejectedValueOnce(new Error("transport down"))
      .mockResolvedValueOnce([descriptor("t1")])

    await expect(fetchTerminalInventory()).rejects.toThrow("transport down")

    // After failure, the slot is cleared — a new call issues a fresh request.
    const result = await fetchTerminalInventory()
    expect(result).toEqual([descriptor("t1")])
    expect(api.listTerminalSessions).toHaveBeenCalledTimes(2)
  })

  it("clears the slot after a successful resolution", async () => {
    api.listTerminalSessions
      .mockResolvedValueOnce([descriptor("t1")])
      .mockResolvedValueOnce([descriptor("t2")])

    const first = await fetchTerminalInventory()
    expect(first).toEqual([descriptor("t1")])

    const second = await fetchTerminalInventory()
    expect(second).toEqual([descriptor("t2")])
    expect(api.listTerminalSessions).toHaveBeenCalledTimes(2)
  })

  it("returns the same descriptors to all concurrent callers", async () => {
    const shared = [descriptor("shared")]
    api.listTerminalSessions.mockResolvedValue(shared)

    const results = await Promise.all([
      fetchTerminalInventory(),
      fetchTerminalInventory(),
    ])

    // Both callers receive the same resolved value (identity via shared mock).
    expect(results[0]).toBe(results[1])
    expect(api.listTerminalSessions).toHaveBeenCalledTimes(1)
  })

  it("does not cache results across sequential calls", async () => {
    api.listTerminalSessions
      .mockResolvedValueOnce([descriptor("first")])
      .mockResolvedValueOnce([descriptor("second")])

    const first = await fetchTerminalInventory()
    const second = await fetchTerminalInventory()

    expect(first).toEqual([descriptor("first")])
    expect(second).toEqual([descriptor("second")])
    expect(api.listTerminalSessions).toHaveBeenCalledTimes(2)
  })
})

describe("shared terminal inventory snapshot", () => {
  it("distinguishes a failed request from a successful empty inventory", async () => {
    api.listTerminalSessions.mockResolvedValueOnce([descriptor("live")])
    await refreshTerminalInventory()

    api.listTerminalSessions.mockRejectedValueOnce(new Error("runtime down"))
    await expect(refreshTerminalInventory()).rejects.toThrow("runtime down")
    expect(getTerminalInventorySnapshot()).toHaveLength(1)
    expect(getTerminalInventoryQueryState()).toMatchObject({
      status: "error",
      hasSuccessfulSnapshot: true,
      error: "runtime down",
    })

    api.listTerminalSessions.mockResolvedValueOnce([])
    await expect(refreshTerminalInventory()).resolves.toEqual([])
    expect(getTerminalInventorySnapshot()).toEqual([])
    expect(getTerminalInventoryQueryState()).toMatchObject({
      status: "ready",
      hasSuccessfulSnapshot: true,
      error: null,
    })
  })

  it("reuses the published array when a refresh has no descriptor changes", async () => {
    api.listTerminalSessions
      .mockResolvedValueOnce([descriptor("same")])
      .mockResolvedValueOnce([descriptor("same")])

    const first = await refreshTerminalInventory()
    const second = await refreshTerminalInventory()

    expect(second).toBe(first)
    expect(getTerminalInventorySnapshot()).toBe(first)
    expect(api.listTerminalSessions).toHaveBeenCalledTimes(2)
  })

  it("does not start a periodic poll when subscribers are present", async () => {
    vi.useFakeTimers()
    try {
      api.listTerminalSessions.mockResolvedValue([descriptor("poll")])

      const listenerA = vi.fn()
      const listenerB = vi.fn()
      const unsubscribeA = subscribeTerminalInventory(listenerA)
      const unsubscribeB = subscribeTerminalInventory(listenerB)

      // Subscribe does NOT auto-refresh (no polling). Only explicit refresh
      // triggers an API call.
      expect(api.listTerminalSessions).toHaveBeenCalledTimes(0)

      // Advancing timers does not produce any API calls.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(api.listTerminalSessions).toHaveBeenCalledTimes(0)

      unsubscribeA()
      unsubscribeB()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(api.listTerminalSessions).toHaveBeenCalledTimes(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
