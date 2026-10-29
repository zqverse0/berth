/**
 * Device-local Terminal attachment runtime.
 *
 * Owns attach/input/sequence/connection state for personal console terminals.
 * Does NOT own PTY lifecycle — create/terminate/remove_record live elsewhere.
 * A missing RMUX window is removed from the local view; it is never persisted
 * as a lost or unavailable terminal state.
 *
 * Sequence rules:
 * - Apply only contiguous output with sequence === current + 1.
 * - Any gap / resyncRequired / duplicate boundary triggers reattach.
 * - Offline disconnect clears pending writes; never buffers keypresses.
 */

import { create } from "zustand"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { isLocalDesktop } from "@/lib/platform"
import { getTransport, isRemoteBrowser } from "@/lib/transport"
import type {
  TerminalAttachment,
  TerminalSnapshot,
  TerminalStatus as StreamTerminalStatus,
  TerminalStream,
  TerminalStreamEvent,
} from "@/lib/terminal/terminal-stream"
import { createWriteQueue, type WriteQueue } from "@/lib/terminal/write-queue"
import { randomUUID } from "@/lib/utils"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import { useTabStore } from "@/stores/tab-store"
import { sanitizeTerminalPaste } from "@/lib/content-reference/serialize"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalRuntimeStatus =
  | "attaching"
  | "connected"
  | "disconnected"
  | "exited"
  | "expired"
  | "cleared"
  | "degraded"

export type TerminalOutputSink = (
  data: Uint8Array,
  onApplied: () => void
) => void

export type TerminalPasteResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | "missing"
        | "disconnected"
        | "target-changed"
        | "backend-mismatch"
        | "unsupported"
        | "unsafe-multiline"
    }

export interface TerminalPasteOptions {
  submit: false
  source: "document-context"
  tabId: string
  backendInstanceId: string
}

/** 返回 `false` 表示拒绝：多行文本而终端未开启 bracketed paste（换行会被当成回车逐行提交）。 */
export type TerminalSurfacePasteAdapter = (text: string) => boolean | void

export interface TerminalRuntimeSession {
  terminalId: string
  status: TerminalRuntimeStatus
  /**
   * Last sequence checkpoint published to runtime consumers. The live cursor
   * for ack-less desktop output stays in the module-scope attachment handle.
   */
  sequence: number
  snapshot: TerminalSnapshot | null
  /** Bumps whenever a new snapshot should be painted into xterm. */
  snapshotRevision: number
  /**
   * UI-side attachment token. Snapshot sequence numbers are only ordered
   * within this generation; reconnects must not compare sequence across
   * different backend attachments.
   */
  attachmentGeneration: number
  historyTruncated: boolean
  exitCode: number | null
  exitedAt: string | null
  lastKnownCwd: string | null
  backendInstanceId: string | null
  backendLabel: string
  errorMessage: string | null
  /** Last reason a resync/reattach was triggered (diagnostics). */
  lastResyncReason: string | null
  /**
   * Most recent command submitted by the user on this client, surfaced as the
   * sidebar row title. Nothing writes it yet — the sidebar consumer landed in
   * 2817a4376 ahead of the runtime side, so it stays optional and the row falls
   * back to the tab title. Populate it from the input path to finish the feature.
   */
  lastUserCommand?: string | null
}

export interface TerminalRuntimeState {
  sessions: Record<string, TerminalRuntimeSession>
  clientId: string
  clientLabel: string

  /** `freshSnapshot`: a new view mounts; re-attach even when already connected. */
  attachTerminal: (
    terminalId: string,
    options?: { freshSnapshot?: boolean }
  ) => Promise<void>
  detachTerminal: (terminalId: string) => Promise<void>
  sendInput: (terminalId: string, data: Uint8Array | string) => void
  pasteText: (
    terminalId: string,
    text: string,
    options: TerminalPasteOptions
  ) => Promise<TerminalPasteResult>
  resize: (
    terminalId: string,
    rows: number,
    cols: number
  ) => Promise<TerminalSnapshot | null>
  retrySnapshot: (terminalId: string, reason?: string) => Promise<void>
  acknowledgeOutput: (
    terminalId: string,
    sequence: number,
    expectedGeneration?: number
  ) => void

  /**
   * Bind an xterm write sink so live output is delivered without React
   * re-renders on every chunk. Return an identity-fenced disposer.
   *
   * A terminal view can be replaced before React runs the old view's cleanup
   * (for example during a keyed surface remount).  The disposer must not clear
   * a newer view's sink in that window.
   */
  setOutputSink: (
    terminalId: string,
    sink: TerminalOutputSink | null
  ) => () => void
  setSurfacePasteAdapter: (
    terminalId: string,
    adapter: TerminalSurfacePasteAdapter | null
  ) => () => void
  /**
   * Pause live sink delivery while painting an authoritative snapshot so
   * concurrent PTY chunks cannot interleave with reset/replay (which was
   * progressively destroying scrollback under TUI full redraws).
   */
  beginSnapshotPaint: (terminalId: string, expectedGeneration?: number) => void
  activateOutputSink: (terminalId: string, expectedGeneration?: number) => void

  /** Explicit UI transitions for deep-link and expiry states. */
  showInstanceExpired: (terminalId: string) => void
  showCleared: (terminalId: string) => void

  /** Transport-level disconnect overlay (keeps last screen). */
  markTransportDisconnected: () => void
  /** Reattach every active session after transport recovery. */
  reattachAfterReconnect: () => Promise<void>

  reset: () => void
}

// ---------------------------------------------------------------------------
// Internals (module scope — not part of React state)
// ---------------------------------------------------------------------------

const MAX_REMOTE_INPUT_OPERATION_BYTES = 32 * 1024
/** 远程浏览器同时在途的输入批数。 */
const REMOTE_INPUT_IN_FLIGHT = 64
const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024

interface SessionHandles {
  attachment: TerminalAttachment | null
  writeQueue: WriteQueue | null
  /** Protocol counter shared synchronously by write + resize for one tenure. */
  inputSequence: number
  /**
   * Live output cursor kept outside Zustand. Desktop Tauri has no transport
   * ACK to wait for, so publishing this on every batch would re-render the
   * terminal surface without changing anything the UI needs to paint.
   */
  streamSequence: number
  eventLoopAbort: AbortController | null
  attachGeneration: number
  outputSink: TerminalOutputSink | null
  surfacePasteAdapter: TerminalSurfacePasteAdapter | null
  outputSinkReady: boolean
  pendingOutput: Uint8Array[]
  pendingOutputBytes: number
  outputBufferOverflowed: boolean
  /** Pending bytes coalesced as string for the write queue. */
  pendingWriteEncoding: "utf8"
}

const handles = new Map<string, SessionHandles>()
let nextAttachmentGeneration = 0
/**
 * Host 按 client id 拆订阅，而重连沿用同一 client id：旧 attachment 的 detach
 * 必须先于新 attach 落地，否则会拆掉新订阅，终端停在旧画面。卸载后马上重新挂载
 * 时 handles 已被删除，所以按 terminalId 记在 handles 之外。
 */
const pendingDetaches = new Map<string, Promise<void>>()

function allocateAttachmentGeneration(): number {
  nextAttachmentGeneration += 1
  return nextAttachmentGeneration
}

function resetOutputGateForNewAttachment(h: SessionHandles): void {
  h.streamSequence = 0
  h.outputSinkReady = false
  h.pendingOutput = []
  h.pendingOutputBytes = 0
  h.outputBufferOverflowed = false
}

/** Attach-mode resize coalesced before sequence allocation (avoids SIGWINCH storms). */
interface PendingTerminalResize {
  rows: number
  cols: number
  generation: number
  waiters: Array<(snapshot: TerminalSnapshot | null) => void>
}

const pendingResizes = new Map<string, PendingTerminalResize>()
const resizePumps = new Set<string>()

let streamOverride: TerminalStream | null = null
let streamCache: TerminalStream | null = null

function emptySession(terminalId: string): TerminalRuntimeSession {
  return {
    terminalId,
    status: "attaching",
    sequence: 0,
    snapshot: null,
    snapshotRevision: 0,
    attachmentGeneration: 0,
    historyTruncated: false,
    exitCode: null,
    exitedAt: null,
    lastKnownCwd: null,
    backendInstanceId: null,
    backendLabel: resolveBackendLabel(),
    errorMessage: null,
    lastResyncReason: null,
  }
}

function resolveBackendLabel(): string {
  // Desktop-only product: personal terminals always attach to the local
  // berth-terminald / RMUX instance. Remote/server backends were removed with
  // the web stack (08-06-web-server-removal).
  return isLocalDesktop() ? "Local" : "Desktop"
}

function defaultClientLabel(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    const ua = navigator.userAgent
    if (/Mobile|Android|iPhone|iPad/i.test(ua)) return "Mobile"
    if (isLocalDesktop()) return "Desktop"
  }
  return "Berth"
}

function ensureHandles(terminalId: string): SessionHandles {
  let h = handles.get(terminalId)
  if (!h) {
    h = {
      attachment: null,
      writeQueue: null,
      inputSequence: 0,
      streamSequence: 0,
      eventLoopAbort: null,
      attachGeneration: allocateAttachmentGeneration(),
      outputSink: null,
      surfacePasteAdapter: null,
      outputSinkReady: false,
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputBufferOverflowed: false,
      pendingWriteEncoding: "utf8",
    }
    handles.set(terminalId, h)
  }
  return h
}

function disposeWriteQueue(h: SessionHandles): void {
  h.writeQueue?.dispose()
  h.writeQueue = null
}

function bytesToString(data: Uint8Array | string): string {
  if (typeof data === "string") return data
  return new TextDecoder().decode(data)
}

function stringToBytes(data: string): Uint8Array {
  return new TextEncoder().encode(data)
}

function errorCode(err: unknown): string | null {
  return extractAppCommandError(err)?.code ?? null
}

/**
 * 这次 attach 的输入道已经走不下去：订阅被宿主丢弃，或某个序号没被宿主接收（失败的写入 /
 * resize 不重发），之后每个序号都会被判乱序。重新 attach 换新 clientId、序号从头开始；
 * 不然输入会一直失败，只能刷新页面。
 */
function needsReattach(err: unknown): boolean {
  const code = errorCode(err)
  return (
    code === "terminal_transport_disconnected" || code === "input_out_of_order"
  )
}

function mapAttachErrorStatus(err: unknown): TerminalRuntimeStatus {
  const code = errorCode(err)
  if (code === "terminal_exited") return "exited"
  if (code === "terminal_transport_disconnected") return "disconnected"
  if (code === "snapshot_unavailable") return "degraded"
  return "degraded"
}

function mapAsyncTerminalErrorStatus(
  code: string | null
): TerminalRuntimeStatus | null {
  if (code === "terminal_exited") return "exited"
  if (code === "terminal_transport_disconnected") return "disconnected"
  if (code === "snapshot_unavailable") return "degraded"
  return null
}

// ---------------------------------------------------------------------------
// TerminalStream resolution
// ---------------------------------------------------------------------------

/**
 * Inject a TerminalStream for tests. Pass `null` to restore the default
 * transport-backed implementation.
 */
export function __setTerminalStreamForTests(
  stream: TerminalStream | null
): void {
  streamOverride = stream
  streamCache = null
}

/**
 * Desktop-only stream factory. Web/remote TerminalConnection was removed with
 * the server product surface; only Tauri IPC remains.
 */
async function resolveTerminalStream(): Promise<TerminalStream> {
  if (streamOverride) return streamOverride
  if (streamCache) return streamCache

  const transport = getTransport()
  if (!transport.isDesktop()) {
    throw new Error(
      "Berth requires the desktop app runtime for personal terminals"
    )
  }

  const { TauriTerminalStream } =
    await import("@/lib/terminal/tauri-terminal-stream")
  streamCache = new TauriTerminalStream(transport)
  return streamCache
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function patchSession(
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void,
  terminalId: string,
  patch: Partial<TerminalRuntimeSession>
): void {
  set((state) => {
    const prev = state.sessions[terminalId]
    if (!prev) return state
    return {
      sessions: {
        ...state.sessions,
        [terminalId]: { ...prev, ...patch },
      },
    }
  })
}

function getSession(
  get: () => TerminalRuntimeState,
  terminalId: string
): TerminalRuntimeSession | undefined {
  return get().sessions[terminalId]
}

function stopSessionLoop(
  terminalId: string,
  set?: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void
): void {
  const h = handles.get(terminalId)
  if (!h) return
  h.attachGeneration = allocateAttachmentGeneration()
  resetOutputGateForNewAttachment(h)
  if (set) {
    patchSession(set, terminalId, {
      attachmentGeneration: h.attachGeneration,
    })
  }
  h.eventLoopAbort?.abort()
  h.eventLoopAbort = null
  disposeWriteQueue(h)
  clearPendingResize(terminalId)
  const attachment = h.attachment
  h.attachment = null
  if (attachment) {
    const detach = attachment.detach().catch(() => {})
    pendingDetaches.set(terminalId, detach)
    void detach.finally(() => {
      if (pendingDetaches.get(terminalId) === detach) {
        pendingDetaches.delete(terminalId)
      }
    })
  }
}

/**
 * RMUX runtime state is intentionally memory-only. Once a window disappears
 * (for example after a daemon restart), remove the stale local tab/runtime
 * entry so the next terminal creation starts a fresh window.
 */
function clearStaleTerminal(
  terminalId: string,
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void
): void {
  stopSessionLoop(terminalId)
  handles.delete(terminalId)
  set((state) => {
    if (!(terminalId in state.sessions)) return state
    const next = { ...state.sessions }
    delete next[terminalId]
    return { sessions: next }
  })

  const tab = useTabStore
    .getState()
    .tabs.find(
      (candidate) =>
        isTerminalTab(candidate) && candidate.terminalId === terminalId
    )
  if (tab) {
    useTabStore.getState().closeTab(tab.id)
  }
}

function markTerminalTransportDisconnected(
  terminalId: string,
  get: () => TerminalRuntimeState,
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void
): void {
  const h = handles.get(terminalId)
  if (h) {
    h.writeQueue?.clear()
    h.attachment = null
    h.attachGeneration = allocateAttachmentGeneration()
    resetOutputGateForNewAttachment(h)
    h.eventLoopAbort?.abort()
    h.eventLoopAbort = null
  }
  clearPendingResize(terminalId)
  patchSession(set, terminalId, {
    status: "disconnected",
    ...(h ? { attachmentGeneration: h.attachGeneration } : {}),
  })
  // Host 拒绝的是这一次 attach 的订阅，进程和 daemon 通常还在：重新 attach 一次。
  // attach 本身失败会落到错误状态并停止，不会循环重试。
  void get().retrySnapshot(terminalId, "transport_disconnected")
}

function resolveResizeWaiters(
  waiters: Array<(snapshot: TerminalSnapshot | null) => void>,
  snapshot: TerminalSnapshot | null
): void {
  for (const resolve of waiters) resolve(snapshot)
}

/** Drop staged resizes and unblock any callers waiting on them. */
function clearPendingResize(terminalId: string): void {
  const pending = pendingResizes.get(terminalId)
  if (!pending) return
  pendingResizes.delete(terminalId)
  resolveResizeWaiters(pending.waiters, null)
}

function clearAllPendingResizes(): void {
  for (const terminalId of [...pendingResizes.keys()]) {
    clearPendingResize(terminalId)
  }
  resizePumps.clear()
}

/**
 * Drain coalesced resizes for one terminal: at most one PTY resize per distinct
 * settled size, sequence allocated only when sending.
 */
async function pumpPendingResizes(
  terminalId: string,
  get: () => TerminalRuntimeState,
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void
): Promise<void> {
  if (resizePumps.has(terminalId)) return
  resizePumps.add(terminalId)
  try {
    while (pendingResizes.has(terminalId)) {
      const h = handles.get(terminalId)
      const pending = pendingResizes.get(terminalId)
      if (!h || !pending) {
        clearPendingResize(terminalId)
        break
      }
      const attachment = h.attachment
      if (
        !attachment ||
        pending.generation !== h.attachGeneration ||
        pending.rows < 1 ||
        pending.cols < 1
      ) {
        clearPendingResize(terminalId)
        break
      }
      // Own this job so concurrent resize() can stage a newer size.
      pendingResizes.delete(terminalId)
      const generation = h.attachGeneration
      const nextSeq = nextInputSequence(h)
      try {
        const snapshot = await attachment.resize(
          nextSeq,
          pending.rows,
          pending.cols
        )
        const isCurrent = isCurrentAttachment(
          terminalId,
          h,
          attachment,
          generation
        )
        if (isCurrent) {
          const statusFromSnap: TerminalRuntimeStatus =
            snapshot.status === "exited" || snapshot.status === "failed"
              ? "exited"
              : "connected"
          // Resize acknowledgements are geometry/sequence barriers, not
          // repaint snapshots: the runtime-visible `sequence` advances (the
          // barrier was observed) but the consumption cursor
          // `h.streamSequence` does NOT — it tracks "bytes the frontend has
          // actually delivered", and a visible-only response carries none.
          // Advancing it here made contiguous late packets look like a gap
          // (spurious resync; T1 scenario I). applySnapshot resets the
          // cursor on reattach from a full-history snapshot — the painted
          // source of truth. Keep the last full-history snapshot in the
          // runtime so a later recovery cannot mistake a visible-only
          // resize response for authoritative retained history.
          patchSession(set, terminalId, {
            status: statusFromSnap,
            sequence: snapshot.sequence,
            attachmentGeneration: generation,
            exitCode: snapshot.exitCode,
            exitedAt: snapshot.exitedAt,
            lastKnownCwd: snapshot.lastKnownCwd,
            backendInstanceId: snapshot.backendInstanceId,
            backendLabel: resolveBackendLabel(),
            errorMessage: null,
          })
        }
        // A resize response is a snapshot boundary even though the view
        // deliberately does not replay it. Release the stream gate here;
        // the render controller is already holding subsequent bytes until
        // the confirmed local geometry is applied.
        attachment.outputApplied?.(snapshot.sequence)
        resolveResizeWaiters(pending.waiters, isCurrent ? snapshot : null)
      } catch (err) {
        // Fire-and-resolve: never reject callers (metrics use .then only).
        if (!isCurrentAttachment(terminalId, h, attachment, generation)) {
          resolveResizeWaiters(pending.waiters, null)
          break
        }
        if (needsReattach(err)) {
          markTerminalTransportDisconnected(terminalId, get, set)
          clearPendingResize(terminalId)
          resolveResizeWaiters(pending.waiters, null)
          break
        }
        resolveResizeWaiters(pending.waiters, null)
      }
    }
  } finally {
    resizePumps.delete(terminalId)
    if (pendingResizes.has(terminalId)) {
      void pumpPendingResizes(terminalId, get, set)
    }
  }
}

function nextInputSequence(h: SessionHandles): number {
  h.inputSequence += 1
  return h.inputSequence
}

function isCurrentAttachment(
  terminalId: string,
  h: SessionHandles,
  attachment: TerminalAttachment,
  generation: number
): boolean {
  const current = handles.get(terminalId)
  return (
    current === h &&
    current.attachment === attachment &&
    current.attachGeneration === generation
  )
}

function ensureWriteQueue(
  terminalId: string,
  get: () => TerminalRuntimeState,
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void
): WriteQueue {
  const h = ensureHandles(terminalId)
  if (h.writeQueue) return h.writeQueue
  const remoteInput = isRemoteBrowser()

  const queue = createWriteQueue(
    async (batch) => {
      const session = getSession(get, terminalId)
      const attachment = h.attachment
      if (!session || !attachment) {
        return
      }
      const generation = h.attachGeneration
      const bytes = stringToBytes(batch)
      try {
        // 序号一次排好：多批同时在途时各块的序号仍按输入顺序。
        const chunks: [number, Uint8Array][] = []
        for (
          let offset = 0;
          offset < bytes.byteLength;
          offset += MAX_REMOTE_INPUT_OPERATION_BYTES
        ) {
          chunks.push([
            nextInputSequence(h),
            bytes.subarray(
              offset,
              Math.min(
                offset + MAX_REMOTE_INPUT_OPERATION_BYTES,
                bytes.byteLength
              )
            ),
          ])
        }
        if (remoteInput) {
          await Promise.all(
            chunks.map(([seq, chunk]) => attachment.write(seq, chunk))
          )
        } else {
          for (const [seq, chunk] of chunks) await attachment.write(seq, chunk)
        }
      } catch (err) {
        if (!isCurrentAttachment(terminalId, h, attachment, generation)) {
          throw err
        }
        if (needsReattach(err)) {
          markTerminalTransportDisconnected(terminalId, get, set)
        }
        throw err
      }
    },
    {
      // A terminal has one ordered input lane. Tauri's operation tail and the
      // RMUX executor already serialize the actual request; opening more
      // suspended calls only adds queueing and makes the ACK boundary opaque.
      // 远程浏览器例外：一条 WebSocket 保序、宿主按到达顺序逐个执行带输入序号的请求
      // （`remote/mod.rs`），不等上一批回执，省掉每批一次往返。
      maxInFlight: remoteInput ? REMOTE_INPUT_IN_FLIGHT : 1,
      canSend: () => {
        const session = getSession(get, terminalId)
        return Boolean(
          session && session.status === "connected" && h.attachment
        )
      },
    }
  )
  h.writeQueue = queue
  return queue
}

function applySnapshot(
  terminalId: string,
  snapshot: TerminalSnapshot,
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void,
  get: () => TerminalRuntimeState
): void {
  const h = handles.get(terminalId)
  if (h) h.streamSequence = snapshot.sequence
  const prev = getSession(get, terminalId)
  const statusFromSnap: TerminalRuntimeStatus =
    snapshot.status === "exited" || snapshot.status === "failed"
      ? "exited"
      : "connected"

  patchSession(set, terminalId, {
    status: statusFromSnap,
    sequence: snapshot.sequence,
    snapshot,
    snapshotRevision: (prev?.snapshotRevision ?? 0) + 1,
    attachmentGeneration: handles.get(terminalId)?.attachGeneration ?? 0,
    historyTruncated: snapshot.historyTruncated,
    exitCode: snapshot.exitCode,
    exitedAt: snapshot.exitedAt,
    lastKnownCwd: snapshot.lastKnownCwd,
    backendInstanceId: snapshot.backendInstanceId,
    backendLabel: resolveBackendLabel(),
    errorMessage: null,
  })
}

function applyEvent(
  terminalId: string,
  event: TerminalStreamEvent,
  get: () => TerminalRuntimeState,
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void,
  actions: {
    retrySnapshot: (terminalId: string, reason?: string) => Promise<void>
  }
): void {
  const session = getSession(get, terminalId)
  if (!session) return

  const h = handles.get(terminalId)
  const streamSequence = h?.streamSequence ?? session.sequence

  if (event.type === "connectionState") {
    patchSession(set, terminalId, {
      status:
        event.state === "disconnected"
          ? "disconnected"
          : session.status === "disconnected"
            ? "connected"
            : session.status,
    })
    return
  }

  if (event.type === "output") {
    const sequenceStart = event.sequenceStart ?? event.sequence
    if (sequenceStart !== streamSequence + 1) {
      void actions.retrySnapshot(terminalId, "sequence_gap")
      return
    }
    if (h) h.streamSequence = event.sequence
    const sink = h?.outputSink
    const eventGeneration = h?.attachGeneration
    const waitsForOutputAck = typeof h?.attachment?.outputApplied === "function"
    const applied = () => {
      const current = handles.get(terminalId)
      if (!h || current !== h || current.attachGeneration !== eventGeneration) {
        return
      }
      if (waitsForOutputAck) {
        patchSession(set, terminalId, { sequence: event.sequence })
      }
      current.attachment?.outputApplied?.(event.sequence)
    }
    if (h && (!sink || !h.outputSinkReady)) {
      if (
        h.pendingOutputBytes + event.data.byteLength <=
        MAX_PENDING_OUTPUT_BYTES
      ) {
        h.pendingOutput.push(event.data)
        h.pendingOutputBytes += event.data.byteLength
      } else {
        h.pendingOutput = []
        h.pendingOutputBytes = 0
        h.outputBufferOverflowed = true
      }
      applied()
    } else if (sink) {
      sink(event.data, applied)
    } else {
      applied()
    }
    return
  }

  if (event.type === "snapshot") {
    applySnapshot(terminalId, event.snapshot, set, get)
    return
  }

  if (event.type === "statusChanged") {
    // Status events also carry sequence when contiguous.
    if (
      typeof event.sequence === "number" &&
      event.sequence !== streamSequence + 1 &&
      event.sequence !== streamSequence
    ) {
      // Allow same sequence (snapshot boundary) but gap still resyncs.
      if (event.sequence > streamSequence + 1) {
        void actions.retrySnapshot(terminalId, "sequence_gap")
        return
      }
    }
    if (h && typeof event.sequence === "number") {
      h.streamSequence = Math.max(h.streamSequence, event.sequence)
    }
    const nextStatus: TerminalRuntimeStatus =
      event.status === "exited" || event.status === "failed"
        ? "exited"
        : session.status === "attaching"
          ? "connected"
          : session.status
    patchSession(set, terminalId, {
      status: nextStatus,
      sequence:
        typeof event.sequence === "number" && event.sequence > session.sequence
          ? event.sequence
          : session.sequence,
      exitCode: event.exitCode,
      exitedAt: event.exitedAt,
    })
    if (nextStatus === "exited") {
      const h = handles.get(terminalId)
      if (h) {
        h.writeQueue?.clear()
      }
    }
    handles.get(terminalId)?.attachment?.outputApplied?.(event.sequence)
    return
  }

  if (event.type === "historyTruncated") {
    if (h && typeof event.sequence === "number") {
      h.streamSequence = Math.max(h.streamSequence, event.sequence)
    }
    patchSession(set, terminalId, {
      historyTruncated: true,
      sequence:
        typeof event.sequence === "number" && event.sequence > session.sequence
          ? event.sequence
          : session.sequence,
    })
    handles.get(terminalId)?.attachment?.outputApplied?.(event.sequence)
    return
  }

  if (event.type === "removed") {
    if (h && typeof event.sequence === "number") {
      h.streamSequence = Math.max(h.streamSequence, event.sequence)
    }
    if (typeof event.sequence === "number") {
      handles.get(terminalId)?.attachment?.outputApplied?.(event.sequence)
    }
    clearStaleTerminal(terminalId, set)
    return
  }

  if (event.type === "resyncRequired") {
    void actions.retrySnapshot(terminalId, "resync_required")
  }
}

async function runEventLoop(
  terminalId: string,
  attachment: TerminalAttachment,
  generation: number,
  get: () => TerminalRuntimeState,
  set: (
    partial:
      | Partial<TerminalRuntimeState>
      | ((s: TerminalRuntimeState) => Partial<TerminalRuntimeState>)
  ) => void,
  actions: {
    retrySnapshot: (terminalId: string, reason?: string) => Promise<void>
  }
): Promise<void> {
  const h = ensureHandles(terminalId)
  try {
    for await (const event of attachment.events) {
      if (h.attachGeneration !== generation) return
      if (!getSession(get, terminalId)) return
      applyEvent(terminalId, event, get, set, actions)
    }
  } catch (err) {
    if (h.attachGeneration !== generation) return
    const code = errorCode(err)
    if (code === "terminal_not_found" || code === "terminal_instance_expired") {
      clearStaleTerminal(terminalId, set)
      return
    }
    const terminalStatus = mapAsyncTerminalErrorStatus(code)
    if (terminalStatus) {
      const message =
        extractAppCommandError(err)?.message ??
        (err instanceof Error ? err.message : String(code))
      patchSession(set, terminalId, {
        status: terminalStatus,
        errorMessage: message,
      })
      h.writeQueue?.clear()
      return
    }
    // Stream failure → disconnected overlay; keep last screen.
    patchSession(set, terminalId, {
      status: "disconnected",
    })
    h.writeQueue?.clear()
  }
}

export const useTerminalRuntimeStore = create<TerminalRuntimeState>(
  (set, get) => {
    const actions = {
      retrySnapshot: async (terminalId: string, reason?: string) => {
        const session = getSession(get, terminalId)
        if (!session) return
        // Avoid tight loops while already attaching.
        if (session.status === "attaching" && reason !== "sequence_gap") {
          patchSession(set, terminalId, {
            lastResyncReason: reason ?? "retry",
          })
          return
        }
        patchSession(set, terminalId, {
          lastResyncReason: reason ?? "retry",
          status:
            session.status === "exited" ||
            session.status === "expired" ||
            session.status === "cleared"
              ? session.status
              : "attaching",
        })
        await get().attachTerminal(terminalId)
      },
    }

    return {
      sessions: {},
      clientId: randomUUID(),
      clientLabel: defaultClientLabel(),

      attachTerminal: async (
        terminalId: string,
        options?: { freshSnapshot?: boolean }
      ) => {
        if (!terminalId) return

        const existing = getSession(get, terminalId)
        // Deep-link placeholders (restarted / LRU-cleared) must not attach or
        // clobber status via a live snapshot from a reused/mismatched process.
        if (existing?.status === "expired" || existing?.status === "cleared") {
          return
        }
        const existingHandles = handles.get(terminalId)
        // The cached snapshot predates output a previous view already consumed,
        // so a newly mounted xterm needs a fresh one.
        if (
          existingHandles?.attachment &&
          existing?.status === "connected" &&
          !options?.freshSnapshot
        ) {
          return
        }

        if (!existing) {
          set((state) => ({
            sessions: {
              ...state.sessions,
              [terminalId]: emptySession(terminalId),
            },
          }))
        } else {
          patchSession(set, terminalId, {
            status:
              existing.status === "exited" ? existing.status : "attaching",
            errorMessage: null,
          })
        }

        // Tear down prior attach for this terminal (reattach path).
        stopSessionLoop(terminalId, set)
        const h = ensureHandles(terminalId)
        const generation = h.attachGeneration
        const abort = new AbortController()
        h.eventLoopAbort = abort

        try {
          const stream = await resolveTerminalStream()
          if (h.attachGeneration !== generation) return

          // Re-check after await: deep-link may have marked expired/cleared.
          const latest = getSession(get, terminalId)
          if (latest?.status === "expired" || latest?.status === "cleared") {
            return
          }

          const previousDetach = pendingDetaches.get(terminalId)
          if (previousDetach) {
            await previousDetach
            if (h.attachGeneration !== generation) return
          }

          const { clientId, clientLabel } = get()
          const attachment = await stream.attach({
            terminalId,
            clientId,
            clientLabel,
          })
          if (h.attachGeneration !== generation) {
            void attachment.detach().catch(() => {})
            return
          }

          // Final guard before applying a live snapshot.
          const still = getSession(get, terminalId)
          if (still?.status === "expired" || still?.status === "cleared") {
            void attachment.detach().catch(() => {})
            return
          }

          h.attachment = attachment
          // Drop any write queue from the previous attachment; rebuild on demand.
          disposeWriteQueue(h)
          applySnapshot(terminalId, attachment.snapshot, set, get)

          // If the process is already exited, stay on the final snapshot.
          if (
            attachment.snapshot.status === "exited" ||
            attachment.snapshot.status === "failed"
          ) {
            void runEventLoop(
              terminalId,
              attachment,
              generation,
              get,
              set,
              actions
            )
            return
          }

          void runEventLoop(
            terminalId,
            attachment,
            generation,
            get,
            set,
            actions
          )
        } catch (err) {
          if (h.attachGeneration !== generation) return
          const code = errorCode(err)
          if (
            code === "terminal_not_found" ||
            code === "terminal_instance_expired"
          ) {
            clearStaleTerminal(terminalId, set)
            return
          }
          const status = mapAttachErrorStatus(err)
          const message = toErrorMessage(err) || "attach failed"
          patchSession(set, terminalId, {
            status,
            errorMessage: message,
          })
        }
      },

      detachTerminal: async (terminalId: string) => {
        const h = handles.get(terminalId)
        stopSessionLoop(terminalId, set)
        if (h) {
          h.outputSink = null
        }
        handles.delete(terminalId)
        set((state) => {
          if (!(terminalId in state.sessions)) return state
          const next = { ...state.sessions }
          delete next[terminalId]
          return { sessions: next }
        })
      },

      sendInput: (terminalId: string, data: Uint8Array | string) => {
        const session = getSession(get, terminalId)
        if (!session) return
        if (session.status !== "connected") return
        const text = bytesToString(data)
        if (!text) return
        const queue = ensureWriteQueue(terminalId, get, set)
        queue.enqueue(text)
      },

      pasteText: async (terminalId, text, options) => {
        const tabState = useTabStore.getState()
        const tab = tabState.tabs.find(
          (candidate) => candidate.id === options.tabId
        )
        // Target must still be the active terminal tab (identity fence).
        if (
          tabState.activeTabId !== options.tabId ||
          !tab ||
          tab.kind !== "terminal" ||
          tab.terminalId !== terminalId
        ) {
          return { ok: false, reason: "target-changed" }
        }
        // Prefer live session backend; fall back to tab snapshot. Empty option
        // backend is treated as "use tab" so callers with stale empty ids work.
        const optionBackend = options.backendInstanceId || tab.backendInstanceId
        if (
          optionBackend &&
          tab.backendInstanceId &&
          optionBackend !== tab.backendInstanceId
        ) {
          return { ok: false, reason: "backend-mismatch" }
        }

        let session = getSession(get, terminalId)
        // Tab is active but runtime not attached yet (cold open / race) — attach.
        // Use get().attachTerminal (store method); local `actions` only holds
        // retrySnapshot helpers and does not include attachTerminal.
        if (!session) {
          await get().attachTerminal(terminalId)
          session = getSession(get, terminalId)
        }
        if (!session) return { ok: false, reason: "missing" }
        if (
          session.backendInstanceId &&
          optionBackend &&
          session.backendInstanceId !== optionBackend
        ) {
          return { ok: false, reason: "backend-mismatch" }
        }
        if (session.status !== "connected") {
          return { ok: false, reason: "disconnected" }
        }

        const sanitized = sanitizeTerminalPaste(text)
        if (!sanitized) return { ok: false, reason: "unsupported" }

        const handle = handles.get(terminalId)
        const adapter = handle?.surfacePasteAdapter
        if (adapter) {
          // Prefer xterm paste (bracketed-paste aware) when the surface is up.
          if (adapter(sanitized) === false) {
            return { ok: false, reason: "unsafe-multiline" }
          }
          return { ok: true }
        }

        // Fallback: files maximized / view not mounted — still write to PTY.
        // 裸写 PTY 没有 bracketed paste 包裹，换行即回车：只放行单行。
        if (sanitized.includes("\n")) {
          return { ok: false, reason: "unsafe-multiline" }
        }
        ensureWriteQueue(terminalId, get, set).enqueue(sanitized)
        return { ok: true }
      },

      resize: (terminalId: string, rows: number, cols: number) => {
        const session = getSession(get, terminalId)
        const h = handles.get(terminalId)
        const attachment = h?.attachment
        if (!session || !h || !attachment) {
          return Promise.resolve(null)
        }
        if (session.status !== "connected") return Promise.resolve(null)
        if (rows < 1 || cols < 1) return Promise.resolve(null)

        return new Promise<TerminalSnapshot | null>((resolve) => {
          const existing = pendingResizes.get(terminalId)
          if (existing) {
            existing.rows = rows
            existing.cols = cols
            existing.generation = h.attachGeneration
            existing.waiters.push(resolve)
          } else {
            pendingResizes.set(terminalId, {
              rows,
              cols,
              generation: h.attachGeneration,
              waiters: [resolve],
            })
            // Same-tick storms collapse to one sequence/SIGWINCH.
            queueMicrotask(() => {
              void pumpPendingResizes(terminalId, get, set)
            })
          }
        })
      },

      retrySnapshot: (terminalId: string, reason?: string) =>
        actions.retrySnapshot(terminalId, reason),

      acknowledgeOutput: (
        terminalId: string,
        sequence: number,
        expectedGeneration?: number
      ) => {
        const h = handles.get(terminalId)
        if (
          !h ||
          (expectedGeneration !== undefined &&
            h.attachGeneration !== expectedGeneration)
        ) {
          return
        }
        h.attachment?.outputApplied?.(sequence)
      },

      setOutputSink: (terminalId: string, sink: TerminalOutputSink | null) => {
        const h = ensureHandles(terminalId)
        h.outputSink = sink
        h.outputSinkReady = false
        return () => {
          const current = handles.get(terminalId)
          if (current?.outputSink !== sink) return
          current.outputSink = null
          current.outputSinkReady = false
        }
      },

      setSurfacePasteAdapter: (terminalId, adapter) => {
        const handle = ensureHandles(terminalId)
        handle.surfacePasteAdapter = adapter
        return () => {
          const current = handles.get(terminalId)
          if (current?.surfacePasteAdapter === adapter) {
            current.surfacePasteAdapter = null
          }
        }
      },

      beginSnapshotPaint: (terminalId: string, expectedGeneration?: number) => {
        const h = handles.get(terminalId)
        if (
          h &&
          (expectedGeneration === undefined ||
            h.attachGeneration === expectedGeneration)
        ) {
          h.outputSinkReady = false
        }
      },

      activateOutputSink: (terminalId: string, expectedGeneration?: number) => {
        const h = handles.get(terminalId)
        const sink = h?.outputSink
        if (
          !h ||
          !sink ||
          (expectedGeneration !== undefined &&
            h.attachGeneration !== expectedGeneration)
        ) {
          return
        }
        if (h.outputBufferOverflowed) {
          h.outputBufferOverflowed = false
          h.pendingOutput = []
          h.pendingOutputBytes = 0
          void actions.retrySnapshot(terminalId, "hidden_output_overflow")
          return
        }
        const total = h.pendingOutputBytes
        const buffered = new Uint8Array(total)
        let offset = 0
        for (const chunk of h.pendingOutput) {
          buffered.set(chunk, offset)
          offset += chunk.byteLength
        }
        h.pendingOutput = []
        h.pendingOutputBytes = 0
        h.outputSinkReady = true
        if (buffered.byteLength > 0) sink(buffered, () => {})
      },

      showInstanceExpired: (terminalId: string) => {
        clearStaleTerminal(terminalId, set)
      },

      showCleared: (terminalId: string) => {
        clearStaleTerminal(terminalId, set)
      },

      markTransportDisconnected: () => {
        const { sessions } = get()
        const next: Record<string, TerminalRuntimeSession> = {}
        for (const [id, session] of Object.entries(sessions)) {
          if (
            session.status === "exited" ||
            session.status === "expired" ||
            session.status === "cleared"
          ) {
            next[id] = session
            continue
          }
          const h = handles.get(id)
          if (h) {
            h.writeQueue?.clear()
            // Drop attachment without full detach RPC — transport is dead.
            h.attachment = null
            h.attachGeneration = allocateAttachmentGeneration()
            resetOutputGateForNewAttachment(h)
            h.eventLoopAbort?.abort()
            h.eventLoopAbort = null
          }
          next[id] = {
            ...session,
            status: "disconnected",
            attachmentGeneration:
              h?.attachGeneration ?? session.attachmentGeneration,
          }
        }
        set({ sessions: next })
      },

      reattachAfterReconnect: async () => {
        const ids = Object.keys(get().sessions).filter((id) => {
          const s = get().sessions[id]
          return (
            s &&
            s.status !== "exited" &&
            s.status !== "expired" &&
            s.status !== "cleared"
          )
        })
        await Promise.all(ids.map((id) => get().attachTerminal(id)))
      },

      reset: () => {
        for (const id of [...handles.keys()]) {
          stopSessionLoop(id)
          handles.delete(id)
        }
        clearAllPendingResizes()
        streamCache = null
        set({
          sessions: {},
          clientId: randomUUID(),
          clientLabel: defaultClientLabel(),
        })
      },
    }
  }
)

/** Stable action bag for components that should not re-render on session churn. */
export function getTerminalRuntimeActions(): Pick<
  TerminalRuntimeState,
  | "attachTerminal"
  | "detachTerminal"
  | "sendInput"
  | "pasteText"
  | "resize"
  | "retrySnapshot"
  | "acknowledgeOutput"
  | "setOutputSink"
  | "setSurfacePasteAdapter"
  | "beginSnapshotPaint"
  | "activateOutputSink"
  | "showInstanceExpired"
  | "showCleared"
  | "markTransportDisconnected"
  | "reattachAfterReconnect"
  | "reset"
> {
  const s = useTerminalRuntimeStore.getState()
  return {
    attachTerminal: s.attachTerminal,
    detachTerminal: s.detachTerminal,
    sendInput: s.sendInput,
    pasteText: s.pasteText,
    resize: s.resize,
    retrySnapshot: s.retrySnapshot,
    acknowledgeOutput: s.acknowledgeOutput,
    setOutputSink: s.setOutputSink,
    setSurfacePasteAdapter: s.setSurfacePasteAdapter,
    beginSnapshotPaint: s.beginSnapshotPaint,
    activateOutputSink: s.activateOutputSink,
    showInstanceExpired: s.showInstanceExpired,
    showCleared: s.showCleared,
    markTransportDisconnected: s.markTransportDisconnected,
    reattachAfterReconnect: s.reattachAfterReconnect,
    reset: s.reset,
  }
}

/** Selector helper for a single session (undefined when not attached). */
export function selectTerminalSession(
  terminalId: string
): (state: TerminalRuntimeState) => TerminalRuntimeSession | undefined {
  return (state) => state.sessions[terminalId]
}

export function resetTerminalRuntimeStore(): void {
  useTerminalRuntimeStore.getState().reset()
}

registerBackendScopedStoreReset(resetTerminalRuntimeStore)

// Re-export stream status for consumers that only need the wire enum.
export type { StreamTerminalStatus }
