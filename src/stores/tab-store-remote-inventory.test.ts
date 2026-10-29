import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PrimaryTab, TerminalDescriptor } from "@/lib/types"

const refreshTerminalInventory = vi.fn(async () => [] as TerminalDescriptor[])
vi.mock("@/lib/terminal/terminal-inventory-query", () => ({
  refreshTerminalInventory: () => refreshTerminalInventory(),
}))

const { resetTabStore, useTabStore } = await import("./tab-store")

function descriptor(terminalId: string): TerminalDescriptor {
  return {
    terminalId,
    backendInstanceId: "backend",
    folderId: 1,
    title: terminalId,
    initialCwd: "/repo",
    shell: "/bin/bash",
    status: "running",
  } as TerminalDescriptor
}

function remoteTerminal(terminalId: string): PrimaryTab {
  return {
    kind: "terminal",
    id: `terminal:${terminalId}`,
    terminalId,
    backendInstanceId: "backend",
    folderId: 1,
    title: terminalId,
    initialCwd: "/repo",
    shell: "/bin/bash",
    detachedFolderLabel: null,
    detachedFolderPath: null,
    isPinned: false,
  } as PrimaryTab
}

beforeEach(() => {
  resetTabStore()
  refreshTerminalInventory.mockClear()
  useTabStore.setState({ tabsHydrated: true })
  useTabStore.getState().applyTerminalInventory([descriptor("a")])
})

afterEach(() => resetTabStore())

// 两个客户端（桌面窗口 + 远程浏览器）各按自己的旧 inventory 回写会无限互相保存。
describe("remote primary-tabs change vs local terminal inventory", () => {
  it("re-reads the inventory when the other client sees different terminals", async () => {
    useTabStore.getState().handleTabsChanged({
      version: 1,
      origin: "other-client",
      tabs: [remoteTerminal("a"), remoteTerminal("b")],
    })
    await vi.waitFor(() =>
      expect(refreshTerminalInventory).toHaveBeenCalledOnce()
    )
  })

  it("does not re-read when both sides agree", () => {
    useTabStore.getState().handleTabsChanged({
      version: 1,
      origin: "other-client",
      tabs: [remoteTerminal("a")],
    })
    expect(refreshTerminalInventory).not.toHaveBeenCalled()
  })
})
