import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import {
  useProjectPanelStore,
  useSidebarViewStore,
} from "@/components/layout/sidebar/views"
import type { FolderDetail } from "@/lib/types"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { StatusBarProject } from "./status-bar-project"

const mocks = vi.hoisted(() => ({
  folder: null as FolderDetail | null,
  settingsActive: false,
  closeSettings: vi.fn(),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: mocks.folder }),
}))
vi.mock("@/contexts/settings-workspace-context", () => ({
  useSettingsWorkspace: () => ({
    isActive: mocks.settingsActive,
    closeSettings: mocks.closeSettings,
  }),
}))

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

function renderButton() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarProject />
    </NextIntlClientProvider>
  )
  return screen.getByRole("button")
}

describe("StatusBarProject", () => {
  beforeEach(() => {
    localStorage.clear()
    const root = folder(1, { name: "berth" })
    mocks.folder = folder(2, { parent_id: 1, git_branch: "dev" })
    mocks.settingsActive = false
    mocks.closeSettings.mockClear()
    useAppWorkspaceStore.setState({
      allFolders: [root, mocks.folder],
      branches: new Map(),
    })
    useAppUiStore.setState({ sidebarOpen: true })
    useSidebarViewStore.setState({ view: "projects" })
    useProjectPanelStore.setState({ collapsed: false, maximized: false })
  })

  it("titles the worktree as root ⎇ branch and does not copy on click", () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    const button = renderButton()
    expect(button.textContent).toContain("berth")
    expect(button.textContent).toContain("dev")

    fireEvent.click(button)
    expect(writeText).not.toHaveBeenCalled()
  })

  it("toggles the panel in the project view", () => {
    const button = renderButton()
    expect(button.getAttribute("aria-expanded")).toBe("true")

    fireEvent.click(button)
    expect(useProjectPanelStore.getState().collapsed).toBe(true)
    expect(button.getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(button)
    expect(useProjectPanelStore.getState().collapsed).toBe(false)
  })

  it("collapses a maximized panel and leaves maximize", () => {
    useProjectPanelStore.setState({ maximized: true })
    fireEvent.click(renderButton())
    expect(useProjectPanelStore.getState()).toMatchObject({
      collapsed: true,
      maximized: false,
    })
  })

  it("returns to the project view and opens the sidebar before expanding", () => {
    useAppUiStore.setState({ sidebarOpen: false })
    useSidebarViewStore.setState({ view: "tasks" })
    useProjectPanelStore.setState({ collapsed: true })
    fireEvent.click(renderButton())

    expect(useAppUiStore.getState().sidebarOpen).toBe(true)
    expect(useSidebarViewStore.getState().view).toBe("projects")
    expect(useProjectPanelStore.getState().collapsed).toBe(false)
  })

  it("leaves settings mode when opened from settings", () => {
    mocks.settingsActive = true
    useSidebarViewStore.setState({ view: "settings" })
    fireEvent.click(renderButton())

    expect(useSidebarViewStore.getState().view).toBe("projects")
    expect(mocks.closeSettings).toHaveBeenCalledOnce()
  })
})
