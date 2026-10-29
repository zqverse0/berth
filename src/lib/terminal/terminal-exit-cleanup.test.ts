import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAppUiStore } from "@/stores/app-ui-store"
import {
  handleTerminalExit,
  scheduleTerminalExitCleanup,
} from "./terminal-exit-cleanup"

describe("scheduleTerminalExitCleanup", () => {
  afterEach(() => vi.useRealTimers())

  it("keeps the exit result visible briefly, then removes the terminal record", async () => {
    vi.useFakeTimers()
    const remove = vi.fn(() => Promise.resolve())

    scheduleTerminalExitCleanup("terminal-1", remove)
    expect(remove).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_500)
    expect(remove).toHaveBeenCalledWith("terminal-1")
  })
})

describe("handleTerminalExit", () => {
  beforeEach(() => useAppUiStore.getState().clearAlerts())
  afterEach(() => vi.useRealTimers())

  it("cleans up clean or unknown exits without an alert", async () => {
    vi.useFakeTimers()
    const remove = vi.fn(() => Promise.resolve())
    handleTerminalExit("t-ok", 0, String, remove)
    handleTerminalExit("t-gone", null, String, remove)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(remove).toHaveBeenCalledTimes(2)
    expect(useAppUiStore.getState().alerts).toHaveLength(0)
  })

  it("keeps a failed terminal and alerts once with its last output", async () => {
    vi.useFakeTimers()
    const remove = vi.fn(() => Promise.resolve())
    const readTail = vi.fn(
      async () =>
        "Missing environment variable: KEY\n\n\n\nPane is dead (status 1)"
    )
    const describe = (code: number) => `codex exited (${code})`
    handleTerminalExit("t-fail", 1, describe, remove, readTail)
    handleTerminalExit("t-fail", 1, describe, remove, readTail)
    await vi.advanceTimersByTimeAsync(1_500)

    expect(remove).not.toHaveBeenCalled()
    expect(readTail).toHaveBeenCalledTimes(1)
    expect(useAppUiStore.getState().alerts).toMatchObject([
      {
        level: "error",
        message: "codex exited (1)",
        detail: "Missing environment variable: KEY\nPane is dead (status 1)",
      },
    ])
  })
})
