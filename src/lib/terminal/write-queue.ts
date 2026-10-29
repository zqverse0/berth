/**
 * Ordered, single-flight write pump for terminal input.
 *
 * Terminal input must reach the PTY in exactly the order it was typed. The
 * transport calls underneath an attached terminal write give NO cross-call
 * ordering guarantee: Tauri v2 dispatches concurrent `invoke`s on a thread
 * pool (whichever finishes first resolves first), and the web/remote paths are
 * independent HTTP POSTs (unordered, connection-pool-limited). Firing one
 * fire-and-forget call per keystroke therefore scrambles fast input.
 *
 * This queue restores ordering the way VS Code / xterm.js do it — a single
 * ordered channel — by serializing: at most ONE `send` is in flight, and the
 * next batch waits for the previous to resolve. Because the backend enqueues
 * bytes into its FIFO PTY-writer channel *before* the call returns, awaiting
 * each send guarantees end-to-end type order regardless of transport
 * reordering.
 *
 * Bytes typed while a send is in flight coalesce into the next batch — fewer,
 * larger sends, the same "event batching" the VS Code pty-host uses — so fast
 * typing and paste collapse to a handful of round-trips instead of one per
 * character.
 *
 * Failure policy: a failed send is DROPPED, never retried. The only "ack" the
 * transport gives us is the call resolving — there is no signal distinguishing
 * "the bytes reached the PTY" from "they didn't" when a request times out or
 * the connection drops mid-flight. Re-sending an ambiguous batch risks
 * DUPLICATING already-delivered input, and a duplicated control byte (Enter,
 * Ctrl-C, a pasted command) is worse in a shell than a dropped one. So we
 * favor at-most-once over at-least-once. (This matches the prior
 * fire-and-forget behavior on failure — we only add ordering, never a new
 * duplication risk. Eliminating loss too would require a backend write-ack /
 * idempotency layer, which is out of scope here.)
 *
 * Connectivity fencing: optional `canSend` is checked immediately before
 * each flush. When it returns false, the pending buffer is dropped so input
 * typed while offline is never replayed into a shell later.
 */

export interface WriteQueueOptions {
  /**
   * Gate checked immediately before each flush. When false, the current
   * pending buffer is dropped and the pump stops until more input arrives
   * (and `canSend` becomes true again). Use for connectivity fencing.
   */
  canSend?: () => boolean
  /** Maximum batches awaiting acknowledgement. Defaults to one. */
  maxInFlight?: number
}

export interface WriteQueue {
  /** Append input bytes; sent in order, coalescing under load. */
  enqueue: (data: string) => void
  /** Stop the pump and drop buffered bytes. Idempotent. */
  dispose: () => void
  /** Drop buffered bytes without stopping the pump (e.g. on disconnect). */
  clear: () => void
}

/**
 * Create an ordered single-flight write pump. `send` is the sink for one batch
 * of bytes (e.g. `(data) => attachment.write(data)`).
 */
export function createWriteQueue(
  send: (data: string) => Promise<void>,
  options?: WriteQueueOptions
): WriteQueue {
  let pending = ""
  let inFlight = 0
  let stopped = false
  const canSend = options?.canSend
  const maxInFlight = Math.max(1, options?.maxInFlight ?? 1)

  function flush(): void {
    while (!stopped && pending.length > 0 && inFlight < maxInFlight) {
      if (canSend && !canSend()) {
        pending = ""
        return
      }
      const batch = pending
      pending = ""
      inFlight += 1
      void send(batch)
        .catch(() => {
          // Sequence-fenced transport handles reconnect; never duplicate here.
        })
        .finally(() => {
          inFlight -= 1
          if (!stopped) flush()
        })
    }
  }

  return {
    enqueue(data: string): void {
      if (stopped || data.length === 0) return
      if (canSend && !canSend()) {
        // Disconnected personal console: never buffer for later replay.
        return
      }
      pending += data
      flush()
    },
    clear(): void {
      pending = ""
    },
    dispose(): void {
      stopped = true
      pending = ""
    },
  }
}
