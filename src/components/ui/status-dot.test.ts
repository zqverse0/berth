import { createElement } from "react"
import { act, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BusyRing, pickStatusDot, StatusDot } from "@/components/ui/status-dot"

describe("pickStatusDot", () => {
  it("shows the highest-priority state only", () => {
    expect(pickStatusDot("pinned", "working")).toBe("working")
    expect(pickStatusDot("new", "pinned")).toBe("new")
    expect(pickStatusDot("pinned", "attention", "new")).toBe("attention")
    expect(pickStatusDot(null, false, undefined)).toBeNull()
  })
})

describe("working dot slow blink", () => {
  afterEach(() => vi.useRealTimers())

  const dimmed = () => document.documentElement.dataset.slowBlink === "dim"

  it("toggles once a second only while a working dot is mounted", () => {
    vi.useFakeTimers()
    const idle = render(createElement(StatusDot, { kind: "new" }))
    act(() => vi.advanceTimersByTime(1_000))
    expect(dimmed()).toBe(false)

    const a = render(createElement(StatusDot, { kind: "working" }))
    const b = render(createElement(StatusDot, { kind: "working" }))
    act(() => vi.advanceTimersByTime(1_000))
    expect(dimmed()).toBe(true)
    act(() => vi.advanceTimersByTime(1_000))
    expect(dimmed()).toBe(false)
    act(() => vi.advanceTimersByTime(1_000))

    a.unmount()
    expect(dimmed()).toBe(true)
    b.unmount()
    // 最后一个卸载：停表并恢复不透明。
    expect(dimmed()).toBe(false)
    act(() => vi.advanceTimersByTime(3_000))
    expect(dimmed()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    idle.unmount()
  })

  it("busy ring blinks on the shared timer instead of a CSS spin", () => {
    vi.useFakeTimers()
    const dot = render(createElement(StatusDot, { kind: "working" }))
    const ring = render(createElement(BusyRing, { className: "h-3 w-3" }))
    expect(ring.container.querySelector(".animate-spin")).toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1_000))
    expect(dimmed()).toBe(true)

    dot.unmount()
    act(() => vi.advanceTimersByTime(1_000))
    expect(dimmed()).toBe(false)
    ring.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
