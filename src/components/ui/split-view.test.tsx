/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SplitHandle,
  SplitPane,
  SplitView,
  type SplitViewHandle,
} from "./split-view"
import { createSplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction"

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

afterEach(() => vi.restoreAllMocks())

describe("SplitView", () => {
  it("renders horizontal and vertical pane geometry with an accessible separator", () => {
    const horizontalRef = { current: null as SplitViewHandle | null }
    const horizontal = render(
      <SplitView ref={horizontalRef} direction="horizontal">
        <SplitPane id="left" defaultSize={40} />
        <SplitHandle />
        <SplitPane id="right" defaultSize={60} />
      </SplitView>
    )
    const horizontalRoot = horizontal.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(horizontalRoot, 1000, 600)
    act(() => horizontalRef.current?.setLayout([40, 60]))
    const horizontalHandle = horizontal.getByRole("separator")
    expect(horizontalHandle).toHaveAttribute("aria-orientation", "vertical")
    expect(horizontalHandle).toHaveAttribute("aria-controls", "left right")
    expect(
      horizontalRoot.style.getPropertyValue("--split-grid-template")
    ).toContain("1.000px")

    horizontal.unmount()
    const verticalRef = { current: null as SplitViewHandle | null }
    const vertical = render(
      <SplitView ref={verticalRef} direction="vertical">
        <SplitPane id="top" defaultSize={50} />
        <SplitHandle />
        <SplitPane id="bottom" defaultSize={50} />
      </SplitView>
    )
    const verticalRoot = vertical.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(verticalRoot, 600, 800)
    act(() => verticalRef.current?.setLayout([50, 50]))
    expect(verticalRoot).toHaveAttribute(
      "data-split-view-direction",
      "vertical"
    )
    expect(verticalRoot.style.gridTemplateRows).toBe(
      "var(--split-grid-template)"
    )
    expect(vertical.getByRole("separator")).toHaveAttribute(
      "aria-orientation",
      "horizontal"
    )
  })

  it("keeps pointer moves out of React layout callbacks until pointerup", () => {
    const onLayout = vi.fn()
    const ref = { current: null as SplitViewHandle | null }
    const view = render(
      <SplitView ref={ref} onLayout={onLayout}>
        <SplitPane id="files" defaultSize={40} minSizePx={200} />
        <SplitHandle />
        <SplitPane id="conversation" defaultSize={60} minSizePx={200} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)
    act(() => ref.current?.setLayout([40, 60]))
    const handle = view.getByRole("separator")

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 400,
    })
    for (let clientX = 410; clientX < 600; clientX += 2) {
      fireEvent.pointerMove(window, { pointerId: 1, clientX })
    }
    expect(onLayout).not.toHaveBeenCalled()

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 598 })
    expect(onLayout).toHaveBeenCalledOnce()
  })

  it("defers expensive consumers until the final committed geometry", () => {
    const transaction = createSplitLayoutTransaction()
    const onLayout = vi.fn()
    const expensiveStoreCommit = vi.fn()
    const ptyResize = vi.fn()
    const nativeBounds = vi.fn()
    const ref = { current: null as SplitViewHandle | null }
    const view = render(
      <SplitView
        ref={ref}
        onLayout={onLayout}
        transaction={transaction}
        onGeometry={(_, phase) => {
          if (phase === "preview" || phase === "commit") {
            transaction.schedule(expensiveStoreCommit)
            transaction.schedule(ptyResize)
            transaction.schedule(nativeBounds)
          }
        }}
      >
        <SplitPane id="files" defaultSize={40} />
        <SplitHandle />
        <SplitPane id="conversation" defaultSize={60} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)
    act(() => ref.current?.setLayout([40, 60]))
    const handle = view.getByRole("separator")

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 3,
      clientX: 400,
    })
    for (let clientX = 410; clientX < 610; clientX += 2) {
      fireEvent.pointerMove(handle, { pointerId: 3, clientX })
    }
    expect(onLayout).not.toHaveBeenCalled()
    expect(expensiveStoreCommit).not.toHaveBeenCalled()
    expect(ptyResize).not.toHaveBeenCalled()
    expect(nativeBounds).not.toHaveBeenCalled()

    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 608 })
    expect(onLayout).toHaveBeenCalledOnce()
    expect(expensiveStoreCommit).toHaveBeenCalledOnce()
    expect(ptyResize).toHaveBeenCalledOnce()
    expect(nativeBounds).toHaveBeenCalledOnce()
  })

  it("applies default ratios when a conditional pane is introduced", () => {
    const ref = { current: null as SplitViewHandle | null }
    const hasBottomPane = false
    const view = render(
      <SplitView ref={ref}>
        <SplitPane id="top" defaultSize={100} />
        {hasBottomPane ? <SplitHandle /> : null}
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)

    act(() => {
      view.rerender(
        <SplitView ref={ref}>
          <SplitPane id="top" defaultSize={48} />
          <SplitHandle />
          <SplitPane id="bottom" defaultSize={52} />
        </SplitView>
      )
    })

    expect(ref.current?.getLayout()[0]).toBeCloseTo(48)
    expect(ref.current?.getLayout()[1]).toBeCloseTo(52)
  })

  it("keeps the imperative handle dependency list size stable across rerenders", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const ref = { current: null as SplitViewHandle | null }
    const view = render(
      <SplitView ref={ref}>
        <SplitPane id="left" defaultSize={40} />
        <SplitHandle />
        <SplitPane id="right" defaultSize={60} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)

    act(() => {
      view.rerender(
        <SplitView ref={ref} direction="horizontal">
          <SplitPane id="left" defaultSize={35} />
          <SplitHandle />
          <SplitPane id="right" defaultSize={65} />
        </SplitView>
      )
      ref.current?.setLayout([35, 65])
    })

    expect(
      error.mock.calls.some((call) =>
        call.map(String).join(" ").includes("changed size between renders")
      )
    ).toBe(false)
    expect(ref.current?.getLayout()[0]).toBeCloseTo(35)
    expect(ref.current?.getLayout()[1]).toBeCloseTo(65)
    error.mockRestore()
  })

  it("applies a parent layout effect to the pane whose constraints changed", () => {
    function Shell({ auxOpen }: { auxOpen: boolean }) {
      const ref = useRef<SplitViewHandle | null>(null)
      useEffect(() => {
        ref.current?.setLayout(auxOpen ? [0, 60, 40] : [0, 100, 0])
      }, [auxOpen])
      return (
        <SplitView ref={ref}>
          <SplitPane id="left" order={1} collapsed defaultSize={0} />
          <SplitHandle disabled />
          <SplitPane id="main" order={2} defaultSize={100} />
          <SplitHandle disabled={!auxOpen} />
          <SplitPane
            id="right"
            order={3}
            collapsed={!auxOpen}
            defaultSize={0}
          />
        </SplitView>
      )
    }

    const view = render(<Shell auxOpen={false} />)
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)

    act(() => view.rerender(<Shell auxOpen />))

    expect(root.style.getPropertyValue("--split-grid-template")).toBe(
      "0.000px 0.000px 599.400px 1.000px 399.600px"
    )
  })

  it("keeps a committed restore layout across maximize and restore", () => {
    const ref = { current: null as SplitViewHandle | null }
    const view = render(
      <SplitView ref={ref}>
        <SplitPane id="left" defaultSize={40} />
        <SplitHandle />
        <SplitPane id="right" defaultSize={60} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)
    act(() => ref.current?.setLayout([35, 65]))
    act(() => ref.current?.setLayout([100, 0], "maximize"))
    expect(ref.current?.getLayout()[0]).toBeCloseTo(100)
    act(() => ref.current?.setLayout([0, 100], "restore"))
    expect(ref.current?.getLayout()[0]).toBeCloseTo(35)
    expect(ref.current?.getLayout()[1]).toBeCloseTo(65)
  })

  it("cleans pointer capture on pointercancel, lost capture, and unmount", () => {
    const dragging = vi.fn()
    const ref = { current: null as SplitViewHandle | null }
    const view = render(
      <SplitView ref={ref}>
        <SplitPane id="left" defaultSize={50} />
        <SplitHandle onDragging={dragging} />
        <SplitPane id="right" defaultSize={50} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)
    act(() => ref.current?.setLayout([50, 50]))
    const handle = view.getByRole("separator")

    fireEvent.pointerDown(handle, { button: 0, pointerId: 4, clientX: 500 })
    fireEvent.pointerCancel(handle, { pointerId: 4, clientX: 550 })
    expect(dragging).toHaveBeenNthCalledWith(1, true)
    expect(dragging).toHaveBeenNthCalledWith(2, false)

    fireEvent.pointerDown(handle, { button: 0, pointerId: 5, clientX: 500 })
    fireEvent.lostPointerCapture(handle, { pointerId: 5 })
    expect(dragging).toHaveBeenCalledTimes(4)

    fireEvent.pointerDown(handle, { button: 0, pointerId: 6, clientX: 500 })
    view.unmount()
    expect(dragging).toHaveBeenLastCalledWith(false)
  })

  it("supports keyboard collapse and restore for collapsible panes", () => {
    const ref = { current: null as SplitViewHandle | null }
    const onLayout = vi.fn()
    const view = render(
      <SplitView ref={ref} onLayout={onLayout}>
        <SplitPane id="left" defaultSize={40} collapsible />
        <SplitHandle />
        <SplitPane id="right" defaultSize={60} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)
    act(() => ref.current?.setLayout([40, 60]))
    const handle = view.getByRole("separator")

    fireEvent.keyDown(handle, { key: "Enter" })
    expect(ref.current?.getLayout()[0]).toBeCloseTo(0)
    fireEvent.keyDown(handle, { key: "Enter" })
    expect(ref.current?.getLayout()[0]).toBeCloseTo(40)
    expect(onLayout).toHaveBeenCalledTimes(2)
  })

  it("consumes recognized separator keys when already at a boundary", () => {
    const ref = { current: null as SplitViewHandle | null }
    const onLayout = vi.fn()
    const view = render(
      <SplitView ref={ref} onLayout={onLayout}>
        <SplitPane id="left" defaultSize={100} />
        <SplitHandle />
        <SplitPane id="right" defaultSize={0} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)
    act(() => ref.current?.setLayout([100, 0]))

    expect(fireEvent.keyDown(view.getByRole("separator"), { key: "End" })).toBe(
      false
    )
    expect(onLayout).not.toHaveBeenCalled()
  })

  it("cancels pointer preview on blur and commits keyboard changes", () => {
    const onLayout = vi.fn()
    const ref = { current: null as SplitViewHandle | null }
    const view = render(
      <SplitView ref={ref} onLayout={onLayout}>
        <SplitPane id="left" defaultSize={50} />
        <SplitHandle />
        <SplitPane id="right" defaultSize={50} />
      </SplitView>
    )
    const root = view.container.querySelector(
      "[data-split-view]"
    ) as HTMLElement
    setBox(root, 1000, 600)
    act(() => ref.current?.setLayout([50, 50]))
    const handle = view.getByRole("separator")

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 2,
      clientX: 500,
    })
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 650 })
    fireEvent(window, new Event("blur"))
    expect(onLayout).not.toHaveBeenCalled()

    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(onLayout).toHaveBeenCalledOnce()
    expect(handle).toHaveAttribute("aria-valuenow")
  })
})
