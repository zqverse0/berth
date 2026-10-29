import { afterEach, describe, expect, it, vi } from "vitest"
import type { TerminalSnapshot } from "./terminal-stream"
import {
  createTerminalSnapshotPainter,
  type SnapshotPainterTerminal,
} from "./terminal-snapshot-painter"

import type { TerminalWriteAdapter } from "./terminal-write-adapter"

function makeSnapshot(
  sequence: number,
  backendInstanceId = "b1"
): TerminalSnapshot {
  return {
    terminalId: "t1",
    backendInstanceId,
    sequence,
    rows: 24,
    cols: 80,
    ansi: new TextEncoder().encode(`snapshot-${sequence}`),
    historyTruncated: false,
    status: "running",
    exitCode: null,
    exitedAt: null,
    lastKnownCwd: null,
  }
}

function makeTerminal(): SnapshotPainterTerminal & {
  operations: string[]
  setAfterWrite: (baseY: number) => void
} {
  let viewportY = 3
  let baseY = 10
  const operations: string[] = []
  const term: SnapshotPainterTerminal & {
    operations: string[]
    setAfterWrite: (baseY: number) => void
  } = {
    buffer: {
      active: {
        type: "normal",
        get viewportY() {
          return viewportY
        },
        get baseY() {
          return baseY
        },
      },
    },
    reset: vi.fn(() => {
      operations.push("reset")
    }),
    resize: vi.fn((cols: number, rows: number) => {
      operations.push(`resize:${cols}x${rows}`)
    }),
    scrollToLine: vi.fn((line: number) => {
      operations.push(`scroll:${line}`)
      viewportY = line
    }),
    scrollToBottom: vi.fn(() => {
      operations.push("scroll:bottom")
      viewportY = baseY
    }),
    operations,
    setAfterWrite(nextBaseY: number) {
      baseY = nextBaseY
      viewportY = nextBaseY
    },
  }
  return term
}

function makeWriter(writes: string[]) {
  const callbacks: Array<() => void> = []
  const fences: Array<() => void> = []
  const writer: TerminalWriteAdapter = {
    write(data, callback) {
      writes.push(
        typeof data === "string" ? data : new TextDecoder().decode(data)
      )
      callbacks.push(callback ?? (() => {}))
    },
    fence(callback) {
      fences.push(callback)
    },
    dispose: vi.fn(),
  }
  return { writer, callbacks, fences }
}

describe("createTerminalSnapshotPainter", () => {
  afterEach(() => vi.useRealTimers())

  it("pauses live output and paints the latest queued snapshot", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const ready = vi.fn()
    const painter = createTerminalSnapshotPainter(term, writer, {
      onSnapshotReady: ready,
    })

    const first = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })
    const resize = painter.paintSnapshot(makeSnapshot(2), {
      sourceGeneration: 1,
    })
    const latest = painter.paintSnapshot(makeSnapshot(3), {
      sourceGeneration: 1,
    })

    expect(fences).toHaveLength(1)
    fences.shift()?.()
    await Promise.resolve()

    painter.writeLive("live-after-snapshot")
    expect(writes).toEqual(["snapshot-3"])

    callbacks.shift()?.()
    term.setAfterWrite(20)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.all([first, resize, latest])

    expect(term.reset).toHaveBeenCalledOnce()
    expect(term.resize).toHaveBeenCalledWith(80, 24)
    expect(term.scrollToLine).toHaveBeenCalledWith(13)
    expect(ready).toHaveBeenCalledWith(makeSnapshot(3), 1)
    expect(writes).toEqual(["snapshot-3", "live-after-snapshot"])
    expect(term.operations).toEqual(["resize:80x24", "reset", "scroll:13"])
    painter.dispose()
  })

  it("replays snapshot bytes unchanged after reset (the host appends the app's modes)", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)
    const painted = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })
    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await painted

    expect(writes).toEqual(["snapshot-1"])
    expect(term.reset).toHaveBeenCalledOnce()
    painter.dispose()
  })

  it("adopts snapshot geometry before replaying ANSI so attach cursor coordinates stay aligned", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)
    const snapshot = { ...makeSnapshot(1), cols: 132, rows: 41 }

    const paint = painter.paintSnapshot(snapshot, { sourceGeneration: 1 })
    fences.shift()?.()
    await Promise.resolve()
    expect(term.operations.slice(0, 2)).toEqual(["resize:132x41", "reset"])
    callbacks.shift()?.()
    await paint

    painter.dispose()
  })

  it("does not release a snapshot transaction between queued paints", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const starts: string[] = []
    const painter = createTerminalSnapshotPainter(term, writer, {
      onSnapshotStart: () => starts.push("start"),
      onSnapshotReady: (snapshot) => {
        starts.push(`ready:${snapshot.sequence}`)
      },
    })

    const first = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })
    fences.shift()?.()
    await Promise.resolve()
    const second = painter.paintSnapshot(makeSnapshot(2), {
      sourceGeneration: 1,
    })
    painter.writeLive("between")
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(starts).toEqual(["start", "ready:2"])
    await Promise.all([first, second])
    expect(writes).toEqual(["snapshot-1", "snapshot-2", "between"])
    painter.dispose()
  })

  it("does not let a late stale resize snapshot roll back newer content", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)

    const current = painter.paintSnapshot(makeSnapshot(2), {
      sourceGeneration: 1,
    })
    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await Promise.resolve()
    await current

    const staleResize = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })
    await staleResize

    expect(writes).toEqual(["snapshot-2"])
    expect(term.resize).toHaveBeenCalledWith(80, 24)
    painter.dispose()
  })

  it("does not repaint the same snapshot when resize response and state update race", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)

    const resized = painter.paintSnapshot(makeSnapshot(2), {
      sourceGeneration: 1,
    })
    const duplicate = painter.paintSnapshot(makeSnapshot(2), {
      sourceGeneration: 1,
    })

    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.all([resized, duplicate])

    expect(term.reset).toHaveBeenCalledOnce()
    expect(term.resize).toHaveBeenCalledWith(80, 24)
    expect(writes).toEqual(["snapshot-2"])
    painter.dispose()
  })

  it("repaints a same-sequence snapshot when its geometry or bytes changed", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)

    const first = painter.paintSnapshot(makeSnapshot(2), {
      sourceGeneration: 1,
    })
    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await first

    const changed = {
      ...makeSnapshot(2),
      cols: 100,
      ansi: new TextEncoder().encode("snapshot-2-resized"),
    }
    const second = painter.paintSnapshot(changed, { sourceGeneration: 1 })
    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await second

    expect(term.reset).toHaveBeenCalledTimes(2)
    expect(writes).toEqual(["snapshot-2", "snapshot-2-resized"])
    painter.dispose()
  })

  it("keeps a newer queued snapshot when an older response arrives", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)

    const current = painter.paintSnapshot(makeSnapshot(3), {
      sourceGeneration: 1,
    })
    const newerSnapshot = painter.paintSnapshot(makeSnapshot(4), {
      sourceGeneration: 1,
    })
    const olderSnapshot = painter.paintSnapshot(makeSnapshot(2), {
      sourceGeneration: 1,
    })

    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.all([current, newerSnapshot, olderSnapshot])

    expect(term.resize).toHaveBeenCalledWith(80, 24)
    expect(writes).toEqual(["snapshot-4"])
    painter.dispose()
  })

  it("bounds live output retained during a snapshot and requests resync", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const overflow = vi.fn()
    const applied = vi.fn()
    const painter = createTerminalSnapshotPainter(term, writer, {
      maxLiveBytes: 3,
      onLiveOverflow: overflow,
    })

    const painted = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })
    fences.shift()?.()
    await Promise.resolve()
    painter.writeLive("overflow", applied)
    callbacks.shift()?.()
    await painted

    expect(overflow).toHaveBeenCalledOnce()
    expect(applied).toHaveBeenCalledOnce()
    expect(writes).toEqual(["snapshot-1"])
    painter.dispose()
  })

  it("drops queued live output when the painted source is rejected", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const rejected = vi.fn(() => false)
    const applied = vi.fn()
    const painter = createTerminalSnapshotPainter(term, writer, {
      onSnapshotReady: rejected,
    })

    const painted = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })
    fences.shift()?.()
    await Promise.resolve()
    painter.writeLive("stale-live", applied)
    callbacks.shift()?.()
    await painted

    expect(rejected).toHaveBeenCalledOnce()
    expect(applied).toHaveBeenCalledOnce()
    expect(writes).toEqual(["snapshot-1"])
    painter.dispose()
  })

  it("orders snapshots by attachment generation before backend or sequence", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)

    const current = painter.paintSnapshot(makeSnapshot(2, "new"), {
      sourceGeneration: 2,
    })
    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await current

    const stale = painter.paintSnapshot(makeSnapshot(99, "new"), {
      sourceGeneration: 1,
    })
    await stale
    const staleBackend = painter.paintSnapshot(makeSnapshot(100, "old"), {
      sourceGeneration: 1,
    })
    await staleBackend

    expect(writes).toEqual(["snapshot-2"])
    expect(term.resize).toHaveBeenCalledWith(80, 24)
    painter.dispose()
  })

  it("coalesces continuous live output and settles callbacks in FIFO order", async () => {
    vi.useFakeTimers()
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks } = makeWriter(writes)
    const applied: string[] = []
    const painter = createTerminalSnapshotPainter(term, writer, {
      isVisible: () => true,
    })
    const large = "A".repeat(3_000)

    painter.writeLive(large, () => applied.push("large"))
    painter.writeLive("echo", () => applied.push("echo"))

    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(16)
    expect(writes).toEqual([`${large}echo`])

    callbacks.shift()?.()
    await Promise.resolve()

    expect(applied).toEqual(["large", "echo"])
    painter.dispose()
  })

  it("drains visible output with a timer while the page is hidden", async () => {
    vi.useFakeTimers()
    // 窗口最小化：document.hidden 为真，rAF 永不触发。
    vi.stubGlobal("requestAnimationFrame", () => 0)
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    })
    try {
      const writes: string[] = []
      const { writer } = makeWriter(writes)
      const painter = createTerminalSnapshotPainter(makeTerminal(), writer, {
        isVisible: () => true,
      })

      painter.writeLive("agent output")
      await vi.advanceTimersByTimeAsync(100)

      expect(writes).toEqual(["agent output"])
      painter.dispose()
    } finally {
      delete (document as { hidden?: boolean }).hidden
      vi.unstubAllGlobals()
    }
  })

  it("does not coalesce live output across the visible byte budget", async () => {
    vi.useFakeTimers()
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer, {
      isVisible: () => true,
    })
    const first = "A".repeat(64 * 1024)

    painter.writeLive(first)
    painter.writeLive("tail")

    await vi.advanceTimersByTimeAsync(16)
    expect(writes).toEqual([first])

    callbacks.shift()?.()
    await vi.advanceTimersByTimeAsync(16)
    expect(writes).toEqual([first, "tail"])

    callbacks.shift()?.()
    await Promise.resolve()
    painter.dispose()
  })

  it("keeps queued output ahead of a snapshot fence", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer, {
      isVisible: () => true,
    })

    painter.writeLive("before-snapshot")
    const painted = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })

    expect(writes).toEqual(["before-snapshot"])
    expect(fences).toHaveLength(0)
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fences).toHaveLength(1)
    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await painted

    expect(writes).toEqual(["before-snapshot", "snapshot-1"])
    painter.dispose()
  })

  it("bounds hidden output, acknowledges dropped batches, and marks the surface dirty", () => {
    let visible = false
    const term = makeTerminal()
    const writes: string[] = []
    const { writer } = makeWriter(writes)
    const overflow = vi.fn()
    const firstApplied = vi.fn()
    const secondApplied = vi.fn()
    const painter = createTerminalSnapshotPainter(term, writer, {
      isVisible: () => visible,
      maxLiveBytes: 5,
      onHiddenLiveOverflow: overflow,
    })

    painter.writeLive("1234", firstApplied)
    painter.writeLive("56", secondApplied)

    expect(writes).toEqual([])
    expect(firstApplied).toHaveBeenCalledOnce()
    expect(secondApplied).toHaveBeenCalledOnce()
    expect(overflow).toHaveBeenCalledWith(0, 6)

    visible = true
    painter.dispose()
  })

  it("applies local preview geometry without entering the backend fence", () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)

    painter.requestLocalResize({ cols: 100, rows: 30 })

    expect(fences).toHaveLength(0)
    expect(writes).toEqual([])
    expect(term.operations).toEqual(["resize:100x30", "scroll:3"])
    painter.dispose()
  })

  it("keeps a normal-screen bottom viewport pinned during local preview", () => {
    const term = makeTerminal()
    term.scrollToBottom()
    term.operations.length = 0
    const { writer } = makeWriter([])
    const painter = createTerminalSnapshotPainter(term, writer)

    painter.requestLocalResize({ cols: 100, rows: 30 })

    expect(term.operations).toEqual(["resize:100x30", "scroll:bottom"])
    painter.dispose()
  })

  it("defers local preview resize while a snapshot fence is active", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    const painter = createTerminalSnapshotPainter(term, writer)

    const painted = painter.paintSnapshot(makeSnapshot(1), {
      sourceGeneration: 1,
    })
    painter.requestLocalResize({ cols: 100, rows: 30 })

    expect(term.operations).toEqual([])
    fences.shift()?.()
    await Promise.resolve()
    callbacks.shift()?.()
    await painted

    expect(term.operations).toContain("resize:100x30")
    expect(term.operations.indexOf("resize:80x24")).toBeLessThan(
      term.operations.indexOf("resize:100x30")
    )
    painter.dispose()
  })

  it("does not restore a history viewport for alternate-screen applications", () => {
    const term = makeTerminal()
    term.buffer.active.type = "alternate"
    const { writer } = makeWriter([])
    const painter = createTerminalSnapshotPainter(term, writer)

    painter.requestLocalResize({ cols: 100, rows: 30 })

    expect(term.operations).toEqual(["resize:100x30"])
    expect(term.scrollToLine).not.toHaveBeenCalled()
    expect(term.scrollToBottom).not.toHaveBeenCalled()
    painter.dispose()
  })

  it("defers local resize until an in-flight live write completes", async () => {
    const term = makeTerminal()
    const { writer, callbacks } = makeWriter([])
    const painter = createTerminalSnapshotPainter(term, writer, {
      isVisible: () => true,
    })

    painter.markUserInput()
    painter.writeLive("echo")
    painter.requestLocalResize({ cols: 100, rows: 30 })

    expect(term.operations).toEqual([])
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(term.operations).toEqual(["resize:100x30", "scroll:3"])
    painter.dispose()
  })

  it("lets an authoritative resize supersede deferred preview geometry", async () => {
    const term = makeTerminal()
    const { writer, fences } = makeWriter([])
    let release!: (applied: boolean) => void
    const backend = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const painter = createTerminalSnapshotPainter(term, writer)

    const resized = painter.resizeTerminal(
      { cols: 100, rows: 30 },
      () => backend
    )
    painter.requestLocalResize({ cols: 99, rows: 30 })

    fences.shift()?.()
    await Promise.resolve()
    release(true)
    await resized

    expect(term.operations).toContain("resize:100x30")
    expect(term.operations).not.toContain("resize:99x30")
    painter.dispose()
  })

  it("applies confirmed geometry without resetting or replaying the screen", async () => {
    const term = makeTerminal()
    const writes: string[] = []
    const { writer, callbacks, fences } = makeWriter(writes)
    let release!: (applied: boolean) => void
    const backend = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const painter = createTerminalSnapshotPainter(term, writer)

    const resized = painter.resizeTerminal(
      { cols: 100, rows: 30 },
      () => backend
    )
    painter.writeLive("during-resize")

    expect(fences).toHaveLength(1)
    expect(writes).toEqual([])
    fences.shift()?.()
    await Promise.resolve()
    release(true)
    await resized

    expect(term.reset).not.toHaveBeenCalled()
    expect(term.resize).toHaveBeenCalledWith(100, 30)
    expect(writes).toEqual(["during-resize"])
    expect(callbacks).toHaveLength(1)
    painter.dispose()
  })
})
