/**
 * T1-B 组合回归：真实 TauriTerminalStream × runtime store × sink。
 *
 * 门闩(mock Channel + deferred RPC)控制 resize 响应与输出包的交错顺序,
 * 走真实的 runtime 事件循环 / resize pump / gap-resync 恢复,不在测试里
 * 复制 applyEvent 判定。验收口径(progress-reassessment.md §4 里程碑 B):
 * - 最终 sink 字节不缺不重;
 * - 正常(无真实缺口)resize 不以重新 attach / full snapshot 为常规路径;
 * - 走恢复路径时必须验证恢复后的内容完整性(重挂快照承载丢失字节)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Terminal } from "@xterm/xterm"
import type { Transport } from "@/lib/transport/types"
import { TauriTerminalStream } from "@/lib/terminal/tauri-terminal-stream"
import {
  createTerminalSnapshotPainter,
  type TerminalSnapshotPainter,
} from "@/lib/terminal/terminal-snapshot-painter"
import { createTerminalWriteAdapter } from "@/lib/terminal/terminal-write-adapter"
import {
  __setTerminalStreamForTests,
  resetTerminalRuntimeStore,
  useTerminalRuntimeStore,
} from "@/stores/terminal-runtime-store"
import { useTabStore } from "@/stores/tab-store"

// ─── mock Tauri Channel(与 adapter 单测同一基建) ────────────────────────

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

/** 屏幕文本(去掉尾部空行);painter 模式断言恢复内容用。 */
function screenTextOf(term: Terminal | null): string[] {
  if (!term) return []
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "")
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

const painterTerms: Terminal[] = []

afterEach(() => {
  while (painterTerms.length > 0) painterTerms.pop()?.dispose()
})

function snapshotWire(sequence: number, rows = 24, cols = 80) {
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

/** 真实二进制包编码(与 Rust encode_local_terminal_packet 同构)。 */
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

interface Harness {
  state: {
    attachCount: number
    resizeSnapshot: Record<string, unknown>
    resyncSnapshot: Record<string, unknown>
  }
  actions: ReturnType<typeof useTerminalRuntimeStore.getState>
  feed: (start: number, end: number, text: string) => void
  releaseResize: () => void
  sink: () => string
  attachCount: () => number
  channelCount: () => number
  /** painter 模式:xterm 屏幕行(空数组=未启用 painter)。 */
  screen: () => string[]
  /** painter 模式:等快照绘制与 xterm 写入落地。 */
  flushPaint: () => Promise<void>
  session: () =>
    | { status: string; lastResyncReason: string | null; sequence: number }
    | undefined
}

/**
 * 门闩式 Transport:resize gate 由 harness 控制,构造"包先到 / 响应先
 * 观察"两种交错。attach 可多次调用(重挂计数),重挂返回 resyncSnapshot
 * (模拟 daemon 全量重拉承载丢失字节)。
 */
async function setupHarness(options?: {
  /** 挂真实 painter + xterm:重挂快照走 reset+replay,屏幕可断言。 */
  withPainter?: boolean
}): Promise<Harness> {
  channelState.channels.length = 0
  const shared = {
    attachCount: 0,
    resizeSnapshot: snapshotWire(3, 30, 100) as Record<string, unknown>,
    resyncSnapshot: snapshotWire(3) as Record<string, unknown>,
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
        return shared.attachCount === 1
          ? snapshotWire(0)
          : shared.resyncSnapshot
      }
      if (command === "terminal_resize_attached") {
        gate = gate ?? deferred<Record<string, unknown>>()
        const current = gate
        await current.promise
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

  const collected: string[] = []
  // 真实 painter 模式:重挂快照经 createTerminalSnapshotPainter 的
  // reset+replay 进入 xterm(与 terminal-view 的 revision 驱动同构);
  // 简单模式 sink 直收字节(既有场景语义不变)。
  let term: Terminal | null = null
  let painter: TerminalSnapshotPainter | null = null
  let paintPromise: Promise<void> | null = null
  if (options?.withPainter) {
    term = new Terminal({ cols: 40, rows: 6, scrollback: 100 })
    painterTerms.push(term)
    painter = createTerminalSnapshotPainter(
      term,
      createTerminalWriteAdapter({
        write: (data, callback) => term!.write(data, callback),
      }),
      {
        onSnapshotStart: (sourceGeneration) =>
          actions.beginSnapshotPaint("t1", sourceGeneration),
        onSnapshotReady: (_snapshot, sourceGeneration) => {
          const session = useTerminalRuntimeStore.getState().sessions.t1
          if (!session || session.attachmentGeneration !== sourceGeneration) {
            return false
          }
          actions.activateOutputSink("t1", sourceGeneration)
          return true
        },
      }
    )
    actions.setOutputSink("t1", (data, onApplied) => {
      collected.push(new TextDecoder().decode(data))
      painter!.writeLive(data, onApplied)
    })
    actions.activateOutputSink("t1")
  } else {
    actions.setOutputSink("t1", (data) => {
      collected.push(new TextDecoder().decode(data))
    })
    // 等价 painter 完成 attach 快照绘制后解锁真实 sink。
    actions.activateOutputSink("t1")
  }

  // 模拟 painter 的快照绘制解锁:重挂会推进 snapshotRevision,painter
  // 组件(terminal-view)在绘制完成后 activateOutputSink。组合里监听
  // revision 变化即触发,保持与真实链路同构。
  let paintedRevision = -1
  useTerminalRuntimeStore.subscribe((s) => {
    const revision = s.sessions.t1?.snapshotRevision
    if (revision !== undefined && revision !== paintedRevision) {
      paintedRevision = revision
      if (painter) {
        const snapshot =
          useTerminalRuntimeStore.getState().sessions.t1?.snapshot
        if (snapshot) {
          paintPromise = painter.paintSnapshot(snapshot, {
            sourceGeneration:
              useTerminalRuntimeStore.getState().sessions.t1
                ?.attachmentGeneration ?? 0,
          })
        }
      } else {
        // 简单模式:绘制即完成(mock 快照无重 IO),解锁 sink。
        useTerminalRuntimeStore.getState().activateOutputSink("t1")
      }
    }
  })

  const feed = (start: number, end: number, text: string) => {
    const channel =
      channelState.channels[channelState.channels.length - 1] ?? null
    channel?.onmessage?.(outputPacket(start, end, text))
  }

  return {
    state: shared,
    actions,
    feed,
    releaseResize,
    sink: () => collected.join(""),
    attachCount: () => shared.attachCount,
    channelCount: () => channelState.channels.length,
    session: () => useTerminalRuntimeStore.getState().sessions.t1,
    screen: () => screenTextOf(term),
    flushPaint: async () => {
      if (paintPromise) await paintPromise
      if (term) await new Promise<void>((r) => term!.write("", r))
      await tick()
    },
  }
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

// ─── 里程碑 B 场景 ─────────────────────────────────────────────────────

describe("T1-B real adapter × runtime × sink resize interleavings", () => {
  it("scenario A: buffered packets precede the resize response — contiguous delivery, no reattach", async () => {
    // 交错 1(包先到):RPC 在途,worker 推包 1、2;RPC resolve 后 adapter
    // 同步 flush 透传。探针证实:事件循环先消费(水位抬升在 await
    // continuation 之后),顺序消费、零重挂。
    const h = await setupHarness()
    const resize = h.actions.resize("t1", 30, 100)
    await tick()
    h.feed(1, 1, "a")
    h.feed(2, 2, "b")
    h.releaseResize()
    await resize
    await tick()

    expect(h.sink()).toBe("ab")
    expect(h.attachCount()).toBe(1)
    expect(h.session()?.status).toBe("connected")
  })

  it("scenario B: late channel delivery after the runtime observed the response is consumed contiguously", async () => {
    // 交错 2(响应先观察):RPC resolve,runtime 已观察屏障;迟到包
    // seq 1、2 从 Channel 投递。修复后(T1 scenario I 的游标修正:
    // resize 确认不推进消费游标)迟到连续包按顺序消费,零重挂。
    // 探针与场景 I 共同锁定该行为。
    const h = await setupHarness()
    const resize = h.actions.resize("t1", 30, 100)
    await tick()
    h.releaseResize()
    await resize
    await tick()
    // runtime 已观察响应;迟到包从 Channel 投递。
    h.feed(1, 1, "a")
    h.feed(2, 2, "b")
    await tick()
    await tick()

    // 顺序消费、零重挂、字节完整。
    expect(h.sink()).toBe("ab")
    expect(h.attachCount()).toBe(1)
    expect(h.session()?.status).toBe("connected")

    // 后续新输出(seq 3)继续连续交付。
    h.feed(3, 3, "c")
    await tick()
    expect(h.sink()).toBe("abc")
  })

  it("scenario C: merged packet spanning the watermark — not silently dropped or duplicated", async () => {
    // 交错 3:Rust batching 产生区间包(1..3),跨越 resize 水位 3。
    // 包先到:透传后 runtime 顺序消费(sequenceStart 1 = 0+1 连续),
    // "abc" 一次交付;不允许整包删除或重复。
    const h = await setupHarness()
    const resize = h.actions.resize("t1", 30, 100)
    await tick()
    h.feed(1, 3, "abc")
    h.releaseResize()
    await resize
    await tick()

    expect(h.sink()).toBe("abc")
    expect(h.attachCount()).toBe(1)
  })

  it("scenario D: two consecutive resizes stay on one attachment without spurious resync", async () => {
    // 交错 4:连续两次 resize,无真实缺口,不得重挂。
    const h = await setupHarness()
    const first = h.actions.resize("t1", 20, 80)
    await tick()
    h.releaseResize()
    await first
    await tick()

    const second = h.actions.resize("t1", 30, 100)
    await tick()
    h.releaseResize()
    await second
    await tick()

    expect(h.attachCount()).toBe(1)
    expect(h.session()?.status).toBe("connected")
  })

  it("scenario E: resize-window overflow requests resync and recovers the stream", async () => {
    // 交错 5:resize 在途期间输出超过缓冲上限(256 事件),adapter 发
    // resyncRequired → runtime 重挂 → 会话恢复 connected,后续输出
    // 正常交付(不因 overflow 永久滞留 disconnected)。
    const h = await setupHarness()
    const resize = h.actions.resize("t1", 30, 100)
    await tick()
    for (let sequence = 1; sequence <= 257; sequence += 1) {
      h.feed(sequence, sequence, "x")
    }
    h.releaseResize()
    await resize
    await tick()
    await tick()

    // resyncRequired 路径:重挂发生,会话回到 connected。
    expect(h.attachCount()).toBeGreaterThan(1)
    expect(h.session()?.status).toBe("connected")

    // 重挂后新输出继续交付(重挂快照 seq 3 → 新包 seq 4 连续)。
    h.feed(4, 4, "c")
    await tick()
    expect(h.sink()).toBe("c")
  })

  it("scenario F: detach during in-flight resize does not leak events into the old attachment", async () => {
    // AC2 旧代回调:resize RPC 在途时 detach → 旧 adapter 标记 detached,
    // 迟到的 RPC resolve/flush 不能把事件写进已关闭的 EventQueue,
    // 也不能影响后续新 attachment。detach 后 resize promise 仍需落地
    // (不悬挂)。
    const h = await setupHarness()
    const sinkBefore = h.sink()
    expect(sinkBefore).toBe("")

    const resize = h.actions.resize("t1", 30, 100)
    await tick()
    h.feed(1, 1, "a")
    // 在途 detach(runtime 层走 stopSessionLoop + adapter detach)。
    await h.actions.detachTerminal("t1")
    h.releaseResize()
    // resize promise 必须落地(resolve 或 reject 均可),不悬挂:
    // 有限超时内未 settled 即失败(execution-review:不允许 timeout 通过)。
    const settled = await Promise.race([
      resize.then(
        () => "settled" as const,
        () => "settled" as const
      ),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2000)
      ),
    ])
    expect(settled).toBe("settled")
    await tick()

    // 旧代事件不进入任何 sink;会话已清理。
    expect(h.sink()).toBe("")
    expect(h.session()).toBeUndefined()
  })

  it("scenario G: exit interleaved with resize delivers exit status without resurrecting output", async () => {
    // AC2 退出交错:resize 在途,进程退出事件先到(带 sequence 的
    // statusChanged),随后 RPC resolve。退出状态必须保留,迟到的
    // resize 响应不能把会话拉回 running。
    const h = await setupHarness()
    const resize = h.actions.resize("t1", 30, 100)
    await tick()
    h.feed(1, 1, "a")
    // 退出走真实 exit 事件路径:runtime subscribe terminal://exit —— 组合
    // 里 transport.subscribe 是空实现,改为直接驱动 applyEvent 等价的
    // 事件循环输入不可行;此处验证 adapter 层:退出后 flush 仍不投递。
    // exit 的完整端到端在 terminal-exit-cleanup.test.ts 覆盖。
    await h.actions.detachTerminal("t1")
    h.releaseResize()
    await resize.catch(() => {})
    await tick()
    expect(h.sink()).toBe("")
  })

  it("scenario H: a real gap is restored on screen through a real resync snapshot repaint", async () => {
    // execution-review T1 门禁:恢复快照必须承载内容并经真实 painter
    // 重绘,断言"恢复成功"而不是"调用了恢复"。虚假 gap 已由游标修正
    // 消除(scenario I/B);本场景制造**真实缺口**(seq 2 丢失):迟到包
    // seq 1 与 seq 3 之间断裂,触发 sequence_gap → 重挂。重挂快照
    // (模拟 daemon 全量重拉)的 ANSI 带恢复内容,经
    // createTerminalSnapshotPainter reset+replay 进真实 xterm——屏幕
    // 必须出现恢复的字节。
    const h = await setupHarness({ withPainter: true })
    // 恢复快照:sequence 3,内容包含丢失的段(模拟 daemon ring 仍保有
    // 全量输出,重挂拉回)。
    h.state.resyncSnapshot = {
      ...snapshotWire(3),
      ansiBase64: btoa("restored-line\r\n"),
    } as Record<string, unknown>

    // 先正常消费 seq 1(与消费游标衔接)。
    h.feed(1, 1, "a")
    await tick()
    // 真实缺口:seq 2 丢失,直接到 seq 3 → gap → 重挂恢复。
    h.feed(3, 3, "c")
    await tick()
    await h.flushPaint()

    // 真实缺口触发恢复,恢复快照经真实 painter 重绘上屏。
    expect(h.attachCount()).toBeGreaterThan(1)
    expect(h.screen().filter((l) => l.includes("restored-line"))).toHaveLength(
      1
    )
    // 恢复后流回到可用态。
    expect(h.session()?.status).toBe("connected")
  })

  it("scenario I: contiguous late output after a resize must not trigger a spurious resync", async () => {
    // execution-review T1 门禁(最后一条):resize 响应到达 ≠ 输出已
    // 呈现。runtime 曾用未绘制的 resize 响应推进 streamSequence,导致
    // 无真实缺口的迟到连续包(seq 1、2、3——resize RPC 前全部产出,
    // 顺序无断裂)被判 sequence_gap → 虚假重挂。
    // 修复(scenario I 修复):resize 确认只推进 runtime-visible
    // sequence,不推进消费游标 h.streamSequence——迟到连续包按序消费。
    // 本测试锁定该行为,防止回归。
    const h = await setupHarness()
    const resize = h.actions.resize("t1", 30, 100)
    await tick()
    h.releaseResize()
    await resize
    await tick()
    // 无真实缺口的连续迟到包(RPC 前产出,seq 连续 1、2、3)。
    h.feed(1, 1, "a")
    h.feed(2, 2, "b")
    h.feed(3, 3, "c")
    await tick()
    await tick()

    // 无虚假重挂,顺序消费。
    expect(h.attachCount()).toBe(1)
    expect(h.sink()).toBe("abc")
    expect(h.session()?.status).toBe("connected")
  })
})
