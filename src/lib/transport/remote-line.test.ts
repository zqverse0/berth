import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRemoteSession } from "./remote-line"

/** 假的 WebSocket：记下发出的帧，测试里手动开、收、断。 */
class FakeSocket {
  static all: FakeSocket[] = []
  readonly sent: (string | Uint8Array)[] = []
  binaryType = "blob"
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string | Uint8Array) {
    this.sent.push(data)
  }
  close() {}
  open() {
    this.onopen?.()
    this.onmessage?.({ data: '{"resumed":false}' })
  }
  receive(data: ArrayBuffer | string) {
    this.onmessage?.({ data })
  }
  drop() {
    this.onclose?.({ code: 1006 })
  }
  /** 发出的二进制请求帧：meta 与请求体。 */
  requests() {
    return this.sent
      .filter((d): d is Uint8Array => d instanceof Uint8Array && d[0] === 0)
      .map((d) => {
        const len = new DataView(d.buffer, d.byteOffset).getUint32(0)
        return {
          meta: JSON.parse(new TextDecoder().decode(d.subarray(4, 4 + len))),
          body: new TextDecoder().decode(d.subarray(4 + len)),
        }
      })
  }
}

/** `[2][u32 id][u8 flags][u32 ms][u64 etag][body]` */
function response(id: number, flags: number, etag: bigint, body: string) {
  const bytes = new TextEncoder().encode(body)
  const out = new Uint8Array(18 + bytes.length)
  const view = new DataView(out.buffer)
  out[0] = 2
  view.setUint32(1, id)
  out[5] = flags
  view.setBigUint64(10, etag)
  out.set(bytes, 18)
  return out.buffer
}

const OK_JSON_WHOLE = 1 | 2 | 4 | 8
const NOT_MODIFIED = OK_JSON_WHOLE | 32
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function session() {
  return createRemoteSession({
    url: (path) => `ws://host${path}`,
    deliver: () => {},
    alive: () => true,
    onEvent: () => {},
    onReset: () => {},
    notice: () => {},
  })
}

describe("remote line", () => {
  beforeEach(() => {
    FakeSocket.all = []
    vi.stubGlobal("WebSocket", FakeSocket)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("calls round-trip; an unchanged result comes back as a cached value", async () => {
    const remote = session()
    await flush()
    const [commands] = FakeSocket.all
    expect(commands.url).toMatch(
      /^ws:\/\/host\/__berth\/ws\?client=.+&received=0/
    )
    commands.open()

    const first = remote.call("terminal_list_sessions", {})
    let [request] = commands.requests()
    expect(request.meta).toMatchObject({ id: 1, cmd: "terminal_list_sessions" })
    commands.receive(response(1, OK_JSON_WHOLE, 0xabn, '[{"terminalId":"t"}]'))
    await expect(first).resolves.toEqual([{ terminalId: "t" }])

    const second = remote.call("terminal_list_sessions", {})
    request = commands.requests()[1]
    expect(request.meta.etag).toBe("ab")
    commands.receive(response(2, NOT_MODIFIED, 0xabn, ""))
    await expect(second).resolves.toEqual([{ terminalId: "t" }])
  })

  it("keys go out as input frames and survive a reconnect until acked", async () => {
    vi.useFakeTimers()
    const remote = session()
    await vi.advanceTimersByTimeAsync(0)
    const terminal = FakeSocket.all.find((s) =>
      s.url.includes("/__berth/term")
    )!
    terminal.open()

    void remote.call("terminal_attach_channel", {
      terminalId: "t",
      clientId: "c",
      onOutput: "__CHANNEL__:7",
    })
    const write = () =>
      remote.call("terminal_write_attached_raw", new Uint8Array([104, 105]), {
        "x-berth-terminal-id": "t",
        "x-berth-client-id": "c",
      })
    await expect(write()).resolves.toBeNull()
    const inputs = () =>
      terminal.sent.filter((d) => d instanceof Uint8Array && d[0] === 4)
    expect(inputs()).toHaveLength(1)

    // 断线重连：没确认的按键从原偏移补发。
    terminal.drop()
    await vi.advanceTimersByTimeAsync(600)
    const again = FakeSocket.all.filter((s) =>
      s.url.includes("/__berth/term")
    )[1]
    again.open()
    expect(
      again.sent.filter((d) => d instanceof Uint8Array && d[0] === 4)
    ).toHaveLength(1)
    vi.useRealTimers()
  })

  it("writing to a terminal that is not attached fails instead of going nowhere", async () => {
    const remote = session()
    await expect(
      remote.call("terminal_write_attached_raw", new Uint8Array([1]), {
        "x-berth-terminal-id": "x",
        "x-berth-client-id": "c",
      })
    ).rejects.toMatch(/not attached/)
  })
})
