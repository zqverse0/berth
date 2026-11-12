import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { ProjectPanel } from "./project-panel"
import { useProjectPanelStore } from "./views"

const active = vi.hoisted(() => ({ folder: null as FolderDetail | null }))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: active.folder }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => false,
}))
vi.mock("@/components/layout/aux-panel/aux-panel-file-tree-tab", () => ({
  FileTreeTab: () => <div data-testid="files" />,
}))
vi.mock("@/components/layout/aux-panel/aux-panel-git-changes-tab", () => ({
  GitChangesTab: () => <div data-testid="changes" />,
}))
vi.mock("@/components/layout/aux-panel/aux-panel-git-log-tab", () => ({
  GitLogTab: () => <div data-testid="commits" />,
}))
vi.mock("@/components/layout/git/branch-dropdown", () => ({
  BranchDropdown: () => <div data-testid="branches" />,
}))

const tabs = enMessages.Folder.auxPanel.tabs
const panel = enMessages.ProjectPanel

function folder(id: number, extra: Partial<FolderDetail> = {}): FolderDetail {
  return {
    id,
    name: `p${id}`,
    path: `/p/${id}`,
    parent_id: null,
    alias: null,
    git_branch: "main",
    ...extra,
  } as FolderDetail
}

function renderPanel(maximized = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ProjectPanel visible maximized={maximized} />
    </NextIntlClientProvider>
  )
}

describe("ProjectPanel", () => {
  beforeEach(() => {
    localStorage.clear()
    const root = folder(1, { name: "berth" })
    active.folder = folder(2, { parent_id: 1, git_branch: "dev" })
    useAppWorkspaceStore.setState({
      allFolders: [root, active.folder],
      gitHeads: new Map(),
      branches: new Map(),
    })
    useProjectPanelStore.setState({
      tab: "files",
      collapsed: false,
      maximized: false,
    })
  })

  it("switches tabs", () => {
    renderPanel()
    expect(screen.getByTestId("files")).toBeTruthy()

    fireEvent.click(screen.getByRole("tab", { name: tabs.changes }))
    expect(screen.getByTestId("changes")).toBeTruthy()
    expect(useProjectPanelStore.getState().tab).toBe("changes")
  })

  it("renders nothing while collapsed", () => {
    useProjectPanelStore.setState({ collapsed: true })
    renderPanel()
    expect(screen.queryByRole("region")).toBeNull()
    expect(screen.queryByTestId("files")).toBeNull()
  })

  it("maximizes from the tab row", () => {
    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: panel.maximize }))
    expect(useProjectPanelStore.getState().maximized).toBe(true)
  })

  it("restores from maximized, and a non-repo has only files and branches", () => {
    useAppWorkspaceStore.setState({
      gitHeads: new Map([
        [
          2,
          {
            is_repo: false,
            branch: null,
            detached: false,
            short_sha: null,
          },
        ],
      ]),
    })
    useProjectPanelStore.setState({ maximized: true })
    renderPanel(true)
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      tabs.files,
      tabs.branches,
    ])

    fireEvent.click(screen.getByRole("button", { name: panel.restore }))
    expect(useProjectPanelStore.getState().maximized).toBe(false)
  })
})
