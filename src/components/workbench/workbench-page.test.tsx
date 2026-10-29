import { useEffect, useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type {
  ResolvedWorkbench,
  WorkbenchPageId,
  WorkbenchPanelId,
} from "@/lib/workbench"
import { WorkbenchPage } from "./workbench-page"

const selectPanel = vi.fn()

const hookState = vi.hoisted(() => ({
  pages: ["appearance", "advanced"] as WorkbenchPanelId[],
}))

vi.mock("@/hooks/workspace/use-workbench-layout", () => ({
  useWorkbenchLayout: vi.fn(),
}))

import { useWorkbenchLayout } from "@/hooks/workspace/use-workbench-layout"

function emptyResolved(panels: WorkbenchPanelId[]): ResolvedWorkbench {
  return {
    pages: {
      settings: panels,
    },
  }
}

const persistMounts = { count: 0 }

function PersistentBody() {
  const { selected } = useWorkbenchLayout()
  const panelId = selected.settings ?? "none"

  useEffect(() => {
    persistMounts.count += 1
  }, [])

  return <div data-testid="persistent-body">{panelId}</div>
}

function HookedPage({ sharedBody = false }: { sharedBody?: boolean } = {}) {
  const [selectedId, setSelectedId] = useState<WorkbenchPanelId | null>(
    hookState.pages[0] ?? null
  )

  vi.mocked(useWorkbenchLayout).mockReturnValue({
    resolved: emptyResolved(hookState.pages),
    selected: {
      settings: selectedId ?? undefined,
    },
    selectPanel: (pageId: WorkbenchPageId, panelId: WorkbenchPanelId) => {
      selectPanel(pageId, panelId)
      setSelectedId(panelId)
    },
  })

  return (
    <WorkbenchPage
      pageId="settings"
      renderPanel={
        sharedBody
          ? undefined
          : (panelId) => <div data-testid={`${panelId}-panel`}>{panelId}</div>
      }
    >
      {sharedBody ? <PersistentBody /> : undefined}
    </WorkbenchPage>
  )
}

function renderPage(props: { sharedBody?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div className="h-96">
        <HookedPage {...props} />
      </div>
    </NextIntlClientProvider>
  )
}

describe("WorkbenchPage", () => {
  beforeEach(() => {
    selectPanel.mockReset()
    hookState.pages = ["appearance", "advanced"]
    vi.mocked(useWorkbenchLayout).mockReset()
  })

  it("renders assigned tabs and selects trending content", () => {
    renderPage()

    expect(screen.getAllByRole("tab")).toHaveLength(2)
    expect(screen.getByRole("tab", { name: "Appearance" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Advanced" })).toBeTruthy()
    expect(screen.getByTestId("appearance-panel")).toBeTruthy()

    const advancedTab = screen.getByRole("tab", {
      name: "Advanced",
    })
    fireEvent.mouseDown(advancedTab)
    fireEvent.click(advancedTab)

    expect(selectPanel).toHaveBeenCalledWith("settings", "advanced")
    expect(screen.getByTestId("advanced-panel")).toBeTruthy()
    expect(screen.queryByTestId("appearance-panel")).toBeNull()
  })

  it("uses the workbench tab strip layout contract", () => {
    const { container } = renderPage()

    const tabList = container.querySelector('[data-slot="tabs-list"]')
    expect(tabList).toHaveClass(
      "h-10",
      "w-full",
      "flex-nowrap",
      "overflow-x-auto",
      "rounded-none",
      "bg-transparent"
    )
    const trigger = container.querySelector('[data-slot="tabs-trigger"]')
    expect(trigger).toHaveClass("flex-none")
    expect(trigger).not.toHaveClass("flex-1")
    expect(container.querySelector('[data-slot="tabs"]')).toHaveClass(
      "h-full",
      "min-h-0"
    )
  })

  it("keeps a shared body mounted across tab switches", () => {
    persistMounts.count = 0
    renderPage({ sharedBody: true })

    expect(screen.getByTestId("persistent-body")).toHaveTextContent(
      "appearance"
    )
    const sharedPanel = screen.getByRole("tabpanel")
    expect(sharedPanel).toHaveAttribute("id", "settings-panel")
    expect(sharedPanel).toHaveAttribute(
      "aria-labelledby",
      "settings-tab-appearance"
    )
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute(
      "aria-controls",
      "settings-panel"
    )

    const advancedTab = screen.getByRole("tab", {
      name: "Advanced",
    })
    fireEvent.mouseDown(advancedTab)
    fireEvent.click(advancedTab)

    expect(screen.getByTestId("persistent-body")).toHaveTextContent("advanced")
    expect(persistMounts.count).toBe(1)
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "settings-tab-advanced"
    )
  })

  it("keeps the tab strip when a panel throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    function BoomPanel(): React.ReactNode {
      throw new Error("panel boom")
    }

    vi.mocked(useWorkbenchLayout).mockReturnValue({
      resolved: emptyResolved(["appearance", "advanced"]),
      selected: { settings: "appearance" },
      selectPanel,
    })

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div className="h-96">
          <WorkbenchPage
            pageId="settings"
            renderPanel={(panelId) =>
              panelId === "appearance" ? <BoomPanel /> : <div>{panelId}</div>
            }
          />
        </div>
      </NextIntlClientProvider>
    )

    expect(screen.getAllByRole("tab")).toHaveLength(2)
    expect(screen.getByRole("tab", { name: "Appearance" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Advanced" })).toBeTruthy()
    expect(screen.getByText("This tab failed to render.")).toBeTruthy()

    errorSpy.mockRestore()
  })
})
