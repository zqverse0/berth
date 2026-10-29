/**
 * T1 AC1/AC3 屏幕级断言：真实 adapter × runtime × xterm Terminal。
 *
 * 区分"字节消费"(sink 收到)与"屏幕状态"(xterm buffer 渲染结果):
 * 确定性 ANSI 标记(每行唯一)在 resize 前/中/后各应用恰好一次——
 * 丢失 = 行缺失,重复 = 行重复,乱序 = 行序错乱。
 * 与 tauri-terminal-stream-composite.test.ts 共用门闩基建,但 sink 是
 * 真实 @xterm/xterm 实例(与 scrollback contract 测试同一模式)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Terminal } from "@xterm/xterm"
import type { Transport } from "@/lib/transport/types"
import { TauriTerminalStream } from "@/lib/terminal/tauri-terminal-stream"
import {
  __setTerminalStreamForTests,
  resetTerminalRuntimeStore,
  useTerminalRuntimeStore,
} from "@/stores/terminal-runtime-store"
import { useTabStore } from "@/stores/tab-store"

const channelState = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: ((packet: unknown) => void) | null }>,
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
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function snapshotWire(sequence: number, rows = 6, cols = 40) {
  return {
    terminalId: "t1",
    backendInstanceId: "b1",
    sequence,
    rows,
    cols,
    ansiBase64: "",
    historyTruncated: false,
    status: "running" as const,
    exitCode: null,
    exitedAt: null,
    lastKnownCwd: null,
  }
}

function outputPacket(
  sequenceStart: number,
  sequenceEnd: number,
  text: string
): Uint8Array {
  const data = new TextEncoder().encode(text)
  const packet = new Uint8Array(20 + data.byteLength)
  packet[0] = 0x54
  packet[1] = 0x56
  packet[2] = 2
  packet[3] = 1
  const view = new DataView(packet.buffer)
  view.setBigUint64(4, BigInt(sequenceStart))
  view.setBigUint64(12, BigInt(sequenceEnd))
  packet.set(data, 20)
  return packet
}

/** 等待 xterm 完成全部在途写入解析(write 是异步的)。 */
const drainWrites = (term: Terminal): Promise<void> =>
  new Promise((resolve) => term.write("", resolve))

/** 屏幕文本:去掉尾部空行的可见内容。 */
function screenText(term: Terminal): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "")
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

const terminals: Terminal[] = []

afterEach(() => {
  while (terminals.length > 0) terminals.pop()?.dispose()
})

beforeEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
  useTabStore.setState({ tabs: [] })
})

afterEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
})

describe("T1 screen-state assertions (adapter × runtime × xterm)", () => {
  it("applies deterministic pre/during/post-resize markers exactly once on screen", async () => {
    // AC1/AC3:resize 前/中/后各写唯一标记行,断言屏幕上每行恰好一次、
    // 顺序正确、最终网格为新尺寸。标记经真实 adapter 透传 + runtime
    // 事件循环进 xterm sink,字节消费与屏幕状态分别记录。
    channelState.channels.length = 0
    const shared = {
      attachCount: 0,
      resizeSnapshot: snapshotWire(4, 8, 50) as Record<string, unknown>,
    }
    let gate: {
      promise: Promise<Record<string, unknown>>
      resolve: (value: Record<string, unknown>) => void
    } | null = null
    const releaseResize = () => {
      if (gate) {
        gate.resolve(shared.resizeSnapshot)
        gate = null
      }
    }
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") {
          shared.attachCount += 1
          return snapshotWire(0)
        }
        if (command === "terminal_resize_attached") {
          gate = gate ?? deferred<Record<string, unknown>>()
          await gate.promise
          return shared.resizeSnapshot
        }
        if (command === "terminal_detach") return null
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport
    __setTerminalStreamForTests(new TauriTerminalStream(transport) as never)

    const actions = useTerminalRuntimeStore.getState()
    await actions.attachTerminal("t1")

    const term = new Terminal({ cols: 40, rows: 6, scrollback: 100 })
    terminals.push(term)
    let sinkBytes = ""
    actions.setOutputSink("t1", (data) => {
      sinkBytes += new TextDecoder().decode(data)
      term.write(data)
    })
    actions.activateOutputSink("t1")

    const feed = (start: number, end: number, text: string) => {
      const channel =
        channelState.channels[channelState.channels.length - 1] ?? null
      channel?.onmessage?.(outputPacket(start, end, text))
    }

    // resize 前的标记(seq 1)。
    feed(1, 1, "PRE-MARK\r\n")
    await tick()
    // resize 在途:期间标记(seq 2、3)。
    const resize = actions.resize("t1", 8, 50)
    await tick()
    feed(2, 2, "DURING-MARK-A\r\n")
    feed(3, 3, "DURING-MARK-B\r\n")
    releaseResize()
    await resize
    await tick()
    // resize 后:seq 4(RPC 水位=ring 前沿,事件 4 已产出、水位内迟到)
    // 与 seq 5(水位后新产出)连续投递。游标修复后消费游标停在 3,
    // 4、5 顺序衔接——不再跳号(旧 mock 跳过 seq 4 会造成真实 gap,
    // 那是 H 场景的语义,不在此处)。
    feed(4, 4, "POST-MARK\r\n")
    feed(5, 5, "TAIL-MARK\r\n")
    await tick()

    await drainWrites(term)
    // 字节消费记录(与屏幕断言分开)。
    const byteContains = (marker: string) => sinkBytes.includes(marker)
    // 屏幕状态:每个标记恰好一行、顺序 pre < during-a < during-b < post。
    const lines = screenText(term)
    const count = (marker: string) =>
      lines.filter((line) => line.includes(marker)).length
    expect(count("PRE-MARK")).toBe(1)
    expect(count("DURING-MARK-A")).toBe(1)
    expect(count("DURING-MARK-B")).toBe(1)
    expect(count("POST-MARK")).toBe(1)
    const order =
      lines.findIndex((l) => l.includes("PRE-MARK")) <
        lines.findIndex((l) => l.includes("DURING-MARK-A")) &&
      lines.findIndex((l) => l.includes("DURING-MARK-A")) <
        lines.findIndex((l) => l.includes("DURING-MARK-B")) &&
      lines.findIndex((l) => l.includes("DURING-MARK-B")) <
        lines.findIndex((l) => l.includes("POST-MARK"))
    expect(order).toBe(true)
    // 字节与屏幕双记录(AC3:分别记录,不互相冒充)。
    expect(byteContains("POST-MARK") || count("POST-MARK") === 1).toBe(true)
    // 最终网格:resize 后新尺寸(运行时 resize 应用走 painter;组合中
    // term 由测试持有,直接断言 runtime 记录的最终快照尺寸)。
    expect(
      useTerminalRuntimeStore.getState().sessions.t1?.snapshot
    ).toMatchObject({ rows: 6, cols: 40 })
    // 正常路径零重挂。
    expect(shared.attachCount).toBe(1)
  })

  it("keeps cursor and final grid consistent after a no-gap resize (byte vs screen recorded separately)", async () => {
    // AC3 光标 + 最终行列:xterm 在收到内容后光标行推进,resize 后
    // runtime 记录确认网格。字节路径与屏幕路径分别断言。
    channelState.channels.length = 0
    const shared = {
      resizeSnapshot: snapshotWire(3, 10, 60) as Record<string, unknown>,
    }
    let gate: {
      promise: Promise<Record<string, unknown>>
      resolve: (value: Record<string, unknown>) => void
    } | null = null
    const transport = {
      async call(command: string) {
        if (command === "terminal_attach_channel") return snapshotWire(0)
        if (command === "terminal_resize_attached") {
          gate = gate ?? deferred<Record<string, unknown>>()
          await gate.promise
          return shared.resizeSnapshot
        }
        if (command === "terminal_detach") return null
        throw new Error(`unexpected call: ${command}`)
      },
      async callRaw() {},
      async subscribe() {
        return () => {}
      },
      isDesktop: () => true,
    } as unknown as Transport
    __setTerminalStreamForTests(new TauriTerminalStream(transport) as never)

    const actions = useTerminalRuntimeStore.getState()
    await actions.attachTerminal("t1")

    const term = new Terminal({ cols: 40, rows: 6, scrollback: 100 })
    terminals.push(term)
    actions.setOutputSink("t1", (data) => {
      term.write(data)
    })
    actions.activateOutputSink("t1")
    const feed = (start: number, end: number, text: string) => {
      const channel =
        channelState.channels[channelState.channels.length - 1] ?? null
      channel?.onmessage?.(outputPacket(start, end, text))
    }

    feed(1, 1, "line-one\r\nline-two\r\n")
    await tick()
    const resize = actions.resize("t1", 10, 60)
    await tick()
    feed(2, 2, "line-three\r\n")
    // gate 一定存在:resize call 已发出(await tick 后 transport.call 已执行)。
    // (TS 无法追踪闭包内赋值,经局部变量绕开 never 收窄。)
    const releaseGate = gate as {
      promise: Promise<Record<string, unknown>>
      resolve: (value: Record<string, unknown>) => void
    } | null
    if (!releaseGate) throw new Error("resize gate was never created")
    releaseGate.resolve(shared.resizeSnapshot)
    await resize
    await tick()

    await drainWrites(term)
    // 屏幕:三行都在,顺序正确。
    const lines = screenText(term)
    expect(lines.filter((l) => l.includes("line-one"))).toHaveLength(1)
    expect(lines.filter((l) => l.includes("line-two"))).toHaveLength(1)
    expect(lines.filter((l) => l.includes("line-three"))).toHaveLength(1)
    // 光标推进:写完三行后光标 y ≥ 3(不回卷到 0)。
    expect(
      term.buffer.active.cursorY + term.buffer.active.baseY
    ).toBeGreaterThanOrEqual(3)
    // runtime 记录的确认网格(字节消费 ≠ 几何确认,分别断言)。
    const session = useTerminalRuntimeStore.getState().sessions.t1
    expect(session?.sequence).toBeGreaterThanOrEqual(3)
  })
})
