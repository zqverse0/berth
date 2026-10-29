import type { TerminalSnapshot } from "./terminal-stream"
import {
  invokeTerminalWriteCallback,
  type TerminalWriteAdapter,
} from "./terminal-write-adapter"

export interface SnapshotPaintSize {
  cols: number
  rows: number
}

export interface SnapshotPaintOptions {
  /**
   * Monotonic UI-side attachment generation. Sequence numbers are only
   * comparable within one generation; a reconnect can legitimately reset or
   * reuse the backend sequence space.
   */
  sourceGeneration: number
}

export interface SnapshotPainterTerminal {
  /** Current xterm grid when the terminal implementation exposes it. */
  cols?: number
  rows?: number
  reset: () => void
  resize: (cols: number, rows: number) => void
  scrollToLine: (line: number) => void
  scrollToBottom: () => void
  buffer: {
    active: {
      type: "normal" | "alternate"
      viewportY: number
      baseY: number
    }
  }
}

export interface TerminalSnapshotPainterHooks {
  /** Called once before a batch of snapshot paints begins. */
  onSnapshotStart?: (sourceGeneration: number) => void
  /** Called once after the newest snapshot has been painted, while paused. */
  onSnapshotReady?: (
    snapshot: TerminalSnapshot,
    sourceGeneration: number
  ) => boolean | void
  /** A bounded live-output gate overflowed and needs an authoritative resync. */
  onLiveOverflow?: (sourceGeneration: number) => void
  /** Hidden-surface output was dropped and must be recovered when visible. */
  onHiddenLiveOverflow?: (
    sourceGeneration: number,
    droppedBytes: number
  ) => void
  /** Whether live output currently has a paintable surface. */
  isVisible?: () => boolean
  /** Maximum live bytes retained by the bounded frontend queue. */
  maxLiveBytes?: number
  /**
   * 一次 xterm `term.resize()` 的同步耗时(reflow 主体)。拖动 preview
   * 与松手 commit 共用该路径;供性能指标区分两侧量级。
   */
  onTermResizeLatency?: (durationMs: number, cols: number, rows: number) => void
  /**
   * 权威 reflow(commit) 的开始/结束。reflow 内部 xterm 会触发多轮
   * scroll 事件;同步滚动条/DOM 高度应在此窗口内暂停,结束后按终态
   * 同步一次,避免中间态逐帧渲染(视觉闪烁)。
   */
  onTermReflowStart?: () => void
  onTermReflowEnd?: () => void
}

export interface TerminalSnapshotPainter {
  writeLive: (data: string | Uint8Array, callback?: () => void) => void
  /** Mark the next small visible output batch as user-interactive. */
  markUserInput: () => void
  /**
   * Apply a visual-only grid change. It never calls the backend and is held
   * until a snapshot/authoritative resize fence is idle.
   */
  requestLocalResize: (nextSize: SnapshotPaintSize) => void
  /**
   * Apply a backend-confirmed geometry change without replaying the screen.
   * Ordinary layout changes must not reset xterm: reset is reserved for an
   * authoritative snapshot/resync, otherwise selection and scroll state are
   * destroyed by a resize storm.
   */
  resizeTerminal: (
    nextSize: SnapshotPaintSize,
    apply: () => Promise<boolean>
  ) => Promise<boolean>
  paintSnapshot: (
    snapshot: TerminalSnapshot,
    options: SnapshotPaintOptions
  ) => Promise<void>
  dispose: () => void
}

interface PendingSnapshot {
  snapshot: TerminalSnapshot
  sourceGeneration: number
  waiters: Array<() => void>
}

interface QueuedLiveWrite {
  data: string | Uint8Array
  callback?: () => void
  receivedAt: number
  interactionHint: boolean
  order: number
}

interface PendingResize {
  nextSize: SnapshotPaintSize
  apply: () => Promise<boolean>
  waiters: Array<(applied: boolean) => void>
}

/**
 * Owns the only transition from live output to an authoritative snapshot or
 * confirmed geometry. A snapshot adopts its encoded grid before replay; an
 * ordinary layout resize remains a separate operation so it cannot reset the
 * user's screen.
 *
 * Live bytes and snapshot bytes are passed to xterm unchanged; the host
 * appends the modes the app has enabled (alternate screen, mouse, paste,
 * cursor keys) to the snapshot, so `reset()` + replay restores them. While
 * a snapshot transaction is active, live output is held so
 * reset/resize/replay cannot be interleaved with another stream.
 */

export function createTerminalSnapshotPainter(
  term: SnapshotPainterTerminal,
  writer: TerminalWriteAdapter,
  hooks: TerminalSnapshotPainterHooks = {}
): TerminalSnapshotPainter {
  let disposed = false
  let painting = false
  let pumpRunning = false
  let pending: PendingSnapshot | null = null
  let pendingResize: PendingResize | null = null
  let activeSnapshot: TerminalSnapshot | null = null
  let activeSourceGeneration: number | null = null
  let activeWaiters: Array<() => void> = []
  let latestSnapshot: TerminalSnapshot | null = null
  let latestSourceGeneration: number | null = null
  let liveWrites: QueuedLiveWrite[] = []
  let liveWriteBytes = 0
  let liveOverflowed = false
  let pendingLocalResize: SnapshotPaintSize | null = null
  let currentGrid: SnapshotPaintSize | null =
    typeof term.cols === "number" && typeof term.rows === "number"
      ? { cols: term.cols, rows: term.rows }
      : null
  let nextLiveOrder = 0
  let liveDrainRunning = false
  let liveDrainPromise: Promise<void> | null = null
  let liveDrainFrame: ReturnType<typeof requestAnimationFrame> | null = null
  let liveDrainTimer: ReturnType<typeof setTimeout> | null = null
  let interactionHintUntil = 0
  let activeFenceResolve: (() => void) | null = null
  let activeWriteResolve: (() => void) | null = null
  const maxLiveBytes = Math.max(1, hooks.maxLiveBytes ?? 2 * 1024 * 1024)
  const textEncoder = new TextEncoder()

  const byteLengthOf = (data: string | Uint8Array): number =>
    typeof data === "string"
      ? textEncoder.encode(data).byteLength
      : data.byteLength

  const sameGrid = (left: SnapshotPaintSize, right: SnapshotPaintSize) =>
    left.cols === right.cols && left.rows === right.rows

  /** reflow 窗口内 view 侧暂停 scroll 同步,结束后同步终态一次。 */
  const resizeTermIfNeeded = (nextSize: SnapshotPaintSize): boolean => {
    if (currentGrid && sameGrid(currentGrid, nextSize)) return false
    hooks.onTermReflowStart?.()
    const startedAt = performance.now()
    term.resize(nextSize.cols, nextSize.rows)
    if (hooks.onTermResizeLatency) {
      hooks.onTermResizeLatency(
        performance.now() - startedAt,
        nextSize.cols,
        nextSize.rows
      )
    }
    hooks.onTermReflowEnd?.()
    currentGrid = { ...nextSize }
    return true
  }

  const resolveActiveWait = () => {
    activeFenceResolve?.()
    activeWriteResolve?.()
    activeFenceResolve = null
    activeWriteResolve = null
  }

  const captureViewport = () => {
    const buffer = term.buffer.active
    return {
      preserve: buffer.type !== "alternate" && buffer.viewportY < buffer.baseY,
      offsetFromBottom: buffer.baseY - buffer.viewportY,
    }
  }

  const waitForFence = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (activeFenceResolve === finish) activeFenceResolve = null
        resolve()
      }
      activeFenceResolve = finish
      writer.fence(finish)
    })
  }

  const waitForWrite = (data: Uint8Array): Promise<void> => {
    if (disposed || data.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (activeWriteResolve === finish) activeWriteResolve = null
        resolve()
      }
      activeWriteResolve = finish
      writer.write(data, finish)
    })
  }

  const useLiveScheduler = typeof hooks.isVisible === "function"
  const LIVE_INTERACTION_BYTES = 2 * 1024
  const VISIBLE_DRAIN_BYTES = 64 * 1024
  const VISIBLE_DRAIN_MS = 8
  const HIDDEN_DRAIN_BYTES = 16 * 1024
  const HIDDEN_DRAIN_MS = 4
  const HIDDEN_DRAIN_DELAY_MS = 32

  const currentSourceGeneration = (): number =>
    activeSourceGeneration ??
    pending?.sourceGeneration ??
    latestSourceGeneration ??
    0

  const clearLiveDrainSchedule = () => {
    if (liveDrainFrame !== null) {
      cancelAnimationFrame(liveDrainFrame)
      liveDrainFrame = null
    }
    if (liveDrainTimer !== null) {
      clearTimeout(liveDrainTimer)
      liveDrainTimer = null
    }
  }

  const mergeQueuedLiveData = (
    items: QueuedLiveWrite[]
  ): string | Uint8Array => {
    if (items.length === 1) {
      return items[0]?.data ?? new Uint8Array()
    }

    // Live output arrives as independent transport chunks, but xterm's
    // parser only needs one ordered byte stream. Encode strings separately so
    // a UTF-16 surrogate split across chunks cannot change the bytes that were
    // originally handed to the writer when chunks are coalesced.
    const encoded = items.map((item) =>
      typeof item.data === "string" ? textEncoder.encode(item.data) : item.data
    )
    const merged = new Uint8Array(
      encoded.reduce((total, data) => total + data.byteLength, 0)
    )
    let offset = 0
    for (const data of encoded) {
      merged.set(data, offset)
      offset += data.byteLength
    }
    return merged
  }

  const writeQueuedLive = (items: QueuedLiveWrite[]): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        // One xterm callback covers the merged byte stream. Preserve the
        // transport callback contract by settling every source chunk in FIFO
        // order only after that write has been consumed.
        for (const item of items) {
          invokeTerminalWriteCallback(item.callback)
        }
        resolve()
      }
      try {
        writer.write(mergeQueuedLiveData(items), finish)
      } catch (error) {
        // A target failure must not strand the FIFO behind one bad batch. The
        // batch was not accepted by xterm, so its application ACK is omitted.
        console.error("[TerminalSnapshotPainter] live write failed", error)
        resolve()
      }
    })

  const takeLiveBatch = (
    maxBytes: number,
    maxDurationMs: number,
    cutoffOrder?: number
  ): QueuedLiveWrite[] => {
    const startedAt = performance.now()
    let batchBytes = 0
    const batch: QueuedLiveWrite[] = []
    while (liveWrites.length > 0) {
      const item = liveWrites[0]
      if (!item || (cutoffOrder !== undefined && item.order > cutoffOrder)) {
        break
      }
      const itemBytes = byteLengthOf(item.data)
      // Keep the first item even when it is larger than the normal budget; it
      // is already permitted by the previous one-item drain behavior. This
      // also guarantees forward progress for a single large PTY chunk.
      if (
        batch.length > 0 &&
        (batchBytes + itemBytes > maxBytes ||
          performance.now() - startedAt >= maxDurationMs)
      ) {
        break
      }
      liveWrites.shift()
      liveWriteBytes = Math.max(0, liveWriteBytes - itemBytes)
      batch.push(item)
      batchBytes += itemBytes
      if (
        batchBytes >= maxBytes ||
        performance.now() - startedAt >= maxDurationMs
      ) {
        break
      }
    }
    return batch
  }

  const drainLiveWrites = async (
    maxBytes: number,
    maxDurationMs: number
  ): Promise<void> => {
    const startedAt = performance.now()
    let drainedBytes = 0
    while (!disposed && !painting && liveWrites.length > 0) {
      const batch = takeLiveBatch(
        Math.max(1, maxBytes - drainedBytes),
        Math.max(0, maxDurationMs - (performance.now() - startedAt))
      )
      if (batch.length === 0) break
      const bytes = batch.reduce(
        (total, item) => total + byteLengthOf(item.data),
        0
      )
      await writeQueuedLive(batch)
      drainedBytes += bytes
      if (
        drainedBytes >= maxBytes ||
        performance.now() - startedAt >= maxDurationMs
      ) {
        break
      }
    }
  }

  const hasLiveWritesThrough = (cutoffOrder: number): boolean =>
    liveDrainPromise !== null ||
    (liveWrites[0]?.order !== undefined && liveWrites[0].order <= cutoffOrder)

  const drainLiveWritesThrough = async (cutoffOrder: number) => {
    if (liveDrainPromise) await liveDrainPromise
    while (!disposed && liveWrites.length > 0) {
      const batch = takeLiveBatch(
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        cutoffOrder
      )
      if (batch.length === 0) break
      await writeQueuedLive(batch)
    }
  }

  const startLiveDrain = () => {
    if (
      !useLiveScheduler ||
      disposed ||
      painting ||
      liveDrainRunning ||
      liveWrites.length === 0
    ) {
      return
    }
    liveDrainRunning = true
    const visible = hooks.isVisible?.() ?? true
    const drain = drainLiveWrites(
      visible ? VISIBLE_DRAIN_BYTES : HIDDEN_DRAIN_BYTES,
      visible ? VISIBLE_DRAIN_MS : HIDDEN_DRAIN_MS
    )
    liveDrainPromise = drain
    void drain.then(
      () => {
        if (liveDrainPromise === drain) liveDrainPromise = null
        liveDrainRunning = false
        flushPendingLocalResize()
        if (!disposed && !painting && liveWrites.length > 0) {
          scheduleLiveDrain()
        }
      },
      (error) => {
        console.error("[TerminalSnapshotPainter] live drain failed", error)
        if (liveDrainPromise === drain) liveDrainPromise = null
        liveDrainRunning = false
        flushPendingLocalResize()
        if (!disposed && !painting && liveWrites.length > 0) {
          scheduleLiveDrain()
        }
      }
    )
  }

  function scheduleLiveDrain(): void {
    if (
      !useLiveScheduler ||
      disposed ||
      painting ||
      liveDrainRunning ||
      liveWrites.length === 0
    ) {
      return
    }
    const visible = hooks.isVisible?.() ?? true
    const head = liveWrites[0]
    if (
      visible &&
      head?.interactionHint &&
      performance.now() - head.receivedAt <= 100
    ) {
      startLiveDrain()
      return
    }
    // 窗口最小化时 WebKitGTK 不派发 rAF：改走定时器，队列才不会堆到溢出去 resync。
    if (visible && !document.hidden) {
      if (liveDrainFrame !== null) return
      liveDrainFrame = requestAnimationFrame(() => {
        liveDrainFrame = null
        startLiveDrain()
      })
      return
    }
    if (liveDrainTimer !== null) return
    liveDrainTimer = setTimeout(() => {
      liveDrainTimer = null
      startLiveDrain()
    }, HIDDEN_DRAIN_DELAY_MS)
  }

  const flushLiveWrites = () => {
    if (useLiveScheduler) {
      scheduleLiveDrain()
      return
    }
    const queued = liveWrites
    liveWrites = []
    liveWriteBytes = 0
    for (const item of queued) writer.write(item.data, item.callback)
  }

  const dropLiveWrites = (): number => {
    const dropped = liveWrites
    liveWrites = []
    liveWriteBytes = 0
    let droppedBytes = 0
    for (const item of dropped) {
      droppedBytes += byteLengthOf(item.data)
      invokeTerminalWriteCallback(item.callback)
    }
    return droppedBytes
  }

  const enqueueLiveWrite = (
    data: string | Uint8Array,
    callback?: () => void
  ): void => {
    if (liveOverflowed) {
      invokeTerminalWriteCallback(callback)
      return
    }
    const bytes = byteLengthOf(data)
    if (liveWriteBytes + bytes > maxLiveBytes) {
      clearLiveDrainSchedule()
      const droppedBytes = dropLiveWrites() + bytes
      liveOverflowed = true
      try {
        if (hooks.isVisible?.() === false) {
          hooks.onHiddenLiveOverflow?.(currentSourceGeneration(), droppedBytes)
        } else {
          hooks.onLiveOverflow?.(currentSourceGeneration())
        }
      } catch (error) {
        console.error("[TerminalSnapshotPainter] overflow hook failed", error)
      }
      invokeTerminalWriteCallback(callback)
      return
    }
    nextLiveOrder += 1
    const receivedAt = performance.now()
    liveWrites.push({
      data,
      callback,
      receivedAt,
      interactionHint:
        bytes <= LIVE_INTERACTION_BYTES && receivedAt <= interactionHintUntil,
      order: nextLiveOrder,
    })
    liveWriteBytes += bytes
    if (!painting) scheduleLiveDrain()
  }

  const applyLocalResize = (nextSize: SnapshotPaintSize): void => {
    if (disposed || nextSize.cols < 1 || nextSize.rows < 1) return
    const viewport = captureViewport()
    if (resizeTermIfNeeded(nextSize)) restoreViewport(viewport)
  }

  const flushPendingLocalResize = (): void => {
    if (
      painting ||
      liveDrainRunning ||
      liveDrainPromise !== null ||
      disposed ||
      !pendingLocalResize
    ) {
      return
    }
    const next = pendingLocalResize
    pendingLocalResize = null
    applyLocalResize(next)
  }

  const paintOne = async (request: PendingSnapshot): Promise<void> => {
    if (disposed) return

    activeSnapshot = request.snapshot
    activeSourceGeneration = request.sourceGeneration
    try {
      // Snapshot ANSI is encoded for the backend's authoritative grid. Replay
      // it only after xterm adopts that exact geometry; painting into xterm's
      // default/current grid and resizing afterward reflows rows independently
      // and leaves the visual cursor detached from the PTY cursor on attach.
      resizeTermIfNeeded({
        cols: request.snapshot.cols,
        rows: request.snapshot.rows,
      })
      term.reset()
      await waitForWrite(request.snapshot.ansi)
    } finally {
      activeSnapshot = null
      activeSourceGeneration = null
      if (!disposed) latestSnapshot = request.snapshot
      if (!disposed) latestSourceGeneration = request.sourceGeneration
    }
  }

  const snapshotsEqual = (
    left: TerminalSnapshot,
    right: TerminalSnapshot
  ): boolean => {
    if (
      left.sequence !== right.sequence ||
      left.rows !== right.rows ||
      left.cols !== right.cols ||
      left.historyTruncated !== right.historyTruncated ||
      left.status !== right.status ||
      left.exitCode !== right.exitCode ||
      left.exitedAt !== right.exitedAt ||
      left.lastKnownCwd !== right.lastKnownCwd ||
      left.terminalId !== right.terminalId ||
      left.backendInstanceId !== right.backendInstanceId ||
      left.ansi.byteLength !== right.ansi.byteLength
    ) {
      return false
    }
    for (let index = 0; index < left.ansi.byteLength; index += 1) {
      if (left.ansi[index] !== right.ansi[index]) return false
    }
    return true
  }

  const compareSnapshots = (
    left: PendingSnapshot,
    right: PendingSnapshot | null
  ): number => {
    if (!right) return 1
    if (left.sourceGeneration !== right.sourceGeneration) {
      return left.sourceGeneration - right.sourceGeneration
    }
    if (left.snapshot.sequence !== right.snapshot.sequence) {
      return left.snapshot.sequence - right.snapshot.sequence
    }
    return snapshotsEqual(left.snapshot, right.snapshot) ? 0 : 1
  }

  const restoreViewport = (viewport: ReturnType<typeof captureViewport>) => {
    if (disposed || term.buffer.active.type === "alternate") return
    if (viewport.preserve) {
      const nextBaseY = term.buffer.active.baseY
      term.scrollToLine(Math.max(0, nextBaseY - viewport.offsetFromBottom))
    } else {
      term.scrollToBottom()
    }
  }

  const paintSnapshotBatch = async (
    completed: Array<() => void>,
    liveCutoff: number | null
  ): Promise<void> => {
    let lastSnapshot: TerminalSnapshot | null = null
    let lastSourceGeneration: number | null = null

    hooks.onSnapshotStart?.(pending?.sourceGeneration ?? 0)
    const viewport = captureViewport()
    if (liveCutoff !== null && hasLiveWritesThrough(liveCutoff)) {
      await drainLiveWritesThrough(liveCutoff)
    }
    await waitForFence()
    while (!disposed && pending) {
      const request = pending
      pending = null
      completed.push(...request.waiters)
      await paintOne(request)
      lastSnapshot = request.snapshot
      lastSourceGeneration = request.sourceGeneration
    }

    if (!disposed && lastSnapshot) {
      restoreViewport(viewport)
      const accepted = hooks.onSnapshotReady?.(
        lastSnapshot,
        lastSourceGeneration ?? 0
      )
      if (accepted === false) {
        // The runtime source changed while this transaction was painting,
        // or the runtime is intentionally waiting for a new attach.
        // Never flush bytes that belong to the rejected source.
        dropLiveWrites()
      }
    }
  }

  const resizeOne = async (
    request: PendingResize,
    completed: Array<() => void>
  ): Promise<void> => {
    const viewport = captureViewport()
    let applied = false
    try {
      // Keep live output behind the same ordered fence as snapshots. Output
      // produced while the backend handles SIGWINCH is replayed only after
      // xterm has adopted the confirmed geometry.
      await waitForFence()
      applied = await request.apply()
      if (applied && !disposed) {
        // 后端确认的网格必须覆盖 resize fence 期间排队的 preview 尺寸。
        pendingLocalResize = null
        if (resizeTermIfNeeded(request.nextSize)) restoreViewport(viewport)
      }
    } catch {
      applied = false
    } finally {
      for (const resolve of request.waiters) {
        completed.push(() => resolve(applied))
      }
    }
  }

  const pump = async () => {
    if (pumpRunning || disposed) return
    pumpRunning = true
    painting = true
    liveOverflowed = false
    const completed: Array<() => void> = []
    const liveCutoff = nextLiveOrder
    let barrierDrained = false
    try {
      while (!disposed && (pending || pendingResize)) {
        if (pending) {
          await paintSnapshotBatch(
            completed,
            barrierDrained ? null : liveCutoff
          )
          barrierDrained = true
        }
        if (pendingResize) {
          if (!barrierDrained) {
            if (hasLiveWritesThrough(liveCutoff)) {
              await drainLiveWritesThrough(liveCutoff)
            }
            barrierDrained = true
          }
          const request = pendingResize
          pendingResize = null
          await resizeOne(request, completed)
        }
      }
    } finally {
      painting = false
      completed.push(...activeWaiters)
      activeWaiters = []
      for (const resolve of completed) resolve()
      pumpRunning = false
      // Apply deferred local geometry before releasing queued live bytes. Both
      // operations are now outside the painter critical section, but the
      // preview grid still cannot be interleaved with a live drain.
      flushPendingLocalResize()
      if (!disposed) flushLiveWrites()

      // A request can arrive while the final hooks or live-write flush is
      // running. Start another transaction without dropping it.
      if (!disposed && (pending || pendingResize)) void pump()
    }
  }

  return {
    writeLive(data, callback) {
      if (disposed) return
      if (useLiveScheduler) {
        enqueueLiveWrite(data, callback)
        return
      }
      if (painting) {
        if (liveOverflowed) {
          invokeTerminalWriteCallback(callback)
          return
        }
        const bytes = byteLengthOf(data)
        if (liveWriteBytes + bytes > maxLiveBytes) {
          dropLiveWrites()
          liveOverflowed = true
          hooks.onLiveOverflow?.(currentSourceGeneration())
          invokeTerminalWriteCallback(callback)
          return
        }
        nextLiveOrder += 1
        liveWrites.push({
          data,
          callback,
          receivedAt: performance.now(),
          interactionHint: false,
          order: nextLiveOrder,
        })
        liveWriteBytes += bytes
        return
      }
      writer.write(data, callback)
    },

    markUserInput() {
      interactionHintUntil = performance.now() + 100
      if (
        useLiveScheduler &&
        !painting &&
        hooks.isVisible?.() !== false &&
        liveWrites.length > 0
      ) {
        clearLiveDrainSchedule()
        startLiveDrain()
      }
    },

    requestLocalResize(nextSize) {
      if (disposed || nextSize.cols < 1 || nextSize.rows < 1) return
      if (painting || liveDrainRunning || liveDrainPromise !== null) {
        pendingLocalResize = { ...nextSize }
        return
      }
      applyLocalResize(nextSize)
    },

    paintSnapshot(snapshot, options) {
      if (disposed) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const current = pending
          ? pending
          : activeSnapshot
            ? {
                snapshot: activeSnapshot,
                sourceGeneration:
                  activeSourceGeneration ?? options.sourceGeneration,
                waiters: [],
              }
            : latestSnapshot
              ? {
                  snapshot: latestSnapshot,
                  sourceGeneration:
                    latestSourceGeneration ?? options.sourceGeneration,
                  waiters: [],
                }
              : null
        const request = {
          snapshot,
          sourceGeneration: options.sourceGeneration,
          waiters: [] as Array<() => void>,
        }
        const comparison = current ? compareSnapshots(request, current) : 1
        if (current && comparison === 0) {
          if (pending) {
            pending.waiters.push(resolve)
          } else if (activeSnapshot) {
            activeWaiters.push(resolve)
          } else {
            resolve()
          }
          return
        }
        if (current && comparison < 0) {
          // Sequence numbers cannot establish ordering across generations.
          // A stale response must never roll back the newer attachment.
          resolve()
          return
        }
        pending = {
          snapshot,
          sourceGeneration: options.sourceGeneration,
          waiters: [...(pending?.waiters ?? []), resolve],
        }
        void pump()
      })
    },

    resizeTerminal(nextSize, apply) {
      if (disposed) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        const waiters = pendingResize?.waiters ?? []
        pendingResize = {
          nextSize,
          apply,
          waiters: [...waiters, resolve],
        }
        void pump()
      })
    },

    dispose() {
      if (disposed) return
      clearLiveDrainSchedule()
      dropLiveWrites()
      disposed = true
      resolveActiveWait()
      const waiters = [...(pending?.waiters ?? []), ...activeWaiters]
      const resizeWaiters = pendingResize?.waiters ?? []
      pending = null
      pendingResize = null
      activeWaiters = []
      pendingLocalResize = null
      for (const resolve of waiters) resolve()
      for (const resolve of resizeWaiters) resolve(false)
    },
  }
}
