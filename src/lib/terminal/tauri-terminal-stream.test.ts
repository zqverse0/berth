import { describe, expect, it, vi } from "vitest"
import type { Transport } from "@/lib/transport/types"
import type { TerminalStreamEvent } from "./terminal-stream"
import { TauriTerminalStream } from "./tauri-terminal-stream"

type FakeChannel = {
  onmessage: ((packet: unknown) => void) | null
}

const channelState = vi.hoisted(() => ({
  channels: [] as FakeChannel[],
}))

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((packet: unknown) => void) | null = null

    constructor() {
      channelState.channels.push(this)
    }
  },
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function snapshotWire(sequence: number) {
  return {
    terminalId: "t1",
    backendInstanceId: "b1",
    sequence,
    rows: 24,
    cols: 80,
    ansiBase64: "",
    historyTruncated: false,
    status: "running" as const,
    exitCode: null,
    exitedAt: null,
    lastKnownCwd: null,
  }
}

function outputPacket(sequence: number, text: string): Uint8Array {
  const data = new TextEncoder().encode(text)
  const packet = new Uint8Array(20 + data.byteLength)
  packet[0] = 0x54
  packet[1] = 0x56
  packet[2] = 2
  packet[3] = 1
  const view = new DataView(packet.buffer)
  view.setBigUint64(4, BigInt(sequence))
  view.setBigUint64(12, BigInt(sequence))
  packet.set(data, 20)
  return packet
}

describe("TauriTerminalStream resize barrier", () => {
  it("delivers live output after the attach snapshot boundary", async () => {
    channelState.channels.length = 0
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          return snapshotWire(7)
        }
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport

    const attachment = await new TauriTerminalStream(transport).attach({
      terminalId: "t1",
      clientId: "c1",
      clientLabel: "test",
    })
    const channel = channelState.channels[0]
    expect(channel).toBeDefined()

    const nextEvent = attachment.events[Symbol.asyncIterator]().next()
    channel.onmessage?.(outputPacket(8, "live-output"))

    const event = await nextEvent
    expect(event.done).toBe(false)
    expect(event.value).toMatchObject({
      type: "output",
      sequenceStart: 8,
      sequence: 8,
    })
    expect(Array.from(event.value.data)).toEqual(
      Array.from(new TextEncoder().encode("live-output"))
    )

    await attachment.detach()
  })

  it("forwards a future packet and leaves gap handling to the runtime", async () => {
    channelState.channels.length = 0
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          return snapshotWire(7)
        }
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport

    const attachment = await new TauriTerminalStream(transport).attach({
      terminalId: "t1",
      clientId: "c1",
      clientLabel: "test",
    })
    const channel = channelState.channels[0]
    expect(channel).toBeDefined()

    const nextEvent = attachment.events[Symbol.asyncIterator]().next()
    channel.onmessage?.(outputPacket(9, "gap"))

    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: {
        type: "output",
        sequenceStart: 9,
        sequence: 9,
      },
    })

    await attachment.detach()
  })

  it("parks output while resize waits behind an earlier input operation", async () => {
    channelState.channels.length = 0
    const writeGate = deferred<void>()
    const resizeGate = deferred<void>()
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          return snapshotWire(0)
        }
        if (command === "terminal_resize_attached") {
          await resizeGate.promise
          return snapshotWire(1)
        }
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw(command: string) {
        if (command !== "terminal_write_attached_raw") {
          throw new Error(`unexpected raw call: ${command}`)
        }
        await writeGate.promise
      },
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport

    const attachment = await new TauriTerminalStream(transport).attach({
      terminalId: "t1",
      clientId: "c1",
      clientLabel: "test",
    })
    const channel = channelState.channels[0]
    expect(channel).toBeDefined()

    const iterator = attachment.events[Symbol.asyncIterator]()
    const nextEvent = iterator.next()
    const write = attachment.write(1, new TextEncoder().encode("input"))
    const resize = attachment.resize(2, 24, 80)

    channel.onmessage?.(outputPacket(1, "output-before-resize"))
    await Promise.resolve()
    const beforeResizeCompletes = await Promise.race([
      nextEvent.then(() => "event"),
      Promise.resolve("idle"),
    ])
    expect(beforeResizeCompletes).toBe("idle")

    writeGate.resolve()
    await write
    resizeGate.resolve()
    await resize

    // T1: resize ack is a visible-only geometry barrier, not a content
    // boundary — the byte parked behind it must be delivered (runtime's
    // sequence-gap check stays the defensive line), not absorbed.
    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: {
        type: "output",
        sequenceStart: 1,
        sequence: 1,
      },
    })

    await attachment.detach()
    expect((await iterator.next()).done).toBe(true)
  })

  it("requests resync when resize output exceeds the bounded buffer", async () => {
    channelState.channels.length = 0
    const resizeGate = deferred<void>()
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          return snapshotWire(0)
        }
        if (command === "terminal_resize_attached") {
          await resizeGate.promise
          return snapshotWire(1)
        }
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport

    const attachment = await new TauriTerminalStream(transport).attach({
      terminalId: "t1",
      clientId: "c1",
      clientLabel: "test",
    })
    const channel = channelState.channels[0]
    expect(channel).toBeDefined()

    const nextEvent = attachment.events[Symbol.asyncIterator]().next()
    const resize = attachment.resize(1, 24, 80)
    for (let sequence = 1; sequence <= 257; sequence += 1) {
      channel.onmessage?.(outputPacket(sequence, "x"))
    }
    resizeGate.resolve()
    await resize

    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: {
        type: "resyncRequired",
      },
    })

    await attachment.detach()
  })

  it("delivers live output buffered while a resize was in flight", async () => {
    // T1 核心回归:resize RPC 在途时 output worker 独立推送的 live 包被
    // 缓入 duringResize;RPC 返回后这些包必须交付(转发或显式 resync),
    // 不能被"sequence <= 水位"静默吞掉——resize 快照是 visible-only,
    // 不承载这些字节,丢弃即永久丢失。
    channelState.channels.length = 0
    const resizeGate = deferred<void>()
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          return snapshotWire(0)
        }
        if (command === "terminal_resize_attached") {
          await resizeGate.promise
          // RPC 时点 daemon ring 水位 = 3:包 1-3 已入 ring,但它们的
          // 字节未必落在 visible 窗口(scrollback 行会被 reflow 掉)。
          return snapshotWire(3)
        }
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport

    const attachment = await new TauriTerminalStream(transport).attach({
      terminalId: "t1",
      clientId: "c1",
      clientLabel: "test",
    })
    const channel = channelState.channels[0]
    expect(channel).toBeDefined()

    const iterator = attachment.events[Symbol.asyncIterator]()
    const first = iterator.next()
    const resize = attachment.resize(1, 24, 80)
    channel.onmessage?.(outputPacket(1, "before"))
    channel.onmessage?.(outputPacket(2, "during"))
    channel.onmessage?.(outputPacket(3, "resize"))
    resizeGate.resolve()
    await resize

    const event = await first
    const delivered = event.value
    expect(delivered).toBeDefined()
    expect(
      delivered.type === "output" || delivered.type === "resyncRequired"
    ).toBe(true)
    if (delivered.type === "output") {
      // 转发路径:缓冲包被原样交付,内容由 runtime 判定。
      expect(delivered.data.byteLength).toBeGreaterThan(0)
    }

    await attachment.detach()
  })

  it("delivers output produced after a completed resize without a gap", async () => {
    // resize 完成后水位(2)之后产出的包必须原样交付。
    channelState.channels.length = 0
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          return snapshotWire(0)
        }
        if (command === "terminal_resize_attached") {
          return snapshotWire(2)
        }
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport

    const attachment = await new TauriTerminalStream(transport).attach({
      terminalId: "t1",
      clientId: "c1",
      clientLabel: "test",
    })
    const channel = channelState.channels[0]
    const iterator = attachment.events[Symbol.asyncIterator]()
    const first = iterator.next()
    await attachment.resize(1, 24, 80)
    // RPC 返回后 worker 才推送的新输出(水位 2 之后)。
    channel.onmessage?.(outputPacket(3, "after"))

    await expect(first).resolves.toMatchObject({
      done: false,
      value: {
        type: "output",
        sequenceStart: 3,
        sequence: 3,
      },
    })

    await attachment.detach()
  })

  it("keeps buffered resize-window output contiguous for the runtime cursor", async () => {
    // T1 组合回归(adapter × runtime 消费判定):attach 快照 seq 0 →
    // runtime streamSequence = 0;resize 在途,worker 推包 1、2;resize
    // 返回水位 2。适配器必须按 1、2 顺序交付,runtime 的
    // `sequenceStart === streamSequence + 1` 检查逐包通过,不触发
    // sequence_gap resync。
    channelState.channels.length = 0
    const resizeGate = deferred<void>()
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          return snapshotWire(0)
        }
        if (command === "terminal_resize_attached") {
          await resizeGate.promise
          return snapshotWire(2)
        }
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport

    const attachment = await new TauriTerminalStream(transport).attach({
      terminalId: "t1",
      clientId: "c1",
      clientLabel: "test",
    })
    const channel = channelState.channels[0]
    const iterator = attachment.events[Symbol.asyncIterator]()
    const resize = attachment.resize(1, 24, 80)
    channel.onmessage?.(outputPacket(1, "a"))
    channel.onmessage?.(outputPacket(2, "b"))
    resizeGate.resolve()
    await resize

    // runtime 消费侧的连续性判定(terminal-runtime-store applyEvent):
    let streamSequence = 0
    const received: number[] = []
    const drain = async (
      event: IteratorResult<TerminalStreamEvent, undefined>
    ) => {
      if (event.done || event.value.type !== "output") {
        throw new Error(
          `expected output event, got ${JSON.stringify(event.value?.type)}`
        )
      }
      const start = event.value.sequenceStart ?? event.value.sequence
      // 任何 gap 都应触发 resync 而不是静默跳过——断言严格连续。
      expect(start).toBe(streamSequence + 1)
      streamSequence = event.value.sequence
      received.push(streamSequence)
    }
    await drain(await iterator.next())
    await drain(await iterator.next())
    expect(received).toEqual([1, 2])

    await attachment.detach()
  })
})
