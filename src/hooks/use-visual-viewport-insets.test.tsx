import { act, renderHook } from "@testing-library/react"
import { expect, it } from "vitest"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useVisualViewportInsets } from "./use-visual-viewport-insets"

it("可见高度比满高矮一截才算软键盘弹出，转屏后重新量满高", () => {
  const viewport = Object.assign(new EventTarget(), {
    width: 400,
    height: 800,
    offsetTop: 0,
  })
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  })
  const resize = (width: number, height: number) =>
    act(() => {
      Object.assign(viewport, { width, height })
      viewport.dispatchEvent(new Event("resize"))
    })
  const open = () => useAppUiStore.getState().softKeyboardOpen

  const hook = renderHook(() => useVisualViewportInsets(true))
  expect(open()).toBe(false)
  resize(400, 760) // 地址栏收起 / 伸出
  expect(open()).toBe(false)
  resize(400, 480)
  expect(open()).toBe(true)
  resize(400, 800)
  expect(open()).toBe(false)
  resize(400, 480)
  hook.unmount()
  expect(open()).toBe(false)
  renderHook(() => useVisualViewportInsets(true))
  resize(800, 380) // 横屏：新宽度下 380 就是满高
  expect(open()).toBe(false)
})
