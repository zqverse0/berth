import { act, render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { AppUiRuntime } from "./app-ui-runtime"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"

beforeEach(() => {
  localStorage.clear()
  useAppUiStore.getState().resetAppUi()
  useAppWorkspaceStore.setState({ activeFolderId: null })
})

describe("AppUiRuntime", () => {
  it("hydrates persisted panels and clears reveals when the folder scope changes", async () => {
    localStorage.setItem(
      "workspace:left-sidebar",
      JSON.stringify({ isOpen: false, width: 410 })
    )
    localStorage.setItem(
      "workspace:right-sidebar",
      JSON.stringify({ isOpen: true, width: 390 })
    )

    render(<AppUiRuntime />)

    await waitFor(() => {
      expect(useAppUiStore.getState().sidebarRestored).toBe(true)
      expect(useAppUiStore.getState().auxPanelRestored).toBe(true)
    })
    expect(useAppUiStore.getState().sidebarOpen).toBe(false)
    expect(useAppUiStore.getState().sidebarWidth).toBe(410)
    expect(useAppUiStore.getState().auxPanelOpen).toBe(true)
    expect(useAppUiStore.getState().auxPanelWidth).toBe(390)

    act(() => {
      useAppUiStore.getState().setSidebarWidth(500)
      useAppUiStore.getState().setAuxPanelWidth(450)
    })
    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem("workspace:left-sidebar") ?? "null")
      ).toMatchObject({ isOpen: false, width: 500 })
      expect(
        JSON.parse(localStorage.getItem("workspace:right-sidebar") ?? "null")
      ).toMatchObject({ isOpen: true, width: 450 })
    })

    act(() => {
      useAppUiStore.getState().revealInFileTree("src/app/page.tsx")
      useAppWorkspaceStore.setState({ activeFolderId: 2 })
    })

    await waitFor(() => {
      expect(useAppUiStore.getState().pendingRevealPath).toBeNull()
    })
  })
})
