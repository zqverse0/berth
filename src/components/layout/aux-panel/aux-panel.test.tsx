import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { act, render as testingRender, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AuxPanel } from "@/components/layout/aux-panel/aux-panel"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"

const folder = vi.hoisted(() => ({ id: 1 }))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: folder.id } }),
}))
vi.mock("@/components/project-management/berth-tasks/group-panel", () => ({
  GroupPanel: () => <div>GroupPanel</div>,
}))

const selectTerminal = (id: string | null) =>
  useWorkspaceLayoutStore.setState((state) => ({
    activeTabByPane: {
      ...state.activeTabByPane,
      conversation: id ? { kind: "primary", id } : null,
    },
  }))

vi.mock("@/components/tabs/tab-bar", () => ({
  TabBar: () => <div data-testid="mock-tab-bar">TabBar</div>,
}))

vi.mock("@/components/workspace/workspace-pane-content", () => ({
  WorkspacePaneContent: ({ pane }: { pane: string }) => (
    <div data-testid="mock-pane-content">{pane}</div>
  ),
}))

vi.mock("@/components/workspace/workspace-pane-drop-area", () => ({
  WorkspacePaneDropArea: ({ children }: { children: React.ReactNode }) =>
    children,
}))

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isWindows: false, isLinux: false, isMac: true }),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

const render = (element: React.ReactNode) =>
  testingRender(element, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale="en" messages={en}>
        {children}
      </NextIntlClientProvider>
    ),
  })

describe("AuxPanel", () => {
  beforeEach(() => {
    folder.id = 1
    useAppUiStore.setState({ auxPanelOpen: true, auxView: "group" })
    selectTerminal(null)
  })

  it("renders TabBar and the conversation tab group content when open", () => {
    render(<AuxPanel />)
    expect(screen.getByTestId("mock-tab-bar")).toBeInTheDocument()
    expect(screen.getByTestId("mock-pane-content")).toHaveTextContent(
      "conversation"
    )
  })

  it("returns null when closed and not forced via present", () => {
    useAppUiStore.setState({ auxPanelOpen: false })
    const { container } = render(<AuxPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders when closed if present=true during collapse animation", () => {
    useAppUiStore.setState({ auxPanelOpen: false })
    render(<AuxPanel present={true} />)
    expect(screen.getByTestId("mock-tab-bar")).toBeInTheDocument()
    expect(screen.getByTestId("mock-pane-content")).toBeInTheDocument()
  })

  it("stays mounted but inert after closing so terminals keep their state", () => {
    const { rerender, container } = render(<AuxPanel present={true} />)
    act(() => useAppUiStore.setState({ auxPanelOpen: false }))
    rerender(<AuxPanel present={false} />)
    expect(screen.getByTestId("mock-pane-content")).toBeInTheDocument()
    expect(container.querySelector("aside")).toHaveAttribute("inert")
  })

  it("switches to a newly selected terminal without updating another panel during render", () => {
    const errors = vi.spyOn(console, "error")
    try {
      render(
        <>
          <AuxPanel />
          <AuxPanel />
        </>
      )
      act(() => selectTerminal("terminal-1"))
      expect(useAppUiStore.getState().auxView).toBe("terminals")
      expect(errors.mock.calls.flat().join(" ")).not.toContain(
        "Cannot update a component"
      )
      act(() => useAppUiStore.getState().showAuxView("group"))
      expect(useAppUiStore.getState().auxView).toBe("group")
    } finally {
      errors.mockRestore()
    }
  })

  it("keeps the group view on mount and when switching projects", () => {
    selectTerminal("terminal-1")
    const { rerender } = render(<AuxPanel />)
    expect(useAppUiStore.getState().auxView).toBe("group")
    act(() => {
      folder.id = 2
      selectTerminal("terminal-2")
    })
    rerender(<AuxPanel />)
    expect(useAppUiStore.getState().auxView).toBe("group")
  })
})
