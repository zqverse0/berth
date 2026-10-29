/**
 * @vitest-environment jsdom
 *
 * 复现：辅助面板打开状态下刷新（hydrate 后 auxOpen=true），
 * folder-shell SplitView 的 left/main pane 注册丢失，仅剩 right。
 * 时序模拟 AppUiRuntime：mount 后的 passive effect 里才把 auxOpen 置 true。
 */
import { act, render } from "@testing-library/react"
import { useEffect, useRef, useState } from "react"
import { StrictMode } from "react"
import { describe, expect, it } from "vitest"
import {
  SplitHandle,
  SplitPane,
  SplitView,
  type SplitViewHandle,
} from "./split-view"

function setBox(element: HTMLElement, width: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {
        return {}
      },
    }) as DOMRect
}

describe("folder-shell hydration regression", () => {
  it("keeps all three panes registered when auxOpen flips after mount (StrictMode)", async () => {
    const logs: string[] = []
    const log = (m: string) =>
      logs.push(`${String((globalThis as { __raf?: number }).__raf ?? 0)} ${m}`)

    function Shell() {
      const ref = useRef<SplitViewHandle | null>(null)
      // 模拟 app-ui-store：初始默认 auxOpen=false，mount 后 passive effect 恢复持久化值 true
      const [auxOpen, setAuxOpen] = useState(false)
      const [sidebarOpen] = useState(true)

      useEffect(() => {
        // AppUiRuntime hydrate：paint 后异步恢复
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setAuxOpen(true)
      }, [])

      useEffect(() => {
        // FolderWorkspaceShell 的 setLayout effect（等价 buildShellLayout 简化版）
        ref.current?.setLayout(
          auxOpen ? [18, 60, 22] : [18, 100, 0],
          "external-resize"
        )
      }, [auxOpen])

      return (
        <SplitView id="folder-shell-group" ref={ref} direction="horizontal">
          <SplitPane
            id="folder-shell-left-panel"
            order={1}
            defaultSize={14}
            collapsed={!sidebarOpen}
            minSizePx={sidebarOpen ? 180 : 0}
            maxSizePx={sidebarOpen ? 900 : 0}
          >
            <div>sidebar</div>
          </SplitPane>
          <SplitHandle disabled={!sidebarOpen} />
          <SplitPane
            id="folder-shell-main-panel"
            order={2}
            defaultSize={64}
            minSizePx={420}
          >
            <div>main</div>
          </SplitPane>
          <SplitHandle disabled={!auxOpen} />
          <SplitPane
            id="folder-shell-right-panel"
            order={3}
            defaultSize={18}
            collapsed={!auxOpen}
            minSizePx={auxOpen ? 260 : 0}
            maxSizePx={auxOpen ? 900 : 0}
          >
            <div>aux</div>
          </SplitPane>
        </SplitView>
      )
    }

    const view = render(
      <StrictMode>
        <Shell />
      </StrictMode>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1400, 900)

    // 让 passive effects（hydrate + setLayout）跑完
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const panes = [...root.querySelectorAll(":scope > [data-split-pane]")]
    const paneInfo = panes.map((p) => ({
      id: p.getAttribute("data-split-pane-id"),
      gridColumn: (p as HTMLElement).style.gridColumn || "(none)",
    }))
    const template = root.style.getPropertyValue("--split-grid-template")
    const layout = view.container.querySelector("[data-split-view]")

    log(`template=${template}`)
    for (const p of paneInfo) log(`${p.id}: col=${p.gridColumn}`)

    // 期望：三个 pane 都有 grid 定位，template 有 5 个 track
    expect(paneInfo.map((p) => p.gridColumn)).toEqual(["1", "3", "5"])
    expect(template.split(" ").length).toBe(5)
    expect(layout).toBeTruthy()
  })

  it("CONTROL: same timeline WITHOUT StrictMode", async () => {
    function Shell() {
      const ref = useRef<SplitViewHandle | null>(null)
      const [auxOpen, setAuxOpen] = useState(false)
      const [sidebarOpen] = useState(true)

      useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setAuxOpen(true)
      }, [])

      useEffect(() => {
        ref.current?.setLayout(
          auxOpen ? [18, 60, 22] : [18, 100, 0],
          "external-resize"
        )
      }, [auxOpen])

      return (
        <SplitView id="folder-shell-group" ref={ref} direction="horizontal">
          <SplitPane
            id="folder-shell-left-panel"
            order={1}
            defaultSize={14}
            collapsed={!sidebarOpen}
            minSizePx={sidebarOpen ? 180 : 0}
            maxSizePx={sidebarOpen ? 900 : 0}
          >
            <div>sidebar</div>
          </SplitPane>
          <SplitHandle disabled={!sidebarOpen} />
          <SplitPane
            id="folder-shell-main-panel"
            order={2}
            defaultSize={64}
            minSizePx={420}
          >
            <div>main</div>
          </SplitPane>
          <SplitHandle disabled={!auxOpen} />
          <SplitPane
            id="folder-shell-right-panel"
            order={3}
            defaultSize={18}
            collapsed={!auxOpen}
            minSizePx={auxOpen ? 260 : 0}
            maxSizePx={auxOpen ? 900 : 0}
          >
            <div>aux</div>
          </SplitPane>
        </SplitView>
      )
    }

    const view = render(<Shell />)
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1400, 900)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const panes = [...root.querySelectorAll(":scope > [data-split-pane]")]
    const paneInfo = panes.map((p) => ({
      id: p.getAttribute("data-split-pane-id"),
      gridColumn: (p as HTMLElement).style.gridColumn || "(none)",
    }))
    const template = root.style.getPropertyValue("--split-grid-template")
    console.log("NO-STRICTMODE:", JSON.stringify({ template, paneInfo }))
    expect(paneInfo.map((p) => p.gridColumn)).toEqual(["1", "3", "5"])
  })
})
