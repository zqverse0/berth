import { beforeEach, describe, expect, it } from "vitest"
import {
  APP_UI_DEFAULTS,
  useAppUiStore,
  type AlertAction,
} from "@/stores/app-ui-store"

beforeEach(() => {
  useAppUiStore.getState().resetAppUi()
})

describe("app UI store", () => {
  it("keeps alert, task, and search actions in one owner", () => {
    const { pushAlert, addTask, updateTask, requestSearchFocus } =
      useAppUiStore.getState()
    const action: AlertAction = {
      label: "Retry",
      kind: "open_url",
      payload: "{}",
    }

    const alertId = pushAlert("error", "Connection failed", "Details", [action])
    addTask("task-1", "Working")
    updateTask("task-1", { status: "running", progress: 25 })
    requestSearchFocus()

    const state = useAppUiStore.getState()
    expect(state.alerts[0]).toMatchObject({
      id: alertId,
      level: "error",
      message: "Connection failed",
      actions: [action],
    })
    expect(state.tasks).toEqual([
      { id: "task-1", label: "Working", status: "running", progress: 25 },
    ])
    expect(state.focusRequest).toBe(1)

    updateTask("task-1", { status: "completed" })
    expect(useAppUiStore.getState().tasks).toEqual([])
  })

  it("hydrates persisted panels with clamping and mobile defaults", () => {
    const state = useAppUiStore.getState()
    state.hydrateSidebar({ isOpen: false, width: 10 }, false)
    state.setAuxPanelMinWidth(260)
    state.hydrateAuxPanel({ isOpen: true, width: 9999 }, true)

    const hydrated = useAppUiStore.getState()
    expect(hydrated.sidebarOpen).toBe(false)
    expect(hydrated.sidebarWidth).toBe(APP_UI_DEFAULTS.sidebarMinWidth)
    expect(hydrated.sidebarRestored).toBe(true)
    expect(hydrated.auxPanelOpen).toBe(false)
    expect(hydrated.auxPanelWidth).toBe(APP_UI_DEFAULTS.auxPanelMaxWidth)
    expect(hydrated.auxPanelMinWidth).toBe(260)
    expect(hydrated.auxPanelRestored).toBe(true)
  })

  it("resets pending reveals and all UI state explicitly", () => {
    const state = useAppUiStore.getState()
    state.revealInFileTree("src/app/page.tsx")
    state.addTask("task-1", "Working")
    state.setAuxPanelOpen(true)
    state.resetAppUi()

    const reset = useAppUiStore.getState()
    expect(reset.pendingRevealPath).toBeNull()
    expect(reset.tasks).toEqual([])
    expect(reset.auxPanelOpen).toBe(APP_UI_DEFAULTS.auxPanelOpen)
    expect(reset.auxPanelMinWidth).toBe(APP_UI_DEFAULTS.auxPanelMinWidth)
  })
})
