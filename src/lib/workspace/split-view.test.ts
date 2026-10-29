import { describe, expect, it, vi } from "vitest"
import {
  buildSplitGridTemplate,
  createSplitGestureSession,
  resizeSplitLayout,
  solveSplitLayout,
  type SplitPaneBounds,
} from "@/lib/workspace/split-view"

function bounds(min: number, max: number): SplitPaneBounds[] {
  return [
    {
      id: "left",
      min,
      max,
      weight: 1,
      collapsible: false,
      collapsedSize: 0,
      collapsed: false,
      visible: true,
    },
    {
      id: "right",
      min,
      max,
      weight: 1,
      collapsible: false,
      collapsedSize: 0,
      collapsed: false,
      visible: true,
    },
  ]
}

describe("split layout solver", () => {
  it("solves horizontal and vertical layouts in pixels with separators", () => {
    const result = solveSplitLayout({
      containerSize: 1000,
      panes: [
        { id: "a", defaultSize: 30, minSizePx: 200 },
        { id: "b", defaultSize: 20, minSizePx: 100 },
        { id: "c", defaultSize: 50, minSizePx: 150, maxSizePx: 700 },
      ],
      separatorSizes: [1, 1],
    })

    expect(result.availableSize).toBe(998)
    expect(result.sizes.reduce((total, size) => total + size, 0)).toBeCloseTo(
      998
    )
    expect(result.tracks[0]?.size).toBeCloseTo(299.4)
    expect(result.tracks[1]?.offset).toBeCloseTo(300.4)
    expect(
      buildSplitGridTemplate(result.sizes, result.separatorSizes)
    ).toContain("1.000px")
  })

  it("redistributes a divider delta only within adjacent pane bounds", () => {
    const constrainedBounds = bounds(200, 800)
    constrainedBounds[0].max = 500
    expect(resizeSplitLayout([400, 598], constrainedBounds, 0, 150)).toEqual([
      500, 498,
    ])
    expect(resizeSplitLayout([400, 598], constrainedBounds, 0, -500)).toEqual([
      200, 798,
    ])
  })

  it("keeps hidden and collapsed panes out of the available tracks", () => {
    const result = solveSplitLayout({
      containerSize: 800,
      panes: [
        { id: "hidden", visible: false, collapsedSizePx: 80 },
        { id: "center", defaultSize: 100 },
      ],
      separatorSizes: [0],
    })
    expect(result.sizes[0]).toBe(0)
    expect(result.sizes[1]).toBe(800)
  })

  it("keeps collapsed panes at zero while preserving the other track", () => {
    const result = solveSplitLayout({
      containerSize: 800,
      panes: [
        { id: "sidebar", collapsed: true, defaultSize: 25 },
        { id: "center", defaultSize: 75, minSizePx: 420 },
      ],
      separatorSizes: [0],
    })
    expect(result.sizes[0]).toBe(0)
    expect(result.sizes[1]).toBe(800)
  })
})

describe("split gesture session", () => {
  it("coalesces pointer moves and commits the latest frame once", () => {
    const nextFrames: FrameRequestCallback[] = []
    const cancelFrame = vi.fn()
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const session = createSplitGestureSession({
      initialSizes: [400, 598],
      bounds: bounds(200, 700),
      handleIndex: 0,
      startPosition: 400,
      onPreview,
      onCommit,
      onCancel: vi.fn(),
      requestAnimationFrame: (callback) => {
        nextFrames.push(callback)
        return 1
      },
      cancelAnimationFrame: cancelFrame,
    })

    session.move(420)
    session.move(450)
    expect(nextFrames).toHaveLength(1)
    expect(onPreview).not.toHaveBeenCalled()
    nextFrames[0]?.(0)
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenLastCalledWith([450, 548])

    session.move(430)
    session.commit()
    expect(cancelFrame).toHaveBeenCalled()
    expect(onPreview).toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenLastCalledWith([430, 568])
  })

  it("cancels a pending frame without preview or commit", () => {
    const nextFrames: FrameRequestCallback[] = []
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const session = createSplitGestureSession({
      initialSizes: [400, 598],
      bounds: bounds(200, 700),
      handleIndex: 0,
      startPosition: 400,
      onPreview,
      onCommit,
      onCancel,
      requestAnimationFrame: (callback) => {
        nextFrames.push(callback)
        return 1
      },
    })

    session.move(500)
    session.cancel()
    nextFrames[0]?.(0)

    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
