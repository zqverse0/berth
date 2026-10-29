import { afterEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  removeTerminalRecord: vi.fn(),
  terminateTerminalSession: vi.fn(),
}))
const tabs = vi.hoisted(() => ({
  closeTab: vi.fn(),
  rawTabs: [
    { kind: "terminal", id: "tab-a", terminalId: "term-a" },
    { kind: "terminal", id: "tab-b", terminalId: "term-b" },
    { kind: "conversation", id: "conv-a" },
  ],
}))

vi.mock("@/lib/api", () => api)
vi.mock("@/stores/tab-store", () => ({
  useTabStore: { getState: () => tabs },
}))

import {
  closeLocalTerminalTabs,
  isTerminalGoneError,
  removeTerminalRecordIdempotent,
  terminateTerminalSessionIdempotent,
} from "./terminal-record-cleanup"

describe("terminal-record-cleanup", () => {
  afterEach(() => {
    api.removeTerminalRecord.mockReset()
    api.terminateTerminalSession.mockReset()
    tabs.closeTab.mockReset()
  })

  it("treats missing and already-exited records as gone", () => {
    expect(isTerminalGoneError({ code: "not_found", message: "gone" })).toBe(
      true
    )
    expect(
      isTerminalGoneError({
        code: "terminal_instance_expired",
        message: "gone",
      })
    ).toBe(true)
    expect(
      isTerminalGoneError({ code: "still_running", message: "busy" })
    ).toBe(false)
  })

  it("removes a record idempotently and closes matching local tabs", async () => {
    api.removeTerminalRecord.mockRejectedValueOnce({
      code: "terminal_not_found",
      message: "gone",
    })

    await removeTerminalRecordIdempotent("term-a")

    expect(api.removeTerminalRecord).toHaveBeenCalledWith("term-a")
    expect(tabs.closeTab).toHaveBeenCalledWith("tab-a")
    expect(tabs.closeTab).not.toHaveBeenCalledWith("tab-b")
  })

  it("terminates, removes, and closes the terminal without hiding failures", async () => {
    await terminateTerminalSessionIdempotent("term-b")

    expect(api.terminateTerminalSession).toHaveBeenCalledWith("term-b")
    expect(api.removeTerminalRecord).toHaveBeenCalledWith("term-b")
    expect(tabs.closeTab).toHaveBeenCalledWith("tab-b")

    api.terminateTerminalSession.mockRejectedValueOnce({
      code: "still_running",
      message: "busy",
    })
    await expect(terminateTerminalSessionIdempotent("term-b")).rejects.toEqual({
      code: "still_running",
      message: "busy",
    })
  })

  it("can close all local tabs for a terminal directly", () => {
    closeLocalTerminalTabs("term-a")
    expect(tabs.closeTab).toHaveBeenCalledWith("tab-a")
  })
})
