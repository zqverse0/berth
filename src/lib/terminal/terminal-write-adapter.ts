export type TerminalWriteData = string | Uint8Array

export interface TerminalWriteTarget {
  write: (data: TerminalWriteData, callback?: () => void) => void
}

export interface TerminalWriteAdapter {
  write: (data: TerminalWriteData, onApplied?: () => void) => void
  fence: (onApplied: () => void) => void
  dispose: () => void
}

/** Execute application callbacks without letting an exception poison xterm. */
export function invokeTerminalWriteCallback(callback?: () => void): void {
  if (!callback) return
  try {
    callback()
  } catch (error) {
    // xterm 的 WriteBuffer 不应承接业务回调异常，否则后续输出会被卡住。
    console.error("[TerminalWriteAdapter] callback failed", error)
  }
}

function safeCallback(callback?: () => void): (() => void) | undefined {
  if (!callback) return undefined
  return () => invokeTerminalWriteCallback(callback)
}

/** The single ordered xterm write boundary used by live output and snapshots. */
export function createTerminalWriteAdapter(
  target: TerminalWriteTarget
): TerminalWriteAdapter {
  let disposed = false

  return {
    write(data, onApplied) {
      if (disposed) return
      if (data.length === 0) {
        invokeTerminalWriteCallback(onApplied)
        return
      }
      target.write(data, safeCallback(onApplied))
    },
    fence(onApplied) {
      if (disposed) return
      target.write(new Uint8Array(), safeCallback(onApplied))
    },
    dispose() {
      disposed = true
    },
  }
}
