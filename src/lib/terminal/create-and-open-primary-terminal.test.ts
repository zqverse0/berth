import { beforeEach, describe, expect, it, vi } from "vitest"

const createTerminalSession = vi.fn()
const getSystemTerminalSettings = vi.fn()
const getRuntimeCapabilities = vi.fn()
const openTerminalTab = vi.fn()
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  message: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  createTerminalSession: (...args: unknown[]) => createTerminalSession(...args),
  getSystemTerminalSettings: (...args: unknown[]) =>
    getSystemTerminalSettings(...args),
  getRuntimeCapabilities: (...args: unknown[]) =>
    getRuntimeCapabilities(...args),
}))

vi.mock("@/stores/tab-store", () => ({
  useTabStore: {
    getState: () => ({ openTerminalTab }),
  },
}))

vi.mock("@/lib/notify", () => ({ toast }))

import {
  createAndOpenFolderTerminal,
  createAndOpenPrimaryTerminal,
  createAndOpenPrimaryTerminalDetailed,
  detachedTerminalScopeFolderId,
  isPersonalTerminalCapable,
  tabFromDescriptor,
  terminalSharePath,
} from "./create-and-open-primary-terminal"

describe("createAndOpenPrimaryTerminal", () => {
  beforeEach(() => {
    createTerminalSession.mockReset()
    getSystemTerminalSettings.mockReset()
    getRuntimeCapabilities.mockReset()
    openTerminalTab.mockReset()
    toast.error.mockReset()
    toast.message.mockReset()
    getSystemTerminalSettings.mockResolvedValue({ default_shell: "/bin/zsh" })
    getRuntimeCapabilities.mockResolvedValue({
      primaryTabsV2: true,
      personalTerminalV2: true,
    })
    createTerminalSession.mockResolvedValue({
      terminalId: "t1",
      backendInstanceId: "backend-1",
      folderId: 7,
      title: "Shell",
      initialCwd: "/repo",
      shell: "/bin/zsh",
      status: "running",
      processId: 1,
      createdAt: "2026-07-20T00:00:00Z",
      exitedAt: null,
    })
  })

  it("creates the PTY before opening the shared primary tab", async () => {
    const id = await createAndOpenPrimaryTerminal({
      cwd: "/repo",
      folderId: 7,
      title: "Repo shell",
    })

    expect(id).toBe("t1")
    expect(createTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        folderId: 7,
        rows: 24,
        cols: 80,
      })
    )
    expect(openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        id: "terminal:t1",
        terminalId: "t1",
        backendInstanceId: "backend-1",
        title: "Repo shell",
        initialCwd: "/repo",
      }),
      true
    )
    const createOrder = createTerminalSession.mock.invocationCallOrder[0]
    const openOrder = openTerminalTab.mock.invocationCallOrder[0]
    expect(createOrder).toBeLessThan(openOrder)
  })

  it("returns null without creating when cwd is empty", async () => {
    const id = await createAndOpenPrimaryTerminal({ cwd: "  " })
    expect(id).toBeNull()
    expect(createTerminalSession).not.toHaveBeenCalled()
    expect(openTerminalTab).not.toHaveBeenCalled()
  })

  it("blocks create when personal terminal capabilities are missing", async () => {
    getRuntimeCapabilities.mockResolvedValue({
      primaryTabsV2: true,
      personalTerminalV2: false,
    })
    const result = await createAndOpenPrimaryTerminalDetailed({
      cwd: "/repo",
    })
    expect(result).toEqual({ terminalId: null, capabilityBlocked: true })
    expect(createTerminalSession).not.toHaveBeenCalled()
  })

  it("maps descriptors to primary tabs", () => {
    const tab = tabFromDescriptor({
      terminalId: "abc",
      backendInstanceId: "b",
      folderId: null,
      title: "T",
      initialCwd: "/x",
      shell: "/bin/sh",
      status: "running",
      processId: 1,
      createdAt: "t",
      exitedAt: null,
    })
    expect(tab).toMatchObject({
      kind: "terminal",
      id: "terminal:abc",
      terminalId: "abc",
    })
  })

  it("takes the caller's folder scope override for detached terminals", () => {
    const tab = tabFromDescriptor(
      {
        terminalId: "cli-agent",
        backendInstanceId: "b",
        folderId: null,
        title: "Pi · demo",
        initialCwd: "/repo/demo",
        shell: "/bin/sh",
        status: "running",
        processId: 1,
        createdAt: "t",
        exitedAt: null,
      },
      { folderId: 7 }
    )
    expect(tab.folderId).toBe(7)
  })
  it("marks Agent CLI terminals without changing the PTY request", async () => {
    await createAndOpenPrimaryTerminalDetailed({
      cwd: "/repo",
      folderId: 7,
      title: "Codex",
      initialCommand: "codex",
      agentType: "codex",
    })

    expect(createTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({ initialCommand: "codex" })
    )
    expect(openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: "codex", title: "Codex" }),
      true
    )
  })

  it("opens a folder terminal on the primary tab without extra navigation", async () => {
    const t = vi.fn((key: string) => key)
    await createAndOpenFolderTerminal({ cwd: "/repo", folderId: 7 }, t)
    expect(openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "t1", folderId: 7 }),
      true
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("toasts when personal terminal capability is missing", async () => {
    getRuntimeCapabilities.mockResolvedValue({
      primaryTabsV2: true,
      personalTerminalV2: false,
    })
    const t = vi.fn((key: string) => key)
    await createAndOpenFolderTerminal({ cwd: "/repo", folderId: 7 }, t)
    expect(toast.error).toHaveBeenCalledWith("upgradeRequired")
    expect(openTerminalTab).not.toHaveBeenCalled()
  })

  it("builds share paths without tokens", () => {
    expect(terminalSharePath("t1")).toBe("/workspace?terminalId=t1")
    expect(
      isPersonalTerminalCapable({
        primaryTabsV2: true,
        personalTerminalV2: true,
      })
    ).toBe(true)
  })
})

describe("detachedTerminalScopeFolderId", () => {
  const folders = new Map([
    [7, { path: "/repo/demo" }],
    [8, { path: "/repo/demo/nested" }],
    [9, { path: "/other" }],
  ])

  it("keeps the terminal's own folder when it still exists", () => {
    expect(detachedTerminalScopeFolderId("/anywhere", folders, 9, 7)).toBe(9)
  })

  it("does not infer ownership from the terminal cwd", () => {
    expect(
      detachedTerminalScopeFolderId("/repo/demo/sub/dir", folders, null, 9)
    ).toBeNull()
    expect(
      detachedTerminalScopeFolderId("/repo/demo/nested", folders, null, 9)
    ).toBeNull()
  })

  it("keeps a stale terminal detached instead of falling back to the active folder", () => {
    // 文件夹 31 已不在项目列表；不能把它伪装成当前项目，也不能让它在
    // folder:31 这个不存在的 UI scope 下消失。
    expect(detachedTerminalScopeFolderId("/tmp", folders, 31, 7)).toBeNull()
    expect(detachedTerminalScopeFolderId(null, folders, null, null)).toBeNull()
  })
})
