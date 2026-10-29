export interface TerminalGridSize {
  cols: number
  rows: number
}

export interface TerminalResizeCoordinator {
  /** Schedule a resize from an ordinary, potentially unstable observation. */
  request: () => void
  /** Schedule a resize whose current measurement is already layout-stable. */
  requestStable: () => void
  dispose: () => void
}

type ScheduledFrame = ReturnType<typeof requestAnimationFrame>

const MAX_STABILITY_FRAMES = 8

function sameGrid(a: TerminalGridSize, b: TerminalGridSize): boolean {
  return a.cols === b.cols && a.rows === b.rows
}

function isValidGrid(size: TerminalGridSize | null): size is TerminalGridSize {
  return Boolean(size && size.cols >= 1 && size.rows >= 1)
}

/**
 * Coalesces layout observations and serializes backend-authoritative resizes.
 * Measuring is deliberately separate from applying: `measure` must not mutate
 * xterm, while `apply` may wait for the backend to confirm the new geometry.
 */
export function createTerminalResizeCoordinator(options: {
  measure: () => TerminalGridSize | null
  apply: (size: TerminalGridSize) => Promise<void | boolean>
  onDuplicate?: (size: TerminalGridSize) => void
  onError?: (error: unknown) => void
}): TerminalResizeCoordinator {
  let disposed = false
  let applying = false
  let requestedWhileBusy = false
  let stableRequested = false
  let scheduled: ScheduledFrame | null = null
  let lastApplied: TerminalGridSize | null = null

  const cancelScheduled = (): void => {
    if (scheduled === null) return
    cancelAnimationFrame(scheduled)
    scheduled = null
  }

  const applyStableSize = async (size: TerminalGridSize): Promise<void> => {
    if (disposed) return
    if (applying) {
      requestedWhileBusy = true
      return
    }
    if (lastApplied && sameGrid(lastApplied, size)) {
      options.onDuplicate?.(size)
      return
    }

    applying = true
    try {
      const applied = await options.apply(size)
      if (!disposed && applied !== false) lastApplied = size
    } finally {
      applying = false
      if (requestedWhileBusy) {
        requestedWhileBusy = false
        schedule()
      }
    }
  }

  const reportApplyError = (error: unknown): void => {
    if (options.onError) {
      options.onError(error)
    } else {
      console.error("[TerminalResizeCoordinator] resize failed", error)
    }
  }

  const waitForStableGrid = (
    previous: TerminalGridSize,
    frameCount: number
  ): void => {
    scheduled = requestAnimationFrame(() => {
      scheduled = null
      if (disposed) return
      const next = options.measure()
      if (!isValidGrid(next)) return

      // A divider commit has already flushed the final CSS geometry. Let it
      // cut through the ordinary observer stability window while retaining
      // the window for font, zoom, visibility, and browser resize changes.
      if (stableRequested) {
        stableRequested = false
        void applyStableSize(next).catch(reportApplyError)
        return
      }
      if (sameGrid(previous, next) || frameCount >= MAX_STABILITY_FRAMES) {
        void applyStableSize(next).catch(reportApplyError)
        return
      }
      waitForStableGrid(next, frameCount + 1)
    })
  }

  function schedule(): void {
    if (disposed || scheduled !== null) return
    scheduled = requestAnimationFrame(() => {
      scheduled = null
      if (disposed) return
      if (applying) {
        requestedWhileBusy = true
        return
      }
      const size = options.measure()
      if (!isValidGrid(size)) return
      if (stableRequested) {
        stableRequested = false
        void applyStableSize(size).catch(reportApplyError)
        return
      }
      waitForStableGrid(size, 1)
    })
  }

  return {
    request() {
      if (disposed) return
      if (applying) {
        requestedWhileBusy = true
        return
      }
      schedule()
    },
    requestStable() {
      if (disposed) return
      stableRequested = true
      if (applying) {
        requestedWhileBusy = true
        return
      }
      schedule()
    },
    dispose() {
      if (disposed) return
      disposed = true
      requestedWhileBusy = false
      stableRequested = false
      cancelScheduled()
    },
  }
}
