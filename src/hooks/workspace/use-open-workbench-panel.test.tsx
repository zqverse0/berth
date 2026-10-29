import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  openGlobalTab: vi.fn(),
}))

vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: (
    selector: (state: { openGlobalTab: () => void }) => unknown
  ) => selector({ openGlobalTab: mocks.openGlobalTab }),
}))

import { useOpenWorkbenchPanel } from "./use-open-workbench-panel"
import { useWorkbenchLayout } from "./use-workbench-layout"

describe("useOpenWorkbenchPanel", () => {
  beforeEach(() => {
    mocks.openGlobalTab.mockReset()
  })

  it("openSettings() without a page keeps the current selection", () => {
    const layout = renderHook(() => useWorkbenchLayout())
    const open = renderHook(() => useOpenWorkbenchPanel())

    act(() => {
      layout.result.current.selectPanel("settings", "advanced")
    })
    act(() => {
      open.result.current.openSettings()
    })

    expect(layout.result.current.selected.settings).toBe("advanced")
    expect(mocks.openGlobalTab).toHaveBeenCalledWith("settings")
  })

  it("routes settings panels to the settings tab", () => {
    const layout = renderHook(() => useWorkbenchLayout())
    const open = renderHook(() => useOpenWorkbenchPanel())

    act(() => {
      open.result.current.openSettings("appearance")
    })
    expect(layout.result.current.selected.settings).toBe("appearance")
    expect(mocks.openGlobalTab).toHaveBeenCalledTimes(1)
  })
})
