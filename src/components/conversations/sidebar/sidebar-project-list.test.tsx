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
import { useReferenceBrowseStore } from "@/lib/workspace/reference-browse"
import enMessages from "@/i18n/messages/en.json"
import {
  _resetTerminalInventoryQuery,
  refreshTerminalInventory,
} from "@/lib/terminal/terminal-inventory-query"
import { tabsForFolderScope } from "@/lib/workspace/tab-scope"
import { useProjectPanelStore } from "@/components/layout/sidebar/views"

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
  refreshProjectMembers: async () => {},
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

const bridge = vi.hoisted(() => ({
  references: [] as string[],
  untracked: [] as { path: string; branch: string | null }[],
  calls: [] as { method: string; params?: unknown }[],
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

// 设备列表走 runtime bridge：没有设备。
vi.mock("@/lib/runtime-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime-bridge")>()
  return {
    ...actual,
    runtimeBridgeOperation: async (
      args: Parameters<typeof actual.runtimeBridgeOperation>[0]
    ) => {
      if (args.method === "device.list") return { ok: true, result: [] }
      if (args.method === "project.member.ls")
        return {
          ok: true,
          result: {
            references: bridge.references.map((path) => ({ path })),
            untracked: bridge.untracked,
          },
        }
      if (args.method.startsWith("project.member.")) {
        bridge.calls.push({ method: args.method, params: args.params })
        return { ok: true, result: {} }
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

/** `mainId` 是所属项目的主成员（默认自己）；项目名默认取主成员目录名。 */
function folder(
  id: number,
  name: string,
  mainId: number | null = null,
  overrides: Partial<FolderDetail> = {},
  project: Partial<NonNullable<FolderDetail["project"]>> = {}
): FolderDetail {
  const main = mainId ?? id
  return {
    id,
    name,
    path: `/p/${id}`,
    default_agent_type: null,
    project_id: main,
    project: {
      name: main === id ? name : "Repo",
      main_folder_id: main,
      pinned_at: null,
      sort_order: main,
      ...project,
    },
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
  bridge.references = []
  bridge.untracked = []
  bridge.calls = []
  folderApi.updateFolderAlias.mockClear()
  store.activeFolder = null
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
    refreshProjectMembers.mockClear()
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [conv(11, 1), conv(21, 2)],
      refreshProjectMembers,
    })
  })

  const refreshProjectMembers = vi.fn(async (...ids: number[]) => {
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
      expect(refreshProjectMembers).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(refreshProjectMembers).toHaveBeenCalledTimes(1)
      expect(refreshProjectMembers).toHaveBeenCalledWith(1)

      // 刚打开又关上：取消这一轮。
      rerender(harness(false))
      rerender(harness(true))
      rerender(harness(false))
      vi.advanceTimersByTime(300)
      expect(refreshProjectMembers).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("groups local projects under a collapsible local-machine header", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    const header = screen.getByRole("button", { name: "This machine" })
    expect(header.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(header)
    expect(header.getAttribute("aria-expanded")).toBe("false")
    expect(document.body.textContent).not.toContain("Repo")
  })

  it("lists a project as one row until it is the current project", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    const text = document.body.textContent ?? ""
    expect(text).toContain("Repo")
    expect(text).not.toContain("conv-11")
    // 不是当前项目：成员不展开。
    expect(document.querySelector('[data-folder-id="2"]')).toBeNull()
  })

  it("expands the current project into member rows with gray branches", () => {
    store.activeFolder = folder(2, "wt-feature", 1)
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

    // 项目行不是成员，不带 folder id；主成员是单独一行
    expect(document.querySelector('[data-project-id="1"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-folder-id="1"]')).toHaveLength(1)
    const wtRow = document.querySelector(
      '[data-folder-id="2"]'
    ) as HTMLButtonElement
    expect(wtRow.textContent).toContain("wt-feature")
    expect(wtRow.textContent).toContain("feature-x")
    expect(wtRow.getAttribute("aria-current")).toBe("location")
    // 展开的项目只有一条连续的连接线，画在成员区上，不在行里。
    expect(document.querySelectorAll("[data-project-rail]")).toHaveLength(1)
    expect(wtRow.querySelector("[data-project-rail]")).toBeNull()
  })

  it("covers the list with the current project summary while the panel is maximized", () => {
    store.activeFolder = folder(1, "Repo")
    useProjectPanelStore.setState({ maximized: true })
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness summaryOnly />
      </NextIntlClientProvider>
    )

    // 列表仍挂着（滚动位置不丢），上面盖一行摘要，点击还原
    expect(document.querySelector('[data-folder-id="1"]')).not.toBeNull()
    const summary = screen.getByTitle(enMessages.SidebarSessions.restoreList)
    expect(summary.textContent).toContain("Repo")
    fireEvent.click(summary)
    expect(useProjectPanelStore.getState().maximized).toBe(false)
  })

  it("activates a member without reopening the folder", async () => {
    store.activeFolder = folder(1, "Repo")
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

  it("clicking a project only folds its members, never selects it", async () => {
    store.activeFolder = folder(1, "Repo")
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )
    const project = document.querySelector(
      '[data-project-id="1"]'
    ) as HTMLElement
    expect(project.getAttribute("aria-expanded")).toBe("true")

    await act(async () => {
      fireEvent.click(project)
    })
    expect(project.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-folder-id="1"]')).toBeNull()
    expect(stableTabFns.activateFolderWorkspace).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(project)
    })
    expect(document.querySelector('[data-folder-id="1"]')).not.toBeNull()
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
    store.activeFolder = folder(1, "Repo", null, {}, { name: "Current alias" })
    useAppWorkspaceStore.setState({
      folders: [store.activeFolder],
      allFolders: [store.activeFolder],
    })
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )

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

  it("shows the project name on the project row and directory names on member rows", () => {
    const folders = [
      folder(1, "berth-dev", null, {}, { name: "Berth" }),
      folder(2, "berth", 1, { git_branch: "main" }),
    ]
    useAppWorkspaceStore.setState({ folders, allFolders: folders })
    store.activeFolder = folders[1]
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProjectHarness />
      </NextIntlClientProvider>
    )
    const project = document.querySelector('[data-project-id="1"]')!
    const main = document.querySelector('[data-folder-id="1"]')!
    expect(project.textContent).toBe("Berth")
    expect(main.textContent).toBe("berth-dev")
    expect(document.querySelector('[data-folder-id="2"]')?.textContent).toBe(
      "berthmain"
    )
  })

  it("lists pinned projects before unpinned ones", () => {
    const pinned = folder(
      3,
      "Pinned",
      null,
      {},
      { pinned_at: "2026-08-20T12:00:00.000Z" }
    )
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

    const ids = Array.from(document.querySelectorAll("[data-project-id]")).map(
      (el) => el.getAttribute("data-project-id")
    )
    expect(ids).toEqual(["3", "1"])
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

describe("SidebarProjectList — sessions", () => {
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
    store.activeFolder = folders[0]
  })

  it("shows agents as icons on the project row, not plain terminals", async () => {
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

    expect(document.querySelector('[data-project-id="1"]')).not.toBeNull()
    expect(document.querySelector('[data-project-id="3"]')).not.toBeNull()
    // 普通终端不进侧栏；Agent 是行尾图标，带状态。
    expect(screen.queryByLabelText(/idle-paper/)).toBeNull()
    const busy = await screen.findByLabelText(
      `busy-paper · ${enMessages.SidebarSessions.attention}`
    )
    expect(busy.querySelector("[data-status-dot=attention]")).not.toBeNull()

    fireEvent.click(busy)
    expect(stableTabFns.openTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "busy-paper", folderId: 3 }),
      true
    )
  })

  it("expands the current project into members: temporary folded, stale only cleans up", () => {
    const folders = [
      folder(1, "Repo"),
      folder(2, "wt-a", 1, { git_branch: "task/a" }),
      folder(4, "run-1", 1),
      folder(5, "gone", 1),
      folder(3, "Paper"),
    ]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      memberFlags: new Map([
        [4, { stale: false, temporary: true }],
        [5, { stale: true, temporary: false }],
      ]),
    })
    store.activeFolder = folders[1]
    renderList()

    const ids = Array.from(
      document.querySelectorAll("[data-project-id], [data-folder-id]")
    ).map(
      (el) =>
        el.getAttribute("data-project-id") ?? el.getAttribute("data-folder-id")
    )
    // 项目行、主成员、worktree、失效成员；临时的收起，其他项目折叠。
    expect(ids).toEqual(["1", "1", "5", "2", "3"])
    expect(screen.getByText("task/a")).toBeTruthy()
    const toggle = screen.getByText("+ 1 temporary worktree")
    fireEvent.click(toggle)
    expect(document.querySelector('[data-folder-id="4"]')).not.toBeNull()
    expect(
      screen.getAllByRole("button", {
        name: enMessages.ProjectMembers.prune,
      })
    ).toHaveLength(1)
  })

  it("hints git worktrees outside any project and adds one only via +", async () => {
    bridge.untracked = [{ path: "/repos/repo-agent", branch: "agent" }]
    renderList()

    fireEvent.click(await screen.findByText("+ 1 untracked worktree(s)"))
    fireEvent.click(screen.getByText("repo-agent"))
    expect(bridge.calls).toEqual([])
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to project" }))
    })
    expect(bridge.calls).toEqual([
      {
        method: "project.member.join",
        params: { path: "/repos/repo-agent" },
      },
    ])
  })

  it("offers set-main / move / remove-from-project on worktree members only", async () => {
    const folders = [
      folder(1, "Repo"),
      folder(2, "wt-a", 1, { git_branch: "task/a" }),
      folder(3, "Paper"),
    ]
    useAppWorkspaceStore.setState({ folders, allFolders: folders })
    store.activeFolder = folders[1]
    renderList()

    const menuOf = (folderId: number) => {
      const row = document.querySelector(
        `[data-folder-id="${folderId}"]`
      )!.parentElement!
      const trigger = row.querySelector('[aria-label="More options"]')!
      fireEvent.keyDown(trigger, { key: "Enter" })
      const items = screen.getAllByRole("menuitem").map((el) => el.textContent)
      fireEvent.keyDown(document.activeElement!, { key: "Escape" })
      return items
    }
    const worktree = menuOf(2)
    expect(worktree).toContain("Make main member")
    expect(worktree).toContain("Move to project")
    expect(worktree).toContain("Remove from project…")
    const main = menuOf(1)
    expect(main).toContain("Move to project")
    expect(main).not.toContain("Make main member")
    expect(main).not.toContain("Remove from project…")
  })

  it("lists the project's references and browses one in the file panel", async () => {
    bridge.references = ["/ref/OpenMausBot"]
    renderList()

    expect(await screen.findByText("References")).toBeTruthy()
    fireEvent.click(await screen.findByText("OpenMausBot"))
    expect(useReferenceBrowseStore.getState()).toMatchObject({
      folderId: 1,
      path: "/ref/OpenMausBot",
    })
  })

  it("keeps search folded until opened, finds sessions and closes on Escape", async () => {
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
})
