import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

const getTerminalSession = vi.fn()
const getRuntimeCapabilities = vi.fn()
const openTab = vi.fn()
const openTerminalTab = vi.fn()
const showInstanceExpired = vi.fn()
const showCleared = vi.fn()
const createTerminal = vi.fn()

const terminalMessages: Record<string, string> = {
  invalidLink: "Invalid terminal link",
  upgradeToOpenPersonal: "Upgrade Berth to open personal terminals",
  authorizationRequired: "Connection authorization required",
  notFound: "Terminal not found",
  openLinkedFailed: "Unable to open linked terminal",
}

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => terminalMessages[key] ?? key,
}))

let tabsState: {
  tabsHydrated: boolean
  tabs: Array<Record<string, unknown>>
  openTab: typeof openTab
  openTerminalTab: typeof openTerminalTab
}

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => tabsState,
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openTranscriptTab: vi.fn(),
  }),
}))

vi.mock("@/stores/tab-store", () => {
  const useTabStore = (selector: (s: typeof tabsState) => unknown) =>
    selector(tabsState)
  ;(useTabStore as unknown as { getState: () => typeof tabsState }).getState =
    () => tabsState
  return { useTabStore }
})

vi.mock("@/lib/api", () => ({
  getTerminalSession: (...args: unknown[]) => getTerminalSession(...args),
  getRuntimeCapabilities: (...args: unknown[]) =>
    getRuntimeCapabilities(...args),
  createTerminalSession: (...args: unknown[]) => createTerminal(...args),
}))

vi.mock("@/stores/terminal-runtime-store", () => ({
  useTerminalRuntimeStore: {
    getState: () => ({
      showInstanceExpired,
      showCleared,
    }),
  },
}))

vi.mock("@/lib/notify", () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}))

import { DeepLinkBootstrap } from "./deep-link-bootstrap"
import { toast } from "@/lib/notify"

function setSearch(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      search,
      href: `http://localhost/workspace${search}`,
      pathname: "/workspace",
      origin: "http://localhost",
    },
  })
}

describe("DeepLinkBootstrap terminal links", () => {
  beforeEach(() => {
    getTerminalSession.mockReset()
    getRuntimeCapabilities.mockReset()
    openTab.mockReset()
    openTerminalTab.mockReset()
    showInstanceExpired.mockReset()
    showCleared.mockReset()
    createTerminal.mockReset()
    ;(toast.error as ReturnType<typeof vi.fn>).mockReset()
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {})
    getRuntimeCapabilities.mockResolvedValue({
      primaryTabsV2: true,
      personalTerminalV2: true,
    })
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      foldersHydrated: true,
      folders: [],
      conversations: [],
      addFolderToWorkspaceById: vi.fn(),
    })
    tabsState = {
      tabsHydrated: true,
      tabs: [],
      openTab,
      openTerminalTab,
    }
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setSearch("")
  })

  it("opens a running terminal without creating a shell", async () => {
    setSearch("?terminalId=t-run")
    getTerminalSession.mockResolvedValue({
      terminalId: "t-run",
      backendInstanceId: "b1",
      folderId: null,
      title: "Shell",
      initialCwd: "/repo",
      shell: "/bin/bash",
      status: "running",
      processId: 1,
      createdAt: "t",
      exitedAt: null,
    })
    render(<DeepLinkBootstrap />)
    await waitFor(() =>
      expect(openTerminalTab).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "terminal",
          terminalId: "t-run",
        }),
        true
      )
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it("opens exited snapshots as primary tabs without create", async () => {
    setSearch("?terminalId=t-exit")
    getTerminalSession.mockResolvedValue({
      terminalId: "t-exit",
      backendInstanceId: "b1",
      folderId: null,
      title: "Done",
      initialCwd: "/repo",
      shell: "/bin/bash",
      status: "exited",
      processId: null,
      createdAt: "t",
      exitedAt: "t2",
    })
    render(<DeepLinkBootstrap />)
    await waitFor(() =>
      expect(openTerminalTab).toHaveBeenCalledWith(
        expect.objectContaining({ terminalId: "t-exit" }),
        true
      )
    )
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it("drops a persisted tab when its runtime window is gone", async () => {
    setSearch("?terminalId=t-gone")
    tabsState.tabs = [
      {
        kind: "terminal",
        id: "terminal:t-gone",
        terminalId: "t-gone",
        backendInstanceId: "old-b",
        folderId: null,
        title: "Gone",
        initialCwd: "/repo",
        shell: "/bin/bash",
        detachedFolderLabel: null,
        detachedFolderPath: null,
        isPinned: false,
      },
    ]
    getTerminalSession.mockRejectedValue({
      code: "terminal_not_found",
      message: "not found",
    })
    render(<DeepLinkBootstrap />)
    await waitFor(() =>
      expect(showInstanceExpired).toHaveBeenCalledWith("t-gone")
    )
    expect(showCleared).not.toHaveBeenCalled()
    expect(openTerminalTab).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it("uses the Berth product name in the personal-terminal upgrade error", async () => {
    setSearch("?terminalId=t-upgrade")
    getRuntimeCapabilities.mockResolvedValue({
      primaryTabsV2: false,
      personalTerminalV2: false,
    })

    render(<DeepLinkBootstrap />)

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Upgrade Berth to open personal terminals"
      )
    )
    expect(getTerminalSession).not.toHaveBeenCalled()
  })

  it("drops a persisted tab when the daemon runtime identity changes", async () => {
    setSearch("?terminalId=t-old")
    tabsState.tabs = [
      {
        kind: "terminal",
        id: "terminal:t-old",
        terminalId: "t-old",
        backendInstanceId: "backend-old",
        folderId: null,
        title: "Old",
        initialCwd: "/repo",
        shell: "/bin/bash",
        detachedFolderLabel: null,
        detachedFolderPath: null,
        isPinned: false,
      },
    ]
    getTerminalSession.mockResolvedValue({
      terminalId: "t-old",
      backendInstanceId: "backend-new",
      folderId: null,
      title: "Reused id?",
      initialCwd: "/repo",
      shell: "/bin/bash",
      status: "running",
      processId: 2,
      createdAt: "t",
      exitedAt: null,
    })
    render(<DeepLinkBootstrap />)
    await waitFor(() =>
      expect(showInstanceExpired).toHaveBeenCalledWith("t-old")
    )
    expect(openTerminalTab).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it("does not reveal existence when authentication fails", async () => {
    setSearch("?terminalId=secret")
    getTerminalSession.mockRejectedValue({
      code: "authentication_failed",
      message: "auth",
    })
    render(<DeepLinkBootstrap />)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Connection authorization required"
      )
    )
    expect(openTerminalTab).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
