import { useAppUiStore } from "@/stores/app-ui-store"
import { type ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SidebarProjectList } from "./sidebar-project-list"
import { DevicesProvider } from "@/components/devices/devices"
import { OPEN_PROJECT_SWITCHER_EVENT } from "@/components/layout/commands/commands"
import type {
  DbConversationSummary,
  FolderDetail,
  TerminalDescriptor,
} from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useGroupUnreadStore } from "@/lib/agent/group-unread"
import enMessages from "@/i18n/messages/en.json"
import {
  _resetTerminalInventoryQuery,
  refreshTerminalInventory,
} from "@/lib/terminal/terminal-inventory-query"
import { tabsForFolderScope } from "@/lib/workspace/tab-scope"
import { useProjectPanelStore } from "@/components/layout/sidebar/views"
import {
  useWorkspaceGroupsStore,
  type WorkspaceGroupsState,
} from "@/lib/workspace-groups"

// Mutable backing store the mocked tab-context hook reads from (workspace data
// now lives in the real zustand store, seeded per test below). `tabs` is
// rebuilt fresh every render to mirror tab-context re-deriving it on each
// `conversations` change.
const store = vi.hoisted(() => ({
  activeTabId: null as string | null,
  activeFolder: null as FolderDetail | null,
  tabSpec: [] as Array<{
    id: string
    conversationId: number | null
    agentType: string
    folderId: number
    title: string
    isPinned: boolean
  }>,
}))

// Action spies installed into the workspace store before each test. zustand
// keeps these referentially stable across renders (as the real store's action
// fields are), so the list's folder callbacks that close over them stay
// memoized.
const stableWorkspaceFns = vi.hoisted(() => ({
  removeFolderFromWorkspace: async () => {},
  openFolder: vi.fn(async () => ({}) as FolderDetail),
  refreshFolder: async () => {},
  refreshWorktreeFamily: async () => {},
}))

const stableTabFns = vi.hoisted(() => ({
  openTab: () => {},
  openTerminalTab: vi.fn(),
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  closeConversationTab: () => {},
  closeTabsByFolder: () => {},
  activateFolderWorkspace: vi.fn(),
  leaveFolderWorkspace: vi.fn(),
  openNewConversationTab: () => {},
}))

const folderApi = vi.hoisted(() => ({
  updateFolderAlias: vi.fn(async (...args: unknown[]) => {
    void args
    return {}
  }),
}))

const terminalApi = vi.hoisted(() => ({
  listTerminalSessions: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    listTerminalSessions: (...args: unknown[]) =>
      terminalApi.listTerminalSessions(...args),
    updateFolderAlias: (...args: unknown[]) =>
      folderApi.updateFolderAlias(...args),
  }
})

// 工作区读写与设备列表走 runtime bridge：工作区文件在内存里，没有设备。
const bridge = vi.hoisted(() => ({ set: vi.fn() }))
vi.mock("@/lib/runtime-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime-bridge")>()
  return {
    ...actual,
    runtimeBridgeOperation: async (
      args: Parameters<typeof actual.runtimeBridgeOperation>[0]
    ) => {
      if (args.method === "workspaceGroups.set") {
        bridge.set(args.params?.state)
        return { ok: true, result: null }
      }
      if (
        args.method === "workspaceGroups.get" ||
        args.method === "device.list"
      )
        return {
          ok: true,
          result: args.method === "device.list" ? [] : null,
        }
      return actual.runtimeBridgeOperation(args)
    },
  }
})

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => {},
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: store.activeFolder }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => stableTabFns,
  useTabStore: (
    selector: (s: {
      activeTabId: string | null
      tabs: Array<Record<string, unknown>>
    }) => unknown
  ) =>
    selector({
      activeTabId: store.activeTabId,
      // Fresh array + fresh objects every render → worst-case churn, exactly
      // what the list's reuseSelected/reuseSet must absorb to keep folders
      // memoized.
      tabs: store.tabSpec.map((t) => ({ kind: "conversation", ...t })),
    }),
}))

const MINUTE = 60_000
const FIXED = 1_700_000_000_000

function conv(
  id: number,
  folderId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  const createdAt = new Date(FIXED - 5 * MINUTE).toISOString()
  return {
    id,
    folder_id: folderId,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    pinned_at: null,
    ...overrides,
  }
}

function folder(
  id: number,
  name: string,
  parentId: number | null = null,
  overrides: Partial<FolderDetail> = {}
): FolderDetail {
  return {
    id,
    name,
    path: `/p/${id}`,
    color: "blue",
    default_agent_type: null,
    parent_id: parentId,
    sort_order: id,
    pinned_at: null,
    ...overrides,
  } as unknown as FolderDetail
}

function terminal(
  id: string,
  folderId: number | null,
  status: TerminalDescriptor["status"] = "running"
): TerminalDescriptor {
  return {
    terminalId: id,
    backendInstanceId: "backend",
    folderId,
    title: id,
    initialCwd: folderId == null ? "/tmp" : `/p/${folderId}`,
    shell: "/bin/sh",
    status,
    processId: status === "running" ? 100 : null,
    createdAt: new Date(FIXED).toISOString(),
    exitedAt: status === "running" ? null : new Date(FIXED).toISOString(),
  }
}

// Reset the workspace store before every test (runs
// before each describe's own beforeEach) so a scrolled overlay test never
// bleeds into the memo-scope or drag suites, which all assume scrollOffset 0 →
// overlay hidden. The store reset restores pristine state; the setState then
// flips the loading flags off and installs the stable action spies, and each
// describe's own beforeEach seeds its folders/conversations fixture on top.
beforeEach(() => {
  _resetTerminalInventoryQuery()
  resetAppWorkspaceStore()
  terminalApi.listTerminalSessions.mockReset()
  terminalApi.listTerminalSessions.mockResolvedValue([])
  folderApi.updateFolderAlias.mockClear()
  store.activeFolder = null
  useWorkspaceGroupsStore.setState({ state: null })
  bridge.set.mockClear()
  stableWorkspaceFns.openFolder.mockClear()
  stableTabFns.activateFolderWorkspace.mockClear()
  stableTabFns.openTerminalTab.mockClear()
  stableTabFns.switchTab.mockClear()
  stableTabFns.closeTab.mockClear()
  useAppWorkspaceStore.setState({
    conversationsLoading: false,
    conversationsError: null,
    ...stableWorkspaceFns,
  })
})

describe("SidebarProjectList — project explorer mode", () => {
  function ProjectHarness({
    visible = true,
    summaryOnly = false,
  }: {
    visible?: boolean
    summaryOnly?: boolean
  }) {
    return <SidebarProjectList visible={visible} summaryOnly={summaryOnly} />
  }

  beforeEach(() => {
    localStorage.clear()
    const wt = {
      ...folder(2, "wt-feature", 1),
      git_branch: "feature-x",
    } as unknown as FolderDetail
    const folders = [folder(1, "Repo"), wt]
    refreshWorktreeFamily.mockClear()
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [conv(11, 1), conv(21, 2)],
      refreshWorktreeFamily,
    })
  })

  const refreshWorktreeFamily = vi.fn(async (...ids: number[]) => {
    void ids
  })

  it("reconciles every root with git once the open slide has finished", () => {
    vi.useFakeTimers()
    try {
      const harness = (visible: boolean) => (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ProjectHarness visible={visible} />
        </NextIntlClientProvider>
      )
      const { rerender } = render(harness(false))
      rerender(harness(true))
      // 滑入动画期间不发 git 对账。
      expect(refreshWorktreeFamily).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(refreshWorktreeFamily).toHaveBeenCalledTimes(1)
      expect(refreshWorktreeFamily).toHaveBeenCalledWith(1)

      // 刚打开又关上：取消这一轮。
      rerender(harness(false))
      rerender(harness(true))
      rerender(harness(false))
      vi.advanceTimersByTime(300)
      expect(refreshWorktreeFamily).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders projects and worktrees without rendering conversation rows", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    const text = document.body.textContent ?? ""
    expect(text).toContain("Repo")
    expect(text).toContain("feature-x")
    expect(text).not.toContain("conv-11")
    expect(text).not.toContain("conv-21")
    const repoRow = document.querySelector(
      '[data-folder-id="1"]'
    ) as HTMLButtonElement
    const wtRow = document.querySelector(
      '[data-folder-id="2"]'
    ) as HTMLButtonElement
    // worktree 行缩进一级并画连接线；root 行不画。
    expect(repoRow.querySelector("[data-project-rail]")).toBeNull()
    expect(wtRow.querySelector("[data-project-rail]")).not.toBeNull()
    expect(wtRow.style.paddingLeft).not.toBe(repoRow.style.paddingLeft)
  })

  it("covers the list with the workspace summary while the panel is maximized", () => {
    store.activeFolder = folder(1, "Repo")
    useProjectPanelStore.setState({ maximized: true })
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness summaryOnly />
      </NextIntlClientProvider>
    )

    // 列表仍挂着（滚动位置不丢），上面盖一行摘要，点击还原
    expect(document.querySelector('[data-folder-id="1"]')).not.toBeNull()
    const summary = screen.getByTitle(enMessages.WorkspaceGroups.restoreList)
    expect(summary.textContent).toContain("Default")
    fireEvent.click(summary)
    expect(useProjectPanelStore.getState().maximized).toBe(false)
  })

  it("activates a registered project without reopening the folder", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-folder-id="2"]') as HTMLElement
      )
    })

    expect(stableTabFns.activateFolderWorkspace).toHaveBeenCalledWith(2)
    expect(stableWorkspaceFns.openFolder).not.toHaveBeenCalled()
    expect(useAppUiStore.getState().auxView).toBe("group")
    expect(document.querySelector('[data-folder-id="2"]')).not.toBeNull()
  })

  it("keeps the project list after clicking a project", async () => {
    store.activeFolder = folder(1, "Repo")
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    expect(document.querySelector('[data-folder-id="2"]')).not.toBeNull()

    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-folder-id="2"]') as HTMLElement
      )
    })

    expect(stableTabFns.activateFolderWorkspace).toHaveBeenCalledWith(2)
    expect(document.querySelector('[data-folder-id="2"]')).not.toBeNull()
  })

  it("keeps file-tree and terminal entries off the context menu", () => {
    store.activeFolder = folder(1, "Repo")
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    const moreBtn = document.querySelector('[aria-label="More options"]')
    expect(moreBtn).not.toBeNull()
    act(() => {
      fireEvent.click(moreBtn as HTMLElement)
    })
    expect(document.body.textContent).toContain("Pin project")
    expect(document.body.textContent).not.toContain("View project files")
    expect(screen.queryByRole("menuitem", { name: "Terminal" })).toBeNull()
  })

  it("pins a project without rewriting its alias", async () => {
    store.activeFolder = folder(1, "Repo", null, { alias: "Current alias" })
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /Repo/ }))
    await waitFor(() => {
      expect(document.querySelector('[data-folder-id="1"]')).not.toBeNull()
    })
    fireEvent.click(
      document.querySelector('[aria-label="More options"]') as HTMLElement
    )
    fireEvent.click(screen.getByText("Pin project"))

    await waitFor(() => {
      expect(folderApi.updateFolderAlias).toHaveBeenCalledWith(
        1,
        null,
        true,
        false
      )
    })
  })

  it("shows editable aliases for worktrees instead of hiding them behind branch names", () => {
    const folders = [
      folder(1, "Repo"),
      folder(2, "Repo", 1, { alias: "Repo · 2", git_branch: "feature" }),
      folder(3, "Repo", 1, { git_branch: "unaliased-branch" }),
    ]
    useAppWorkspaceStore.setState({ folders, allFolders: folders })
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )
    expect(
      document.querySelector('[data-folder-id="2"]')?.textContent
    ).toContain("Repo · 2")
    expect(
      document.querySelector('[data-folder-id="3"]')?.textContent
    ).toContain("unaliased-branch")
  })

  it("lists pinned projects before unpinned ones", () => {
    const pinned = folder(2, "wt-feature", 1, {
      git_branch: "feature-x",
      pinned_at: "2026-08-20T12:00:00.000Z",
    })
    const folders = [folder(1, "Repo"), pinned]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
    })

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    const ids = Array.from(document.querySelectorAll("[data-folder-id]")).map(
      (el) => el.getAttribute("data-folder-id")
    )
    expect(ids[0]).toBe("2")
    expect(ids).toContain("1")
  })

  it("shows the group unread count on the project row", () => {
    const repo = useAppWorkspaceStore
      .getState()
      .folders.find((folder) => folder.id === 1)!
    useGroupUnreadStore.setState({ byPath: { [repo.path]: 3 } })

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    const badge = document.querySelector("[data-group-unread]")
    expect(badge?.textContent).toBe("3")
    expect(badge?.getAttribute("aria-label")).toBe("3 unread group messages")
  })

  it("keeps the normal empty state when there are no projects or terminals", () => {
    useAppWorkspaceStore.setState({
      folders: [],
      allFolders: [],
      conversations: [],
    })

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    expect(screen.getByText("No projects open")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Open Folder" })).toBeTruthy()
  })

  it("shows and opens an independent terminal with no project", async () => {
    useAppWorkspaceStore.setState({
      folders: [],
      allFolders: [],
      conversations: [],
    })
    terminalApi.listTerminalSessions.mockResolvedValue([
      terminal("independent-terminal", null),
    ])
    await refreshTerminalInventory()

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    const entry = screen.getByLabelText("independent-terminal")
    fireEvent.click(entry)

    expect(stableTabFns.openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: "independent-terminal",
        folderId: null,
      }),
      true
    )
  })

  it("lists a deleted project's terminal under the local machine without inventing a project", async () => {
    const projects = [folder(1, "Repo")]
    useAppWorkspaceStore.setState({
      folders: projects,
      allFolders: projects,
      conversations: [],
    })
    terminalApi.listTerminalSessions.mockResolvedValue([
      {
        ...terminal("stale-project-terminal", 99),
        initialCwd: "/p/1/subdir",
      },
    ])
    await refreshTerminalInventory()

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByLabelText("stale-project-terminal"))
    expect(stableTabFns.openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: "stale-project-terminal",
        folderId: null,
        detachedFolderPath: "/p/1/subdir",
      }),
      true
    )
    const opened = stableTabFns.openTerminalTab.mock.calls[0]?.[0]
    expect(opened).toBeDefined()
    expect(tabsForFolderScope([opened], 1)).toEqual([])
    expect(
      tabsForFolderScope([opened], null).map((tab) => tab.terminalId)
    ).toEqual(["stale-project-terminal"])
  })

  it("does not infer a project from cwd when refreshing or switching projects", async () => {
    const projects = [folder(1, "Repo"), folder(2, "Other")]
    useAppWorkspaceStore.setState({
      folders: projects,
      allFolders: projects,
      conversations: [],
    })
    store.activeFolder = projects[0]
    let descriptors: TerminalDescriptor[] = [
      {
        ...terminal("cwd-inside-project", null),
        initialCwd: "/p/1/nested",
      },
    ]
    terminalApi.listTerminalSessions.mockImplementation(async () => descriptors)
    await refreshTerminalInventory()

    const view = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByLabelText("cwd-inside-project"))
    expect(stableTabFns.openTerminalTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminalId: "cwd-inside-project",
        folderId: null,
      }),
      true
    )

    store.activeFolder = projects[1]
    descriptors = [...descriptors, terminal("project-terminal", 2)]
    await refreshTerminalInventory()
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    expect(screen.getByLabelText("cwd-inside-project")).toBeTruthy()
    expect(stableTabFns.activateFolderWorkspace).not.toHaveBeenCalled()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBeNull()
  })
})

describe("SidebarProjectList — visibility prop", () => {
  function VisHarness({ visible }: { visible: boolean }) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SidebarProjectList visible={visible} />
      </NextIntlClientProvider>
    )
  }

  beforeEach(() => {
    const folders = [folder(1, "Folder 1")]
    useAppWorkspaceStore.setState({ folders, allFolders: folders })
  })

  it("renders the root hidden + inert when visible is false", () => {
    const view = render(<VisHarness visible />)
    const root = screen.getByTestId("sidebar-project-list-root")
    expect(root.classList.contains("hidden")).toBe(false)
    expect(root.getAttribute("aria-hidden")).toBeNull()

    view.rerender(<VisHarness visible={false} />)
    // Same root stays mounted (not unmounted) but gains `hidden`.
    const rootAfter = screen.getByTestId("sidebar-project-list-root")
    expect(rootAfter).toBe(root)
    expect(rootAfter.classList.contains("hidden")).toBe(true)
    expect(rootAfter.getAttribute("aria-hidden")).toBe("true")
  })

  it("pauses the terminal inventory projection while hidden", async () => {
    terminalApi.listTerminalSessions.mockResolvedValue([
      terminal("cli-agent", null),
    ])
    await refreshTerminalInventory()

    const view = render(<VisHarness visible />)
    expect(screen.queryByLabelText("cli-agent")).toBeTruthy()

    view.rerender(<VisHarness visible={false} />)
    expect(screen.queryByLabelText("cli-agent")).toBeNull()

    view.rerender(<VisHarness visible />)
    expect(screen.queryByLabelText("cli-agent")).toBeTruthy()
  })
})

describe("SidebarProjectList — workspaces", () => {
  function groups(
    members: WorkspaceGroupsState["members"]
  ): WorkspaceGroupsState {
    return {
      version: 1,
      groups: [
        { id: "default", name: "Default", emoji: null, isDefault: true },
        { id: "lab", name: "Lab", emoji: null, isDefault: false },
      ],
      members,
    }
  }

  function renderList() {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DevicesProvider>
          <SidebarProjectList />
        </DevicesProvider>
      </NextIntlClientProvider>
    )
  }

  beforeEach(() => {
    localStorage.clear()
    const folders = [folder(1, "Repo"), folder(3, "Paper")]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [],
      foldersHydrated: true,
    })
    useWorkspaceGroupsStore.setState({
      state: groups([{ device: 0, path: "/p/3", groupId: "lab" }]),
    })
    store.activeFolder = folders[0]
  })

  it("shows the current workspace in full and the others by running sessions only", async () => {
    terminalApi.listTerminalSessions.mockResolvedValue([
      terminal("idle-paper", 3),
      {
        ...terminal("busy-paper", 3),
        agentId: "claude",
        agentSignal: {
          state: "attention",
          notification: null,
          stateChangedAt: 5,
          progressState: "",
          progress: 0,
        },
      },
    ])
    await refreshTerminalInventory()
    renderList()

    // Default 是当前（Repo 所在）：项目行都在；Lab 只看运行中：项目行不显示，需关注的会话写着项目名
    expect(document.querySelector('[data-folder-id="1"]')).not.toBeNull()
    expect(document.querySelector('[data-folder-id="3"]')).toBeNull()
    const busy = await screen.findByLabelText("busy-paper")
    expect(busy.textContent).toContain("Paper")
    expect(busy.textContent).toContain(enMessages.WorkspaceGroups.attention)
    expect(screen.queryByLabelText("idle-paper")).toBeNull()

    fireEvent.click(busy)
    expect(stableTabFns.openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "busy-paper", folderId: 3 }),
      true
    )

    // 手动点开 Lab：完整显示，空闲的会话也在；当前工作区不变
    fireEvent.click(screen.getByRole("button", { name: /^Lab: / }))
    expect(document.querySelector('[data-folder-id="3"]')).not.toBeNull()
    expect(screen.getByLabelText("idle-paper")).toBeTruthy()
    expect(stableTabFns.activateFolderWorkspace).not.toHaveBeenCalled()
  })

  it("switches workspace from its title to the first project and marks the current one", () => {
    stableTabFns.activateFolderWorkspace.mockClear()
    renderList()
    expect(
      screen.getByRole("button", { name: /^Default/, current: true })
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /^Lab\b(?!:)/ }))
    expect(stableTabFns.activateFolderWorkspace).toHaveBeenCalledWith(3)
  })

  it("switching to a workspace without projects leaves the current project", () => {
    stableTabFns.leaveFolderWorkspace.mockClear()
    useWorkspaceGroupsStore.setState({ state: groups([]) })
    renderList()

    fireEvent.click(screen.getByRole("button", { name: /^Lab\b(?!:)/ }))
    expect(stableTabFns.leaveFolderWorkspace).toHaveBeenCalled()
  })

  it("keeps search folded until opened, finds sessions across workspaces and closes on Escape", async () => {
    terminalApi.listTerminalSessions.mockResolvedValue([
      terminal("busy-paper", 3),
    ])
    await refreshTerminalInventory()
    renderList()
    const placeholder = enMessages.Folder.sidebar.searchProjectsPlaceholder
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull()

    act(() => {
      window.dispatchEvent(new Event(OPEN_PROJECT_SWITCHER_EVENT))
    })
    const input = screen.getByPlaceholderText(placeholder)
    fireEvent.change(input, { target: { value: "busy" } })
    expect(screen.getByLabelText("busy-paper")).toBeTruthy()

    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull()
  })

  it("puts a newly opened project into the current workspace", async () => {
    store.activeFolder = folder(3, "Paper")
    renderList()

    const opened = [folder(1, "Repo"), folder(3, "Paper"), folder(4, "Notes")]
    act(() => {
      useAppWorkspaceStore.setState({ folders: opened, allFolders: opened })
    })

    await waitFor(() =>
      expect(useWorkspaceGroupsStore.getState().state?.members).toContainEqual({
        device: 0,
        path: "/p/4",
        groupId: "lab",
      })
    )
    expect(bridge.set).toHaveBeenCalled()
  })

  it("forgets projects that were removed from Berth", async () => {
    useWorkspaceGroupsStore.setState({
      state: groups([
        { device: 0, path: "/p/3", groupId: "lab" },
        { device: 0, path: "/p/gone", groupId: "lab" },
      ]),
    })
    renderList()
    await waitFor(() =>
      expect(useWorkspaceGroupsStore.getState().state?.members).toEqual([
        { device: 0, path: "/p/3", groupId: "lab" },
      ])
    )
  })
})
