/**
 * Tauri TerminalStream: attach via snapshot + raw IPC Channel packets.
 *
 * The desktop client attaches to the Berth-owned `berth-terminald` runtime.
 * Attach captures a sequence-N snapshot, then streams ordered raw output
 * frames from `terminal_attach_channel` into the personal-console runtime store.
 *
 * The Channel starts before the snapshot returns; events at or before sequence N
 * are dropped while Rust owns gap/resync signaling.
 */

import type { Transport } from "@/lib/transport/types"
import { isRemoteBrowser } from "@/lib/transport/detect"
import type {
  TerminalAttachment,
  TerminalSnapshot,
  TerminalStatus,
  TerminalStream,
  TerminalStreamEvent,
} from "./terminal-stream"
import { EventQueue, snapshotFromWire } from "./terminal-stream"
import { recordTerminalDroppedBytes } from "./terminal-performance-metrics"
import {
  decodeTauriTerminalPacket,
  type TauriTerminalPacketInput,
} from "./tauri-terminal-packet"

interface WireSnapshot {
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
}

interface TerminalEventPayload {
  terminal_id?: string
  terminalId?: string
  sequence?: number
}

const MAX_EVENT_BUFFER_BYTES = 2 * 1024 * 1024
const MAX_EVENT_BUFFER_EVENTS = 256

export class TauriTerminalStream implements TerminalStream {
  constructor(private transport: Transport) {}

  async attach(input: {
    terminalId: string
    clientId: string
    clientLabel: string
  }): Promise<TerminalAttachment> {
    void input.clientLabel
    const transport = this.transport
    const callRaw = transport.callRaw?.bind(transport)
    if (!callRaw) {
      throw new Error("Raw terminal IPC is unavailable on this transport")
    }

    const events = new EventQueue<TerminalStreamEvent>()
    let detached = false
    let operationTail: Promise<unknown> = Promise.resolve()
    // Until snapshot resolves, buffer live events so the subscribe→snapshot
    // window cannot lose contiguous output that belongs after sequence N.
    let sequence: number | null = null
    const pending: TerminalStreamEvent[] = []
    let pendingBytes = 0
    let pendingOverflowed = false
    // The barrier starts when resize is queued, not when the serialized
    // operation reaches the head of operationTail. Otherwise output produced
    // while an earlier input is in flight can be delivered live and then be
    // included again in the resize snapshot.
    let resizePendingCount = 0
    const duringResize: TerminalStreamEvent[] = []
    let duringResizeBytes = 0
    let duringResizeOverflowed = false

    const queuePending = (event: TerminalStreamEvent): void => {
      const eventBytes = event.type === "output" ? event.data.byteLength : 0
      if (pendingOverflowed) {
        recordTerminalDroppedBytes(input.terminalId, "attach", eventBytes)
        return
      }
      if (
        pending.length >= MAX_EVENT_BUFFER_EVENTS ||
        pendingBytes + eventBytes > MAX_EVENT_BUFFER_BYTES
      ) {
        recordTerminalDroppedBytes(
          input.terminalId,
          "attach",
          pendingBytes + eventBytes
        )
        pending.length = 0
        pendingBytes = 0
        pendingOverflowed = true
        return
      }
      pending.push(event)
      pendingBytes += eventBytes
    }

    const queueDuringResize = (event: TerminalStreamEvent): void => {
      const eventBytes = event.type === "output" ? event.data.byteLength : 0
      if (duringResizeOverflowed) {
        recordTerminalDroppedBytes(input.terminalId, "attach", eventBytes)
        return
      }
      if (
        duringResize.length >= MAX_EVENT_BUFFER_EVENTS ||
        duringResizeBytes + eventBytes > MAX_EVENT_BUFFER_BYTES
      ) {
        recordTerminalDroppedBytes(
          input.terminalId,
          "attach",
          duringResizeBytes + eventBytes
        )
        duringResize.length = 0
        duringResizeBytes = 0
        duringResizeOverflowed = true
        return
      }
      duringResize.push(event)
      duringResizeBytes += eventBytes
    }

    const pushAfterSnapshot = (event: TerminalStreamEvent): void => {
      if (detached) return
      if (sequence == null) {
        queuePending(event)
        return
      }
      if (resizePendingCount > 0) {
        queueDuringResize(event)
        return
      }
      if (event.type === "output" || event.type === "statusChanged") {
        // Rust owns output ordering and emits an explicit resync control frame
        // for lag/transport gaps. Keep this adapter limited to the snapshot
        // boundary; the shared runtime cursor remains the defensive check.
        // Only a full-history watermark carries pre-watermark bytes — a
        // resize acknowledgement does not, so after a resize barrier events
        // flow through and the runtime's sequence-gap check decides.
        if (watermarkIsFullSnapshot && event.sequence <= sequence) {
          // Pre-snapshot or duplicate under the race window.
          return
        }
        if (
          !watermarkIsFullSnapshot &&
          event.type === "statusChanged" &&
          event.sequence <= sequence
        ) {
          // Status duplicates under the resize race window are still safe to
          // drop: status is idempotent and carries no bytes.
          return
        }
        sequence = event.sequence
      }
      events.push(event)
    }

    const flushDuringResize = (): void => {
      if (duringResizeOverflowed) {
        duringResize.length = 0
        duringResizeBytes = 0
        duringResizeOverflowed = false
        events.push({
          type: "resyncRequired",
          terminalId: input.terminalId,
          sequence: sequence ?? 0,
        })
        return
      }
      const buffered = duringResize.splice(0)
      duringResizeBytes = 0
      for (const event of buffered) pushAfterSnapshot(event)
    }

    // Whether the sequence watermark belongs to a full-history snapshot that
    // actually carries the pre-watermark bytes. Attach/resync snapshots do;
    // resize acknowledgements are visible-only geometry barriers — bytes
    // buffered behind them must be delivered, not absorbed into the watermark.
    let watermarkIsFullSnapshot = true

    const { Channel } = await import("@tauri-apps/api/core")
    // Tauri may deliver small raw frames as ArrayBuffer and large ones via
    // channel fetch as ArrayBufferView/number[]; decode normalizes all of them.
    const outputChannel = new Channel<TauriTerminalPacketInput>()
    outputChannel.onmessage = (packet) => {
      if (detached) return
      const decoded = decodeTauriTerminalPacket(packet)
      if (decoded.type === "invalid") {
        const event: TerminalStreamEvent = {
          type: "resyncRequired",
          terminalId: input.terminalId,
          sequence: sequence ?? 0,
        }
        if (resizePendingCount > 0) queueDuringResize(event)
        else events.push(event)
        return
      }
      if (decoded.type === "resync") {
        const event: TerminalStreamEvent = {
          type: "resyncRequired",
          terminalId: input.terminalId,
          sequence: decoded.sequence,
        }
        if (resizePendingCount > 0) queueDuringResize(event)
        else events.push(event)
        return
      }
      pushAfterSnapshot({
        type: "output",
        terminalId: input.terminalId,
        sequenceStart: decoded.sequenceStart,
        sequence: decoded.sequenceEnd,
        data: decoded.data,
      })
    }

    const unsubExit = await this.transport.subscribe<TerminalEventPayload>(
      `terminal://exit/${input.terminalId}`,
      (payload) => {
        if (detached) return
        // Exit events do not currently carry sequence; force resync so the
        // runtime re-reads status via snapshot rather than inventing one.
        const nextSeq =
          typeof payload.sequence === "number" &&
          Number.isFinite(payload.sequence)
            ? payload.sequence
            : (sequence ?? 0) + 1
        pushAfterSnapshot({
          type: "statusChanged",
          terminalId: input.terminalId,
          sequence: nextSeq,
          status: "exited",
          exitCode: null,
          exitedAt: new Date().toISOString(),
        })
      }
    )

    let snapshot: TerminalSnapshot
    try {
      const wire = await this.transport.call<WireSnapshot>(
        "terminal_attach_channel",
        {
          terminalId: input.terminalId,
          clientId: input.clientId,
          onOutput: outputChannel,
        }
      )
      snapshot = snapshotFromWire(wire)
    } catch (err) {
      detached = true
      unsubExit()
      events.fail(err)
      throw err
    }

    sequence = snapshot.sequence
    if (pendingOverflowed) {
      pending.length = 0
      pendingBytes = 0
      pendingOverflowed = false
      events.push({
        type: "resyncRequired",
        terminalId: input.terminalId,
        sequence: snapshot.sequence,
      })
    } else {
      for (const event of pending) {
        pushAfterSnapshot(event)
      }
    }
    pending.length = 0
    pendingBytes = 0

    // 远程浏览器不串行等回执：一条 WebSocket 保序，宿主按到达顺序逐个执行带输入序号的
    // 写入与 resize（`remote/mod.rs` 的输入道），每次输入省一次往返。
    const enqueueOperation = isRemoteBrowser()
      ? <T>(operation: () => Promise<T>): Promise<T> => operation()
      : <T>(operation: () => Promise<T>): Promise<T> => {
          const next = operationTail.then(operation, operation)
          operationTail = next.catch(() => {})
          return next
        }
    return {
      snapshot,
      events,
      write: (inputSequence: number, data: Uint8Array): Promise<void> =>
        enqueueOperation<void>(() =>
          callRaw("terminal_write_attached_raw", data, {
            "x-berth-terminal-id": encodeURIComponent(input.terminalId),
            "x-berth-client-id": encodeURIComponent(input.clientId),
            "x-berth-input-sequence": String(inputSequence),
          })
        ),
      resize: (
        inputSequence: number,
        rows: number,
        cols: number
      ): Promise<TerminalSnapshot> =>
        (() => {
          resizePendingCount += 1
          return enqueueOperation<TerminalSnapshot>(async () => {
            try {
              const wire = await transport.call<WireSnapshot>(
                "terminal_resize_attached",
                {
                  terminalId: input.terminalId,
                  clientId: input.clientId,
                  inputSequence,
                  rows,
                  cols,
                }
              )
              const nextSnapshot = snapshotFromWire(wire)
              sequence = nextSnapshot.sequence
              // Resize acks are visible-only: the watermark is a barrier, not
              // a content boundary. Buffered bytes flow through after this.
              watermarkIsFullSnapshot = false
              resizePendingCount -= 1
              if (resizePendingCount === 0) flushDuringResize()
              return nextSnapshot
            } catch (error) {
              resizePendingCount -= 1
              if (resizePendingCount === 0) flushDuringResize()
              throw error
            }
          })
        })(),
      detach: async (): Promise<void> => {
        if (detached) return
        detached = true
        events.close()
        unsubExit()
        try {
          await transport.call("terminal_detach", {
            terminalId: input.terminalId,
            clientId: input.clientId,
          })
        } catch {
          // Best-effort: socket/process may already be gone.
        }
      },
    }
  }
}

export type { TerminalSnapshot }
