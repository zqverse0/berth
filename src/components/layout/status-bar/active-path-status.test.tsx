import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ActivePathStatus,
  getRelativeOrCleanPath,
} from "@/components/layout/status-bar/active-path-status"

const layoutMocks = vi.hoisted(() => ({
  activeWorkspaceTab: null as unknown,
  activePane: "files" as string,
  activeTabByPane: { files: null } as Record<string, unknown>,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

vi.mock("@/hooks/workspace/use-workspace-layout", () => ({
  useWorkspaceLayoutProjection: (select?: (p: unknown) => unknown) => {
    const projection = { ...layoutMocks }
    return select ? select(projection) : projection
  },
}))

const fileStoreMocks = vi.hoisted(() => ({
  fileTabs: [] as Array<{ id: string; path?: string; title?: string }>,
}))

vi.mock("@/stores/workspace-file-store", () => ({
  useWorkspaceFileStore: (
    selector: (state: typeof fileStoreMocks) => unknown
  ) => selector(fileStoreMocks),
}))

const tabStoreMocks = vi.hoisted(() => ({
  tabs: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/stores/tab-store", () => ({
  useTabStore: (selector: (state: typeof tabStoreMocks) => unknown) =>
    selector(tabStoreMocks),
}))

const appWorkspaceMocks = vi.hoisted(() => ({
  allFolders: [] as Array<{
    id: number
    path: string
    name: string
    alias?: string | null
    git_branch?: string | null
  }>,
  activeFolderId: null as number | null,
  branches: new Map<number, string>(),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    selector: (state: typeof appWorkspaceMocks) => unknown
  ) => selector(appWorkspaceMocks),
}))

const terminalRuntimeMocks = vi.hoisted(() => ({
  sessions: {} as Record<string, { lastKnownCwd?: string }>,
}))

vi.mock("@/stores/terminal-runtime-store", () => ({
  useTerminalRuntimeStore: (
    selector: (state: typeof terminalRuntimeMocks) => unknown
  ) => selector(terminalRuntimeMocks),
}))

describe("getRelativeOrCleanPath helper", () => {
  const folders = [
    {
      id: 1,
      path: "/home/user/project/my-app",
      name: "my-app",
      alias: "MyApp",
    },
    { id: 2, path: "/home/user/project/my-app/sub", name: "sub", alias: null },
  ]

  it("extracts project alias and relative path for project file", () => {
    const result = getRelativeOrCleanPath(
      "/home/user/project/my-app/src/index.ts",
      folders
    )
    expect(result.projectName).toBe("MyApp")
    expect(result.relativePath).toBe("src/index.ts")
  })

  it("prioritizes longer matching project directory", () => {
    const result = getRelativeOrCleanPath(
      "/home/user/project/my-app/sub/package.json",
      folders
    )
    expect(result.projectName).toBe("sub")
    expect(result.relativePath).toBe("package.json")
  })

  it("cleans system absolute path with tilde fallback when not in projects", () => {
    const result = getRelativeOrCleanPath(
      "/home/user/.config/app/test.json",
      folders
    )
    expect(result.projectName).toBeNull()
    expect(result.relativePath).toBe("~/.config/app/test.json")
  })
})

describe("ActivePathStatus component", () => {
  beforeEach(() => {
    layoutMocks.activeWorkspaceTab = null
    layoutMocks.activePane = "files"
    layoutMocks.activeTabByPane = { files: null }
    fileStoreMocks.fileTabs = []
    tabStoreMocks.tabs = []
    appWorkspaceMocks.allFolders = [
      {
        id: 1,
        path: "/home/user/repo",
        name: "repo",
        alias: "MyRepo",
        git_branch: "main",
      },
    ]
    appWorkspaceMocks.activeFolderId = 1
    appWorkspaceMocks.branches = new Map([[1, "main"]])
    terminalRuntimeMocks.sessions = {}
  })

  it("renders relative path and project name for focused file tab", () => {
    layoutMocks.activeWorkspaceTab = { kind: "file", id: "f-1" }
    fileStoreMocks.fileTabs = [
      { id: "f-1", path: "/home/user/repo/src/App.tsx", title: "App.tsx" },
    ]

    render(<ActivePathStatus />)

    expect(screen.getByText("MyRepo")).toBeTruthy()
    expect(screen.getByText("src/App.tsx")).toBeTruthy()
    expect(screen.getByTestId("active-location-status")).toHaveAttribute(
      "title",
      "/home/user/repo/src/App.tsx"
    )
  })

  it("shows the tab title instead of the virtual preview path", () => {
    layoutMocks.activeWorkspaceTab = { kind: "file", id: "f-1" }
    fileStoreMocks.fileTabs = [
      {
        id: "f-1",
        path: `/__berth_preview__/${encodeURIComponent("plugin-view:gh/readme?repo=acme%2Fdemo")}/readme.md`,
        title: "acme/demo",
      },
    ]

    render(<ActivePathStatus />)

    expect(screen.getByText("acme/demo")).toBeTruthy()
    expect(screen.queryByText(/__berth_preview__/)).toBeNull()
  })

  it("renders terminal relative working directory and title", () => {
    layoutMocks.activeWorkspaceTab = {
      kind: "primary",
      id: "term:1",
    }
    tabStoreMocks.tabs = [
      {
        id: "term:1",
        kind: "terminal",
        folderId: 1,
        terminalId: "t1",
        title: "Build Terminal",
        initialCwd: "/home/user/repo/packages/core",
      },
    ]

    render(<ActivePathStatus />)

    expect(screen.getByText("MyRepo")).toBeTruthy()
    expect(screen.getByText("packages/core · Build Terminal")).toBeTruthy()
  })

  it("keeps showing the main-area tab while the aux panel is focused", () => {
    layoutMocks.activePane = "conversation"
    layoutMocks.activeWorkspaceTab = { kind: "primary", id: "term:aux" }
    layoutMocks.activeTabByPane = { files: { kind: "file", id: "f-1" } }
    fileStoreMocks.fileTabs = [
      { id: "f-1", path: "/home/user/repo/src/App.tsx", title: "App.tsx" },
    ]
    tabStoreMocks.tabs = [
      {
        id: "term:aux",
        kind: "terminal",
        folderId: 1,
        terminalId: "t9",
        title: "claude",
      },
    ]

    render(<ActivePathStatus part="path" />)

    expect(screen.getByText("src/App.tsx")).toBeTruthy()
    expect(screen.queryByText(/claude/)).toBeNull()
  })

  it("renders conversation title and project name for conversation tab", () => {
    layoutMocks.activeWorkspaceTab = {
      kind: "primary",
      id: "conv:1",
    }
    tabStoreMocks.tabs = [
      {
        id: "conv:1",
        kind: "conversation",
        folderId: 1,
        title: "Refactor sidebar",
      },
    ]

    render(<ActivePathStatus />)

    expect(screen.getByText("MyRepo")).toBeTruthy()
    expect(screen.getByText("Refactor sidebar")).toBeTruthy()
  })

  it("renders global settings tab info when focused", () => {
    layoutMocks.activeWorkspaceTab = {
      kind: "global",
      id: "settings",
    }

    render(<ActivePathStatus />)

    expect(screen.getByText("Settings")).toBeTruthy()
  })

  it("project part shows only the project name and copies the project path", async () => {
    const user = userEvent.setup()
    layoutMocks.activeWorkspaceTab = { kind: "file", id: "f-1" }
    fileStoreMocks.fileTabs = [
      { id: "f-1", path: "/home/user/repo/src/App.tsx", title: "App.tsx" },
    ]

    render(<ActivePathStatus part="project" />)

    const entry = screen.getByRole("button", { name: "MyRepo" })
    expect(screen.queryByText(/main/)).toBeNull()
    await user.click(entry)
    expect(await navigator.clipboard.readText()).toBe("/home/user/repo")
  })

  it("directly copies item absolute path on click", async () => {
    const user = userEvent.setup()
    const writeTextSpy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    })

    layoutMocks.activeWorkspaceTab = { kind: "file", id: "f-1" }
    fileStoreMocks.fileTabs = [
      { id: "f-1", path: "/home/user/repo/src/App.tsx", title: "App.tsx" },
    ]

    render(<ActivePathStatus />)

    const pathBtn = screen.getByRole("button", { name: "src/App.tsx" })
    expect(pathBtn).toHaveAttribute(
      "title",
      'copyAbsolutePathHint:{"path":"/home/user/repo/src/App.tsx"}'
    )
    await user.click(pathBtn)

    expect(writeTextSpy).toHaveBeenCalledWith("/home/user/repo/src/App.tsx")
  })
})
