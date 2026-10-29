import type { SplitPaneGeometry } from "@/lib/workspace/split-view"

export type SplitLayoutCommitReason =
  | "divider"
  | "keyboard"
  | "maximize"
  | "restore"
  | "external-resize"

export interface SplitLayoutCommit {
  geometry: readonly SplitPaneGeometry[]
  reason: SplitLayoutCommitReason
}

export interface SplitLayoutTransaction {
  beginPreview: () => void
  /** Queue a consumer until the current preview commits. */
  schedule: (callback: () => void) => void
  subscribeCommit: (listener: (commit: SplitLayoutCommit) => void) => () => void
  subscribeCancel: (listener: () => void) => () => void
  commit: (commit: SplitLayoutCommit) => void
  cancel: () => void
  isPreviewing: () => boolean
}

/**
 * Scoped transaction channel for expensive geometry consumers. It carries no
 * React state and never publishes pointermove data; consumers receive one
 * opportunity after commit, while cancellation drops their queued work.
 */
export function createSplitLayoutTransaction(): SplitLayoutTransaction {
  let previewDepth = 0
  const pending = new Set<() => void>()
  const commitListeners = new Set<(commit: SplitLayoutCommit) => void>()
  const cancelListeners = new Set<() => void>()

  const runPending = () => {
    if (previewDepth > 0) return
    const callbacks = [...pending]
    pending.clear()
    for (const callback of callbacks) callback()
  }

  return {
    beginPreview() {
      previewDepth += 1
    },
    schedule(callback) {
      if (previewDepth > 0) {
        pending.add(callback)
        return
      }
      callback()
    },
    subscribeCommit(listener) {
      commitListeners.add(listener)
      return () => commitListeners.delete(listener)
    },
    commit(commitInfo) {
      if (previewDepth === 0) return
      previewDepth -= 1
      runPending()
      // Nested SplitViews can share one scoped transaction. Do not publish an
      // expensive-consumer commit while an outer preview is still active.
      if (previewDepth > 0) return
      for (const listener of commitListeners) listener(commitInfo)
    },
    subscribeCancel(listener) {
      cancelListeners.add(listener)
      return () => cancelListeners.delete(listener)
    },
    cancel() {
      previewDepth = 0
      pending.clear()
      for (const listener of cancelListeners) listener()
    },
    isPreviewing() {
      return previewDepth > 0
    },
  }
}
