/**
 * Runtime-neutral TerminalStream contract for personal console terminals.
 *
 * The only production adapter is Tauri IPC (`tauri-terminal-stream`).
 * Domain types use Uint8Array for PTY bytes; base64 is confined to wire
 * snapshot fields at the Tauri boundary.
 */

export type TerminalStatus = "running" | "exited" | "failed"

export interface TerminalSnapshot {
  terminalId: string
  backendInstanceId: string
  sequence: number
  rows: number
  cols: number
  /** Raw ANSI reconstruction bytes (already decoded from wire base64). */
  ansi: Uint8Array
  /**
   * Wire-level honesty flag from the backend snapshot.
   *
   * - `false` on attach/resync: payload includes RMUX-retained history (subject
   *   to daemon history-limit, not a Berth byte-budget trim).
   * - `true` on ordinary resize acknowledgements: payload is visible-window
   *   only and must never be painted as authoritative retained history.
   *
   * This is NOT "Berth truncated scrollback for transport budget".
   */
  historyTruncated: boolean
  status: TerminalStatus
  exitCode: number | null
  exitedAt: string | null
  lastKnownCwd: string | null
}

export type TerminalStreamEvent =
  | {
      type: "output"
      terminalId: string
      sequenceStart?: number
      sequence: number
      data: Uint8Array
    }
  | {
      type: "statusChanged"
      terminalId: string
      sequence: number
      status: TerminalStatus
      exitCode: number | null
      exitedAt: string | null
    }
  | {
      type: "historyTruncated"
      terminalId: string
      sequence: number
    }
  | {
      type: "removed"
      terminalId: string
      sequence?: number
    }
  | {
      type: "resyncRequired"
      terminalId: string
      sequence: number
    }
  | {
      type: "snapshot"
      snapshot: TerminalSnapshot
    }
  | {
      type: "connectionState"
      state: "connected" | "disconnected"
    }

export interface TerminalAttachment {
  snapshot: TerminalSnapshot
  events: AsyncIterable<TerminalStreamEvent>
  write(inputSequence: number, data: Uint8Array): Promise<void>
  resize(
    inputSequence: number,
    rows: number,
    cols: number
  ): Promise<TerminalSnapshot>
  outputApplied?(sequence: number): void
  detach(): Promise<void>
}

export interface TerminalStream {
  attach(input: {
    terminalId: string
    clientId: string
    clientLabel: string
  }): Promise<TerminalAttachment>
}

/** Decode standard base64 into bytes. Empty / invalid → empty buffer. */
export function decodeBase64(b64: string | null | undefined): Uint8Array {
  if (!b64) return new Uint8Array()
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return new Uint8Array()
  }
}

/** Encode bytes to standard base64 for wire boundaries. */
export function encodeBase64(data: Uint8Array): string {
  if (data.length === 0) return ""
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Normalize a camelCase wire snapshot (ansiBase64) into the domain
 * TerminalSnapshot with decoded ANSI bytes.
 */
export function snapshotFromWire(raw: {
  terminalId: string
  backendInstanceId: string
  sequence: number
  rows: number
  cols: number
  ansiBase64: string
  historyTruncated: boolean
  status: TerminalStatus
  exitCode?: number | null
  exitedAt?: string | null
  lastKnownCwd?: string | null
}): TerminalSnapshot {
  return {
    terminalId: raw.terminalId,
    backendInstanceId: raw.backendInstanceId,
    sequence: raw.sequence,
    rows: raw.rows,
    cols: raw.cols,
    ansi: decodeBase64(raw.ansiBase64),
    historyTruncated: raw.historyTruncated,
    status: raw.status,
    exitCode: raw.exitCode ?? null,
    exitedAt: raw.exitedAt ?? null,
    lastKnownCwd: raw.lastKnownCwd ?? null,
  }
}

/** Push-based AsyncIterable used by both adapters. */
export class EventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiters: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (err: unknown) => void
  }> = []
  private closed = false
  private error: unknown = null

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value: item, done: false })
      return
    }
    this.queue.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.resolve({ value: undefined as unknown as T, done: true })
    }
  }

  fail(err: unknown): void {
    if (this.closed) return
    this.error = err
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.reject(err)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift() as T,
            done: false,
          })
        }
        if (this.error) return Promise.reject(this.error)
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          })
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      },
    }
  }
}
