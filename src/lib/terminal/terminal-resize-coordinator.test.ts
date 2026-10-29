import { afterEach, describe, expect, it, vi } from "vitest"
import { createTerminalResizeCoordinator } from "./terminal-resize-coordinator"

describe("createTerminalResizeCoordinator", () => {
  afterEach(() => vi.useRealTimers())

  it("coalesces requests into one measured authoritative apply", async () => {
    vi.useFakeTimers()
    let size = { cols: 80, rows: 24 }
    const apply = vi.fn(async () => {})
    const measure = vi.fn(() => size)
    const coordinator = createTerminalResizeCoordinator({ measure, apply })

    coordinator.request()
    size = { cols: 100, rows: 40 }
    coordinator.request()
    await vi.runAllTimersAsync()

    expect(measure).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledWith({ cols: 100, rows: 40 })
    coordinator.dispose()
  })

  it("serializes an apply and merges requests received while it is pending", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const firstApply = new Promise<void>((resolve) => {
      release = resolve
    })
    const apply = vi
      .fn<(_: { cols: number; rows: number }) => Promise<void>>()
      .mockReturnValueOnce(firstApply)
      .mockResolvedValueOnce(undefined)
    let size = { cols: 80, rows: 24 }
    const coordinator = createTerminalResizeCoordinator({
      measure: () => size,
      apply,
    })

    coordinator.request()
    await vi.runAllTimersAsync()
    expect(apply).toHaveBeenCalledOnce()

    size = { cols: 90, rows: 30 }
    coordinator.request()
    release()
    await vi.runAllTimersAsync()

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenLastCalledWith({ cols: 90, rows: 30 })
    coordinator.dispose()
  })

  it("waits for a stable grid instead of applying intermediate layout sizes", async () => {
    vi.useFakeTimers()
    const sizes = [
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
      { cols: 120, rows: 40 },
      { cols: 120, rows: 40 },
    ]
    const apply = vi.fn(async () => {})
    const measure = vi.fn(() => sizes.shift() ?? { cols: 120, rows: 40 })
    const coordinator = createTerminalResizeCoordinator({ measure, apply })

    coordinator.request()
    await vi.runAllTimersAsync()

    expect(measure).toHaveBeenCalledTimes(4)
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith({ cols: 120, rows: 40 })
    coordinator.dispose()
  })

  it("lets an explicit commit skip the observer stability window", async () => {
    vi.useFakeTimers()
    const apply = vi.fn(async () => {})
    const measure = vi.fn(() => ({ cols: 100, rows: 40 }))
    const coordinator = createTerminalResizeCoordinator({ measure, apply })

    coordinator.requestStable()
    await vi.runAllTimersAsync()

    expect(measure).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith({ cols: 100, rows: 40 })
    coordinator.dispose()
  })

  it("upgrades a pending stability wait when a commit arrives", async () => {
    vi.useFakeTimers()
    const apply = vi.fn(async () => {})
    let size = { cols: 80, rows: 24 }
    const measure = vi.fn(() => size)
    const coordinator = createTerminalResizeCoordinator({ measure, apply })

    coordinator.request()
    await vi.advanceTimersByTimeAsync(16)
    size = { cols: 100, rows: 40 }
    coordinator.requestStable()
    await vi.runAllTimersAsync()

    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith({ cols: 100, rows: 40 })
    coordinator.dispose()
  })

  it("reports duplicate dimensions without applying them again", async () => {
    vi.useFakeTimers()
    const onDuplicate = vi.fn()
    const apply = vi.fn(async () => {})
    const coordinator = createTerminalResizeCoordinator({
      measure: () => ({ cols: 80, rows: 24 }),
      apply,
      onDuplicate,
    })

    coordinator.request()
    await vi.runAllTimersAsync()
    coordinator.request()
    await vi.runAllTimersAsync()

    expect(apply).toHaveBeenCalledOnce()
    expect(onDuplicate).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    coordinator.dispose()
  })

  it("does not treat a degraded apply as authoritative", async () => {
    vi.useFakeTimers()
    let applied = false
    const apply = vi.fn(async () => applied)
    const coordinator = createTerminalResizeCoordinator({
      measure: () => ({ cols: 100, rows: 40 }),
      apply,
    })

    coordinator.request()
    await vi.runAllTimersAsync()
    applied = true
    coordinator.request()
    await vi.runAllTimersAsync()

    expect(apply).toHaveBeenCalledTimes(2)
    coordinator.dispose()
  })

  it("cancels pending work on dispose", async () => {
    vi.useFakeTimers()
    const apply = vi.fn(async () => {})
    const coordinator = createTerminalResizeCoordinator({
      measure: () => ({ cols: 80, rows: 24 }),
      apply,
    })

    coordinator.request()
    coordinator.dispose()
    await vi.runAllTimersAsync()

    expect(apply).not.toHaveBeenCalled()
  })
})
