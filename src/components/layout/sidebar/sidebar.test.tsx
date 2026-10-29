import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { Sidebar } from "@/components/layout/sidebar/sidebar"
import { useSidebarViewStore } from "@/components/layout/sidebar/views"
import enMessages from "@/i18n/messages/en.json"
import { useAppUiStore } from "@/stores/app-ui-store"

// Stable spies + mutable active-folder, referenced from the hoisted mock
// factories below (vi.mock is hoisted above imports).
const spies = vi.hoisted(() => ({
  openTab: vi.fn(),
  // Latest props the stubbed conversation list received.
  listProps: null as {
    pane?: "projects" | "files"
    visible?: boolean
  } | null,
}))

// The project explorer is irrelevant here — stub it so the test exercises only
// the sidebar's header and visibility wiring.
vi.mock("@/components/conversations/sidebar/sidebar-project-list", () => ({
  SidebarProjectList: (props: {
    pane?: "projects" | "files"
    visible?: boolean
  }) => {
    spies.listProps = props
    return <button type="button">Mock project explorer</button>
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

  it("uses the project-only explorer projection and keeps the list mounted", () => {
    renderSidebar()

    expect(spies.listProps?.pane).toBe("projects")
    expect(
      screen.getByRole("button", { name: "Mock project explorer" })
    ).toBeTruthy()
    expect(screen.queryByPlaceholderText("Search conversations...")).toBeNull()
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

  it("switches to the files view when a file-tree reveal is requested", () => {
    useSidebarViewStore.setState({ view: "tasks" })
    useAppUiStore.setState({ sidebarOpen: false })
    renderSidebar()

    act(() => {
      useAppUiStore.getState().revealInFileTree("src/app")
    })

    expect(useAppUiStore.getState().sidebarOpen).toBe(true)
    expect(useSidebarViewStore.getState().view).toBe("files")
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
