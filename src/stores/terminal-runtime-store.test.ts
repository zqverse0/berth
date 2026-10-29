import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  TerminalAttachment,
  TerminalSnapshot,
  TerminalStream,
  TerminalStreamEvent,
} from "@/lib/terminal/terminal-stream"
import {
  __setTerminalStreamForTests,
  resetTerminalRuntimeStore,
  useTerminalRuntimeStore,
} from "./terminal-runtime-store"
import { useTabStore } from "./tab-store"

const bytes = (text: string) => new TextEncoder().encode(text)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function snapshot(terminalId: string): TerminalSnapshot {
  return {
    terminalId,
    backendInstanceId: "backend-test",
    sequence: 10,
    rows: 24,
    cols: 80,
    ansi: bytes("prompt> "),
    historyTruncated: false,
    status: "running",
    exitCode: null,
    exitedAt: null,
    lastKnownCwd: "/tmp",
  }
}

function fakeStream(withOutputAck = true) {
  const writes: Array<{ sequence: number; data: string }> = []
  const resizes: Array<{ sequence: number; rows: number; cols: number }> = []
  const applied: number[] = []
  const attachments: Array<{
    push: (event: TerminalStreamEvent) => void
    detachCalls: number
  }> = []

  const stream: TerminalStream = {
    async attach(input) {
      const queue: TerminalStreamEvent[] = []
      const waiters: Array<
        (result: IteratorResult<TerminalStreamEvent>) => void
      > = []
      let detached = false
      const state = {
        push(event: TerminalStreamEvent) {
          const waiter = waiters.shift()
          if (waiter) waiter({ value: event, done: false })
          else queue.push(event)
        },
        detachCalls: 0,
      }
      attachments.push(state)
      const attachment: TerminalAttachment = {
        snapshot: snapshot(input.terminalId),
        events: {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                const event = queue.shift()
                if (event) return Promise.resolve({ value: event, done: false })
                if (detached) {
                  return Promise.resolve({
                    value: undefined as never,
                    done: true,
                  })
                }
                return new Promise((resolve) => waiters.push(resolve))
              },
            }
          },
        },
        async write(sequence, data) {
          writes.push({
            sequence,
            data: new TextDecoder().decode(data),
          })
        },
        async resize(sequence, rows, cols) {
          resizes.push({ sequence, rows, cols })
          return { ...snapshot(input.terminalId), rows, cols }
        },
        async detach() {
          state.detachCalls += 1
          detached = true
          for (const waiter of waiters.splice(0)) {
            waiter({ value: undefined as never, done: true })
          }
        },
      }
      if (withOutputAck) {
        attachment.outputApplied = (sequence) => {
          applied.push(sequence)
        }
      }
      return attachment
    },
  }
  return { stream, writes, resizes, applied, attachments }
}

beforeEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
  useTabStore.setState({ tabs: [] })
})

afterEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
})

describe("terminal-runtime-store personal console", () => {
  it("re-attaches after the host reports the attachment disconnected", async () => {
    // 第二道防线：订阅被拆后 resize 返回 transport_disconnected，不能永远停在断开。
    const fake = fakeStream()
    let attachCalls = 0
    const stream: TerminalStream = {
      async attach(input) {
        attachCalls += 1
        const attachment = await fake.stream.attach(input)
        if (attachCalls === 1) {
          attachment.resize = async () => {
            throw {
              code: "terminal_transport_disconnected",
              message: "attachment is no longer subscribed",
            }
          }
        }
        return attachment
      },
    }
    __setTerminalStreamForTests(stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    await actions.resize("t1", 30, 100)
    for (let i = 0; i < 5; i += 1) await tick()

    expect(attachCalls).toBe(2)
    expect(useTerminalRuntimeStore.getState().sessions.t1?.status).toBe(
      "connected"
    )
  })

  it("re-attaches when a lost input sequence makes later writes out of order", async () => {
    // 某个序号没被宿主接收后，之后每次写入都乱序：不能一直失败到刷新页面。
    const fake = fakeStream()
    let attachCalls = 0
    const stream: TerminalStream = {
      async attach(input) {
        attachCalls += 1
        const attachment = await fake.stream.attach(input)
        if (attachCalls === 1) {
          attachment.write = async () => {
            throw { code: "input_out_of_order", message: "out of order" }
          }
        }
        return attachment
      },
    }
    __setTerminalStreamForTests(stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.sendInput("t1", "a")
    for (let i = 0; i < 5; i += 1) await tick()

    expect(attachCalls).toBe(2)
    expect(useTerminalRuntimeStore.getState().sessions.t1?.status).toBe(
      "connected"
    )
  })

  it("waits for the previous detach before re-attaching the same client", async () => {
    // Host 按 client id 拆订阅：旧 detach 晚于新 attach 落地会拆掉新订阅。
    const fake = fakeStream()
    let releaseDetach!: () => void
    const detachHeld = new Promise<void>((resolve) => {
      releaseDetach = resolve
    })
    let attachCalls = 0
    const stream: TerminalStream = {
      async attach(input) {
        attachCalls += 1
        const attachment = await fake.stream.attach(input)
        const detach = attachment.detach.bind(attachment)
        attachment.detach = async () => {
          await detachHeld
          await detach()
        }
        return attachment
      },
    }
    __setTerminalStreamForTests(stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    const retry = actions.retrySnapshot("t1", "resync_required")
    await tick()
    expect(attachCalls).toBe(1)

    releaseDetach()
    await retry
    expect(attachCalls).toBe(2)
    expect(useTerminalRuntimeStore.getState().sessions.t1?.status).toBe(
      "connected"
    )
  })

  it("accepts input immediately without a control handshake", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.sendInput("t1", "a")
    actions.sendInput("t1", "b")
    await tick()

    expect(fake.writes.map((write) => write.data).join("")).toBe("ab")
    expect(fake.writes.map((write) => write.sequence)).toEqual([1, 2])
  })

  it("forwards raw terminal control sequences unchanged", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.sendInput("t1", "\x1b[A")
    await tick()

    expect(fake.writes.map((write) => write.data).join("")).toBe("\x1b[A")
  })

  it("keeps the backend detail when attach fails", async () => {
    const fake = fakeStream()
    fake.stream.attach = async () => {
      throw new Error(
        JSON.stringify({
          code: "task_execution_failed",
          message: "Failed to create terminal session",
          detail: "upgrade and restart the berth daemon",
        })
      )
    }
    __setTerminalStreamForTests(fake.stream)

    await useTerminalRuntimeStore.getState().attachTerminal("t1")

    expect(useTerminalRuntimeStore.getState().sessions.t1).toMatchObject({
      status: "degraded",
      errorMessage: "upgrade and restart the berth daemon",
    })
  })

  it("uses one operation sequence for writes and resizes", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.sendInput("t1", "x")
    const resizeSnapshot = await actions.resize("t1", 30, 100)
    await tick()

    expect(fake.writes[0]?.sequence).toBe(1)
    expect(fake.resizes).toEqual([{ sequence: 2, rows: 30, cols: 100 }])
    expect(fake.applied).toContain(10)
    expect(resizeSnapshot).toMatchObject({ rows: 30, cols: 100 })
    expect(
      useTerminalRuntimeStore.getState().sessions.t1?.snapshot
    ).toMatchObject({ rows: 24, cols: 80 })
  })

  it("does not mark a resize acknowledgement as a repaint snapshot", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    const before =
      useTerminalRuntimeStore.getState().sessions.t1?.snapshotRevision
    await actions.resize("t1", 30, 100)

    expect(
      useTerminalRuntimeStore.getState().sessions.t1?.snapshotRevision
    ).toBe(before)
  })

  it("coalesces same-tick resizes to the latest grid with one sequence", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")

    const first = actions.resize("t1", 20, 80)
    const second = actions.resize("t1", 24, 100)
    const third = actions.resize("t1", 30, 120)
    await Promise.all([first, second, third])

    expect(fake.resizes).toEqual([{ sequence: 1, rows: 30, cols: 120 }])
  })

  it("coalesces resizes staged during an in-flight resize into one follow-up", async () => {
    const fake = fakeStream()
    const releaseGates: Array<() => void> = []
    const originalAttach = fake.stream.attach.bind(fake.stream)
    fake.stream.attach = async (input) => {
      const attachment = await originalAttach(input)
      const realResize = attachment.resize.bind(attachment)
      attachment.resize = (sequence, rows, cols) =>
        new Promise((resolve, reject) => {
          releaseGates.push(() => {
            void realResize(sequence, rows, cols).then(resolve, reject)
          })
        })
      return attachment
    }
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")

    const first = actions.resize("t1", 20, 80)
    await tick()
    expect(releaseGates).toHaveLength(1)

    const second = actions.resize("t1", 24, 100)
    const third = actions.resize("t1", 30, 120)
    releaseGates[0]?.()
    await first
    await tick()
    expect(releaseGates).toHaveLength(2)
    releaseGates[1]?.()
    await Promise.all([second, third])

    expect(fake.resizes).toEqual([
      { sequence: 1, rows: 20, cols: 80 },
      { sequence: 2, rows: 30, cols: 120 },
    ])
  })

  it("keeps the attachment alive when only the output view is unbound", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.setOutputSink("t1", vi.fn())
    actions.setOutputSink("t1", null)

    expect(fake.attachments[0]?.detachCalls).toBe(0)
    expect(useTerminalRuntimeStore.getState().sessions.t1).toBeTruthy()
  })

  it("pastes through the current xterm surface after identity fences", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()
    const paste = vi.fn()
    useTabStore.setState({
      activeTabId: "tab-1",
      tabs: [
        {
          kind: "terminal",
          id: "tab-1",
          terminalId: "t1",
          backendInstanceId: "backend-test",
          folderId: null,
          title: "Terminal",
          initialCwd: "/tmp",
          shell: "bash",
          detachedFolderLabel: null,
          detachedFolderPath: null,
          isPinned: false,
        },
      ],
    })

    await actions.attachTerminal("t1")
    actions.setSurfacePasteAdapter("t1", paste)
    await expect(
      actions.pasteText("t1", "a\u0000\r\nb", {
        submit: false,
        source: "document-context",
        tabId: "tab-1",
        backendInstanceId: "backend-test",
      })
    ).resolves.toEqual({ ok: true })
    expect(paste).toHaveBeenCalledOnce()
    expect(paste).toHaveBeenCalledWith("a\nb")
    expect(fake.writes).toHaveLength(0)
  })

  it("keeps a replacement surface registered when the old view unmounts", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()
    const oldPaste = vi.fn()
    const currentPaste = vi.fn()
    useTabStore.setState({
      activeTabId: "tab-1",
      tabs: [
        {
          kind: "terminal",
          id: "tab-1",
          terminalId: "t1",
          backendInstanceId: "backend-test",
          folderId: null,
          title: "Terminal",
          initialCwd: "/tmp",
          shell: "bash",
          detachedFolderLabel: null,
          detachedFolderPath: null,
          isPinned: false,
        },
      ],
    })

    await actions.attachTerminal("t1")
    const disposeOld = actions.setSurfacePasteAdapter("t1", oldPaste)
    actions.setSurfacePasteAdapter("t1", currentPaste)
    disposeOld()

    await expect(
      actions.pasteText("t1", "safe", {
        submit: false,
        source: "document-context",
        tabId: "tab-1",
        backendInstanceId: "backend-test",
      })
    ).resolves.toEqual({ ok: true })
    expect(oldPaste).not.toHaveBeenCalled()
    expect(currentPaste).toHaveBeenCalledWith("safe")
  })

  it("does not let an old view cleanup clear a replacement output sink", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()
    const staleSink = vi.fn((_data: Uint8Array, applied: () => void) => {
      applied()
    })
    const currentSink = vi.fn((_data: Uint8Array, applied: () => void) => {
      applied()
    })

    await actions.attachTerminal("t1")
    const disposeStaleSink = actions.setOutputSink("t1", staleSink)
    actions.activateOutputSink("t1")
    const generation =
      useTerminalRuntimeStore.getState().sessions.t1?.attachmentGeneration

    // A replacement surface binds before React runs the old surface's cleanup.
    const disposeCurrentSink = actions.setOutputSink("t1", currentSink)
    disposeStaleSink()
    actions.activateOutputSink("t1", generation)
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 11,
      sequence: 11,
      data: bytes("current-surface"),
    })
    await tick()

    expect(staleSink).not.toHaveBeenCalled()
    expect(currentSink).toHaveBeenCalledOnce()
    disposeCurrentSink()
  })

  it("rejects changed, disconnected, mismatched, and missing surfaces", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()
    const options = {
      submit: false as const,
      source: "document-context" as const,
      tabId: "tab-1",
      backendInstanceId: "backend-test",
    }

    await actions.attachTerminal("t1")
    expect(await actions.pasteText("t1", "x", options)).toEqual({
      ok: false,
      reason: "target-changed",
    })

    useTabStore.setState({
      activeTabId: "tab-1",
      tabs: [
        {
          kind: "terminal",
          id: "tab-1",
          terminalId: "t1",
          backendInstanceId: "other",
          folderId: null,
          title: "Terminal",
          initialCwd: "/tmp",
          shell: "bash",
          detachedFolderLabel: null,
          detachedFolderPath: null,
          isPinned: false,
        },
      ],
    })
    expect(await actions.pasteText("t1", "x", options)).toEqual({
      ok: false,
      reason: "backend-mismatch",
    })

    useTabStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.kind === "terminal"
          ? { ...tab, backendInstanceId: "backend-test" }
          : tab
      ),
    }))
    // No xterm surface: falls back to write-queue paste (must not fail as unsupported).
    await expect(actions.pasteText("t1", "x", options)).resolves.toEqual({
      ok: true,
    })
    await tick()
    expect(fake.writes.some((w) => w.data.includes("x"))).toBe(true)

    useTabStore.setState({ activeTabId: "another-tab" })
    expect(await actions.pasteText("t1", "x", options)).toEqual({
      ok: false,
      reason: "target-changed",
    })
    useTabStore.setState({ activeTabId: "tab-1" })

    actions.setSurfacePasteAdapter("t1", vi.fn())
    actions.markTransportDisconnected()
    expect(await actions.pasteText("t1", "x", options)).toEqual({
      ok: false,
      reason: "disconnected",
    })
  })

  it("pastes via write queue when surface adapter is missing", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()
    useTabStore.setState({
      activeTabId: "tab-1",
      tabs: [
        {
          kind: "terminal",
          id: "tab-1",
          terminalId: "t1",
          backendInstanceId: "backend-test",
          folderId: null,
          title: "Terminal",
          initialCwd: "/tmp",
          shell: "bash",
          detachedFolderLabel: null,
          detachedFolderPath: null,
          isPinned: false,
        },
      ],
    })
    await actions.attachTerminal("t1")
    // Intentionally no setSurfacePasteAdapter — simulates a hidden surface.
    await expect(
      actions.pasteText("t1", "hello from files", {
        submit: false,
        source: "document-context",
        tabId: "tab-1",
        backendInstanceId: "backend-test",
      })
    ).resolves.toEqual({ ok: true })
  })

  it("never lets a multi-line paste reach the PTY as separate Enter-submitted lines", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()
    useTabStore.setState({
      activeTabId: "tab-1",
      tabs: [
        {
          kind: "terminal",
          id: "tab-1",
          terminalId: "t1",
          backendInstanceId: "backend-test",
          folderId: null,
          title: "Terminal",
          initialCwd: "/tmp",
          shell: "bash",
          detachedFolderLabel: null,
          detachedFolderPath: null,
          isPinned: false,
        },
      ],
    })
    const options = {
      submit: false as const,
      source: "document-context" as const,
      tabId: "tab-1",
      backendInstanceId: "backend-test",
    }
    await actions.attachTerminal("t1")

    // 无界面兜底写 PTY：多行拒绝，单行照常
    expect(await actions.pasteText("t1", "line 1\nline 2", options)).toEqual({
      ok: false,
      reason: "unsafe-multiline",
    })
    await tick()
    expect(fake.writes).toHaveLength(0)
    expect(await actions.pasteText("t1", "one line", options)).toEqual({
      ok: true,
    })

    // 界面在但终端未开 bracketed paste：adapter 拒绝
    actions.setSurfacePasteAdapter("t1", () => false)
    expect(await actions.pasteText("t1", "a\nb", options)).toEqual({
      ok: false,
      reason: "unsafe-multiline",
    })
  })

  it("reuses the live attachment when a terminal view mounts again", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.setOutputSink("t1", null)
    await actions.attachTerminal("t1")

    expect(fake.attachments).toHaveLength(1)
    expect(fake.attachments[0]?.detachCalls).toBe(0)
  })

  it("publishes a newer attachment generation after reconnect", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    const firstGeneration =
      useTerminalRuntimeStore.getState().sessions.t1?.attachmentGeneration ?? 0

    actions.markTransportDisconnected()
    const disconnectedGeneration =
      useTerminalRuntimeStore.getState().sessions.t1?.attachmentGeneration ?? 0
    await actions.reattachAfterReconnect()
    const reattachedGeneration =
      useTerminalRuntimeStore.getState().sessions.t1?.attachmentGeneration ?? 0

    expect(disconnectedGeneration).toBeGreaterThan(firstGeneration)
    expect(reattachedGeneration).toBeGreaterThan(disconnectedGeneration)
    expect(fake.attachments).toHaveLength(2)
  })

  it("does not return an in-flight resize from an old attachment", async () => {
    const fake = fakeStream()
    const releaseResize: Array<() => void> = []
    const originalAttach = fake.stream.attach.bind(fake.stream)
    fake.stream.attach = async (input) => {
      const attachment = await originalAttach(input)
      if (fake.attachments.length === 1) {
        const originalResize = attachment.resize.bind(attachment)
        attachment.resize = (sequence, rows, cols) =>
          new Promise<TerminalSnapshot>((resolve) => {
            releaseResize.push(() => {
              void originalResize(sequence, rows, cols).then(resolve)
            })
          })
      }
      return attachment
    }
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    const staleResize = actions.resize("t1", 30, 120)
    await tick()
    expect(releaseResize).toHaveLength(1)

    actions.markTransportDisconnected()
    await actions.reattachAfterReconnect()
    releaseResize.shift()?.()

    await expect(staleResize).resolves.toBeNull()
    expect(useTerminalRuntimeStore.getState().sessions.t1?.snapshot?.rows).toBe(
      24
    )
  })

  it("drops buffered output when a new attachment starts", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const painted: string[] = []
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.setOutputSink("t1", (data, applied) => {
      painted.push(new TextDecoder().decode(data))
      applied()
    })
    actions.activateOutputSink("t1")
    actions.beginSnapshotPaint("t1")
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 11,
      sequence: 11,
      data: bytes("old-attachment"),
    })
    await tick()

    actions.markTransportDisconnected()
    await actions.reattachAfterReconnect()
    actions.activateOutputSink("t1")

    expect(painted).not.toContain("old-attachment")
  })

  it("applies contiguous output through the current view sink", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const sink = vi.fn((_data: Uint8Array, applied: () => void) => applied())
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.setOutputSink("t1", sink)
    actions.activateOutputSink("t1")
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 11,
      sequence: 11,
      data: bytes("ready"),
    })
    await tick()

    expect(sink).toHaveBeenCalledOnce()
    expect(useTerminalRuntimeStore.getState().sessions.t1?.sequence).toBe(11)
  })

  it("keeps live sequence outside Zustand for ack-less desktop output", async () => {
    const fake = fakeStream(false)
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.setOutputSink("t1", () => {})
    actions.activateOutputSink("t1")
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 11,
      sequence: 11,
      data: bytes("desktop-output"),
    })
    await tick()

    expect(useTerminalRuntimeStore.getState().sessions.t1?.sequence).toBe(10)
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 12,
      sequence: 12,
      data: bytes("next-output"),
    })
    await tick()
    expect(useTerminalRuntimeStore.getState().sessions.t1?.sequence).toBe(10)
  })

  it("keeps runtime output parked until snapshot painting is activated", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const sink = vi.fn((_data: Uint8Array, applied: () => void) => applied())
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    actions.setOutputSink("t1", sink)
    actions.activateOutputSink("t1")
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 11,
      sequence: 11,
      data: bytes("before"),
    })
    await tick()

    actions.beginSnapshotPaint("t1")
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 12,
      sequence: 12,
      data: bytes("during"),
    })
    await tick()

    expect(sink).toHaveBeenCalledOnce()
    actions.activateOutputSink("t1")
    expect(sink).toHaveBeenCalledTimes(2)
    expect(
      new TextDecoder().decode(sink.mock.calls[1]?.[0] ?? new Uint8Array())
    ).toBe("during")
  })

  it("replays output received while the terminal view was hidden", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    fake.attachments[0]?.push({
      type: "output",
      terminalId: "t1",
      sequenceStart: 11,
      sequence: 11,
      data: bytes("while-hidden"),
    })
    await tick()

    const painted: string[] = []
    actions.setOutputSink("t1", (data, applied) => {
      painted.push(new TextDecoder().decode(data))
      applied()
    })
    actions.activateOutputSink("t1")

    expect(painted).toEqual(["while-hidden"])
  })

  it("explicit detach removes the runtime session", async () => {
    const fake = fakeStream()
    __setTerminalStreamForTests(fake.stream)
    const actions = useTerminalRuntimeStore.getState()

    await actions.attachTerminal("t1")
    await actions.detachTerminal("t1")

    expect(fake.attachments[0]?.detachCalls).toBe(1)
    expect(useTerminalRuntimeStore.getState().sessions.t1).toBeUndefined()
  })
})
