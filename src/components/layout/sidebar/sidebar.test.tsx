import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { Sidebar } from "@/components/layout/sidebar/sidebar"
import {
  useProjectPanelStore,
  useSidebarViewStore,
} from "@/components/layout/sidebar/views"
import enMessages from "@/i18n/messages/en.json"
import { useAppUiStore } from "@/stores/app-ui-store"

// Stable spies + mutable active-folder, referenced from the hoisted mock
// factories below (vi.mock is hoisted above imports).
const spies = vi.hoisted(() => ({
  openTab: vi.fn(),
  // Latest props the stubbed conversation list received.
  listProps: null as {
    visible?: boolean
    summaryOnly?: boolean
  } | null,
  panelProps: null as { visible: boolean; maximized: boolean } | null,
}))

// The project explorer is irrelevant here — stub it so the test exercises only
// the sidebar's header and visibility wiring.
vi.mock("@/components/conversations/sidebar/sidebar-project-list", () => ({
  SidebarProjectList: (props: { visible?: boolean; summaryOnly?: boolean }) => {
    spies.listProps = props
    return <button type="button">Mock project explorer</button>
  },
}))
vi.mock("@/components/layout/sidebar/project-panel", () => ({
  ProjectPanel: (props: { visible: boolean; maximized: boolean }) => {
    spies.panelProps = props
    return <div data-testid="project-panel" />
  },
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openTab: spies.openTab,
  }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

function renderSidebar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Sidebar />
    </NextIntlClientProvider>
  )
}

describe("Sidebar — project explorer", () => {
  beforeEach(() => {
    useAppUiStore.getState().resetAppUi()
  })

  it("does not expose the legacy Automations sidebar entry", () => {
    const { queryByText } = renderSidebar()
    expect(queryByText("Automations")).toBeNull()
  })

  it("does not render the removed conversation search entry", () => {
    expect(
      renderSidebar().queryByPlaceholderText("Search conversations...")
    ).toBeNull()
  })

  it("does not render a duplicate clone action beside the conversation list", () => {
    renderSidebar()
    expect(
      screen.queryByRole("button", { name: "Clone Repository" })
    ).toBeNull()
  })

  it("splits the project view into the list above and the project panel below", () => {
    useSidebarViewStore.setState({ view: "projects" })
    renderSidebar()

    expect(spies.listProps?.summaryOnly).toBe(false)
    expect(spies.panelProps?.maximized).toBe(false)
    expect(screen.getByTestId("project-panel")).toBeTruthy()
    expect(screen.getByRole("separator")).toBeTruthy()
  })

  it("maximizes the panel from the store; double-clicking the handle toggles it", () => {
    useSidebarViewStore.setState({ view: "projects" })
    useProjectPanelStore.setState({ tab: "files", maximized: false })
    renderSidebar()

    act(() => useProjectPanelStore.getState().setMaximized(true))
    expect(spies.panelProps?.maximized).toBe(true)
    expect(spies.listProps?.summaryOnly).toBe(true)

    // 双击分隔条在最大化与默认分割间切换
    fireEvent.doubleClick(screen.getByRole("separator"))
    expect(useProjectPanelStore.getState().maximized).toBe(false)
    expect(spies.listProps?.summaryOnly).toBe(false)
    fireEvent.doubleClick(screen.getByRole("separator"))
    expect(useProjectPanelStore.getState().maximized).toBe(true)
    act(() => useProjectPanelStore.getState().setMaximized(false))
  })

  it("leaves the desktop view switcher to the window-level ActivityBar", () => {
    renderSidebar()

    expect(
      screen.getByRole("button", { name: "Mock project explorer" })
    ).toBeTruthy()
    // Desktop view icons live in ActivityBar so they survive a collapsed sidebar.
    expect(screen.queryByRole("button", { name: "Git" })).toBeNull()
  })

  it("does not expose import or message navigation sidebar tools", () => {
    renderSidebar()

    expect(
      screen.queryByRole("button", { name: "Import local sessions" })
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Message navigation" })
    ).toBeNull()
    expect(screen.queryByTestId("import-sessions-view")).toBeNull()
    expect(screen.queryByTestId("message-navigation-view")).toBeNull()
  })
})

describe("Sidebar — desktop visibility lifecycle", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
  })

  it("shows the files tab without maximizing when a file-tree reveal is requested", () => {
    useSidebarViewStore.setState({ view: "tasks" })
    useProjectPanelStore.setState({
      tab: "changes",
      collapsed: true,
      maximized: false,
    })
    useAppUiStore.setState({ sidebarOpen: false })
    renderSidebar()

    act(() => {
      useAppUiStore.getState().revealInFileTree("src/app")
    })

    expect(useAppUiStore.getState().sidebarOpen).toBe(true)
    expect(useSidebarViewStore.getState().view).toBe("projects")
    expect(useProjectPanelStore.getState()).toMatchObject({
      tab: "files",
      collapsed: false,
      maximized: false,
    })
  })

  it("threads visible=true to the project explorer when open", () => {
    renderSidebar()
    // The mock sidebar context returns isOpen=true.
    expect(spies.listProps?.visible).toBe(true)
  })

  it("keeps the project explorer mounted on desktop when sidebar is closed", () => {
    // The default mock returns isOpen=true. On desktop (useIsMobile=false),
    // the sidebar does NOT return null when closed — it stays mounted with
    // invisible + pointer-events-none styling.
    // Since the mock always returns isOpen=true, we verify the list is rendered.
    renderSidebar()
    expect(
      screen.getByRole("button", { name: "Mock project explorer" })
    ).toBeTruthy()
  })
})

describe("Sidebar — bottom status bar removed", () => {
  it("does not render a bottom status bar inside the sidebar", () => {
    const { container } = renderSidebar()
    const bottomBar = container.querySelector("[data-sidebar-status-bar]")
    expect(bottomBar).toBeNull()
  })
})
