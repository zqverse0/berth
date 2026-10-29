import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PointerEvent as ReactPointerEvent } from "react"
import { startWorkspaceTabDrag } from "@/hooks/workspace/workspace-tab-drag-controller"
import {
  createInitialWorkspaceLayoutState,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore, type TabItem } from "@/stores/tab-store"
import type { WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"

const terminal = {
  kind: "terminal",
  id: "term-a",
  terminalId: "term-a",
  folderId: 1,
  title: "Terminal",
} as TabItem
const ref: WorkspaceTabRef = { kind: "primary", id: "term-a", type: "terminal" }

function pointer(type: string, x: number) {
  return Object.assign(new MouseEvent(type, { clientX: x, clientY: 10 }), {
    pointerId: 1,
    pointerType: "mouse",
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16))
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
  useAppWorkspaceStore.setState({ activeFolderId: 1, allFolders: [] })
  useTabStore.setState({ tabs: [terminal], rawTabs: [terminal] })
  useWorkspaceLayoutStore.setState({
    ...createInitialWorkspaceLayoutState(),
    placementByScope: {},
    tabOrderByScope: {},
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

it("always ends the drag, even when committing the drop throws", () => {
  // A strip under the pointer gives the drop a target.
  const strip = document.createElement("div")
  strip.dataset.workspaceTabStrip = "files"
  strip.getBoundingClientRect = () =>
    ({ left: 0, right: 500, top: 0, bottom: 40, width: 500 }) as DOMRect
  const tab = document.createElement("div")
  strip.append(tab)
  document.body.append(strip)
  useWorkspaceLayoutStore.setState({
    dropWorkspaceTab: () => {
      throw new Error("boom")
    },
  })

  startWorkspaceTabDrag(
    {
      button: 0,
      target: tab,
      currentTarget: tab,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "mouse",
    } as unknown as ReactPointerEvent<HTMLElement>,
    ref
  )
  window.dispatchEvent(pointer("pointermove", 40))
  expect(useWorkspaceLayoutStore.getState().dragging).toEqual(ref)
  expect(document.querySelector("[data-tab-drag-ghost]")).not.toBeNull()

  window.dispatchEvent(pointer("pointerup", 40))
  expect(() => vi.runAllTimers()).toThrow("boom")

  expect(useWorkspaceLayoutStore.getState().dragging).toBeNull()
  expect(document.querySelector("[data-tab-drag-ghost]")).toBeNull()
  expect(document.documentElement.hasAttribute("data-berth-tab-dragging")).toBe(
    false
  )
})
