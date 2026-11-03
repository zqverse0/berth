// 远程访问协议的客户端，唯一实现（帧格式见 `src-tauri/src/remote/mod.rs` 顶部）。两处使用：
// - 浏览器经 URL 打开 Berth：`remote/mod.rs` 把本文件（去掉 `export`）与 `shim.js` 一起注入页面；
// - 本机 Berth 用对方设备的项目：`./device.ts`（经节点隧道连对方 GUI 的设备 socket）。
// 不依赖任何模块、不碰页面全局状态（窗口、Tauri 内部接口归调用方），协议只在这里改。
//
// 一个会话两条 WebSocket：命令线 /__berth/ws 走命令与事件；终端专线 /__berth/term 只走终端
// （attach / resize / detach、按键字节流、输出）。按键不是一次次命令：本地入队即返回，按字节偏移
// 可靠送达，断线重连后从宿主确认的位置补发，不丢也不重复。

const FRAME_TERMINAL = 1
const FRAME_RESPONSE = 2
const FRAME_TERMINAL_DEFLATE = 3
const FRAME_INPUT = 4
const FLAG_OK = 1
const FLAG_JSON = 2
const FLAG_FIRST = 4
const FLAG_LAST = 8
const FLAG_GZIP = 16
const FLAG_NOT_MODIFIED = 32
const FLAG_SNAPSHOT = 64
// 同一命令同一小请求体的上次结果：宿主算出结果未变只回「未变」（轮询省带宽）。
const ETAG_MAX_BODY = 2048
// 超过这么久的命令记到宿主日志（总耗时 vs 宿主执行耗时），用来定位远程卡顿。
const SLOW_IPC_MS = 3000
// 断线前没送到的终端输入，重连时已过这么久就丢弃并提示：断线期间敲的键不在很久之后突然执行。
const STALE_INPUT_MS = 10000
// 线路判活：前台时每 PING_MS 发 ping；一段时间（各线路的 deadMs）没收到任何数据、或 ping 没等到
// pong，就当连接已死立刻重建。对端 RST 时页面常收不到 close（实测手机上要等 40 秒）；下行可能
// 还在收数据而上行已死，只看「有没有数据进来」会把它当活的，用户的输入全丢。
// 后台不 ping（省电），靠宿主 15 秒心跳，IDLE_MS 没数据才重连（iOS 切后台后常无声断开）。
// 新连接 CONNECT_MS 内没建立就放弃重来：线路可能还没恢复，那次握手会一直挂着。
const PING_MS = 2000
// 专线上只有小帧，pong 不会排在大块后面；命令线可能正下载大响应，慢链路上给足余量。
const TERMINAL_DEAD_MS = 5000
const COMMAND_DEAD_MS = 10000
const IDLE_MS = 40000
const CONNECT_MS = 5000
// 回到前台时用 ping 探测旧连接，这么久没回音就重建。
const PROBE_MS = 3000
const RETRY_MAX_MS = 4000
// 断线超过这么久才记日志（看重连到底花了多久）。
const LOG_OUTAGE_MS = 3000

const encoder = new TextEncoder()
const decoder = new TextDecoder()
// 能解 deflate-raw 就让宿主压缩终端输出（iOS Safari 16.4+、WebKitGTK）。
const DEFLATE = (() => {
  try {
    new DecompressionStream("deflate-raw")
    return true
  } catch {
    return false
  }
})()

// `[u32 meta 长度][meta JSON][请求体]`
function frame(meta, body) {
  const head = encoder.encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + head.length + body.length)
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  out.set(body, 4 + head.length)
  return out
}

// 与 Tauri IPC 同样的序列化：字节原样发，其余 JSON（Channel 等按 `__TAURI_TO_IPC_KEY__` 取值）。
function serialize(payload) {
  if (
    payload instanceof ArrayBuffer ||
    ArrayBuffer.isView(payload) ||
    Array.isArray(payload)
  ) {
    const data = Array.isArray(payload)
      ? new Uint8Array(payload)
      : payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    return { json: false, data }
  }
  const data = JSON.stringify(payload, (_key, value) => {
    if (value instanceof Map) return Object.fromEntries(value.entries())
    if (value instanceof Uint8Array) return Array.from(value)
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
    if (
      typeof value === "object" &&
      value !== null &&
      "__TAURI_TO_IPC_KEY__" in value
    ) {
      return value.__TAURI_TO_IPC_KEY__()
    }
    return value
  })
  return { json: true, data }
}

function toBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      resolve(reader.result.slice(reader.result.indexOf(",") + 1))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(new Blob([bytes]))
  })
}

function channelOfOutput(output) {
  const ref =
    typeof output === "string"
      ? output
      : output && output.__TAURI_TO_IPC_KEY__()
  return Number(String(ref).replace("__CHANNEL__:", ""))
}

/**
 * 到一个宿主的会话。`options`：
 * - `url(path)`：WebSocket 地址（不含查询串），可返回 Promise；失败按断线退避重试；
 * - `deliver(channel, packet)` / `alive(channel)`：终端输出交给 Tauri `Channel` 回调（`{index, message}`）；
 * - `onEvent(name, payload)`：命令线上的事件；
 * - `onReset()`：宿主丢了这一页的状态（重启、掉线太久、事件溢出）；终端已各自重新同步；
 * - `onState(open, error)`：命令线通断；
 * - `notice(text)`：给用户的一句提示。
 */
export function createRemoteSession(options) {
  const client = crypto.randomUUID()
  const lastResult = new Map()
  // 最近一次转入后台的时刻：期间挂起的调用不算慢（手机锁屏动辄几分钟）。
  let hiddenAt = 0
  const foreground = () => document.visibilityState === "visible"

  // 连接断开时：没有 id 的日志先攒着；带 id 的命令留在 calls 里，连上后重发。
  const outbox = []
  function control(cmd, text) {
    const data = frame({ cmd }, encoder.encode(text))
    if (!commands.send(data) && cmd === "__log") outbox.push(data)
  }

  let events = []
  let subscribeTimer = null
  function syncSubscriptions() {
    clearTimeout(subscribeTimer)
    subscribeTimer = setTimeout(() => {
      control("__subscribe", JSON.stringify(events))
    }, 20)
  }

  // id → 进行中的命令；断线重连后按 id 顺序在原线路重发，宿主按 id 去重（已执行的补发结果）。
  const calls = new Map()
  let nextCallId = 1
  function ipc(cmd, payload, headers, line) {
    const { json, data } = serialize(payload)
    const key = json && data.length <= ETAG_MAX_BODY ? `${cmd}\n${data}` : null
    const cached = key ? lastResult.get(key) : undefined
    const id = nextCallId++
    const meta = { id, cmd, json, h: headers || {} }
    if (cached) meta.etag = cached.etag
    const body = json ? encoder.encode(data) : data
    return new Promise((resolve, reject) => {
      const call = {
        cmd,
        key,
        cached,
        frame: frame(meta, body),
        started: performance.now(),
        line,
        connection: line.connections,
        parts: null,
        resolve,
        reject,
      }
      calls.set(id, call)
      line.send(call.frame)
    })
  }

  async function finish(id, call, flags, took, etag) {
    calls.delete(id)
    const total = Math.round(performance.now() - call.started)
    if (total > SLOW_IPC_MS && hiddenAt < call.started) {
      control(
        "__log",
        `slow ${call.cmd} total=${total}ms host=${took}ms reconnects=${call.line.connections - call.connection}`
      )
    }
    try {
      if (flags & FLAG_NOT_MODIFIED && call.cached) {
        call.resolve(call.cached.value)
        return
      }
      let bytes = new Uint8Array(
        call.parts.reduce((n, part) => n + part.length, 0)
      )
      let offset = 0
      for (const part of call.parts) {
        bytes.set(part, offset)
        offset += part.length
      }
      if (flags & FLAG_GZIP) {
        const stream = new Blob([bytes])
          .stream()
          .pipeThrough(new DecompressionStream("gzip"))
        bytes = new Uint8Array(await new Response(stream).arrayBuffer())
      }
      let value
      if (flags & FLAG_SNAPSHOT) {
        // attach 快照：`[u32 长度][JSON][ANSI 原始字节]`，补回前端要的 base64。
        const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
        value = JSON.parse(decoder.decode(bytes.subarray(4, 4 + len)))
        value.ansiBase64 = await toBase64(bytes.subarray(4 + len))
      } else {
        value =
          flags & FLAG_JSON ? JSON.parse(decoder.decode(bytes)) : bytes.buffer
      }
      if (!(flags & FLAG_OK)) {
        call.reject(value)
        return
      }
      if (call.key) lastResult.set(call.key, { etag, value })
      call.resolve(value)
    } catch (error) {
      call.reject(error)
    }
  }

  // 终端专线上的 attach：channel → 状态。按键按累计字节偏移编号，宿主确认后丢弃；
  // `next` 是交给 Channel 的下一个包序号。
  const terminals = new Map()
  // 每路终端一个解压流：宿主共享一个 deflate 上下文，块必须按序喂进同一个流。
  const inflaters = new Map()

  function deliver(channel, index, message) {
    const state = terminals.get(channel)
    if (state) state.next = index + 1
    options.deliver(channel, { index, message })
  }

  function inflate(channel, chunk) {
    let state = inflaters.get(channel)
    if (!state) {
      const stream = new DecompressionStream("deflate-raw")
      state = {
        writer: stream.writable.getWriter(),
        index: 0,
        pending: new Uint8Array(0),
      }
      inflaters.set(channel, state)
      readPackets(channel, state, stream.readable.getReader()).catch(() => {})
    }
    state.writer.write(chunk).catch(() => {})
  }
  // 解出的是 `[u32 长度][终端包]` 序列，块边界与包边界无关。
  async function readPackets(channel, state, reader) {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      const buf = new Uint8Array(state.pending.length + value.length)
      buf.set(state.pending)
      buf.set(value, state.pending.length)
      let offset = 0
      while (buf.length - offset >= 4) {
        const len = new DataView(buf.buffer, offset).getUint32(0)
        if (buf.length - offset - 4 < len) break
        if (!options.alive(channel)) {
          inflaters.delete(channel)
          reader.cancel().catch(() => {})
          return
        }
        deliver(
          channel,
          state.index++,
          buf.slice(offset + 4, offset + 4 + len).buffer
        )
        offset += 4 + len
      }
      state.pending = buf.slice(offset)
    }
  }
  function closeInflater(channel) {
    const inflater = inflaters.get(channel)
    if (!inflater) return
    inflaters.delete(channel)
    inflater.writer.abort().catch(() => {})
  }

  function receiveBinary(buffer) {
    const view = new DataView(buffer)
    const kind = view.getUint8(0)
    if (kind === FRAME_TERMINAL) {
      deliver(view.getUint32(1), view.getUint32(5), buffer.slice(9))
      return
    }
    if (kind === FRAME_TERMINAL_DEFLATE) {
      inflate(view.getUint32(1), new Uint8Array(buffer, 5))
      return
    }
    if (kind === FRAME_INPUT) {
      acked(view.getUint32(1), Number(view.getBigUint64(5)))
      return
    }
    if (kind !== FRAME_RESPONSE) return
    const id = view.getUint32(1)
    const call = calls.get(id)
    if (!call) return
    const flags = view.getUint8(5)
    // 首块重新开始拼：宿主从缓存重发的整份结果覆盖之前拼了一半的。
    if (flags & FLAG_FIRST) call.parts = []
    if (!call.parts) return
    call.parts.push(new Uint8Array(buffer, 18))
    if (flags & FLAG_LAST) {
      finish(
        id,
        call,
        flags,
        view.getUint32(6),
        view.getBigUint64(10).toString(16)
      )
    }
  }

  function channelOf(terminalId, clientId) {
    for (const [channel, state] of terminals) {
      if (state.terminalId === terminalId && state.clientId === clientId)
        return channel
    }
    return undefined
  }
  function sendInput(channel, chunk) {
    const out = new Uint8Array(13 + chunk.bytes.length)
    const view = new DataView(out.buffer)
    out[0] = FRAME_INPUT
    view.setUint32(1, channel)
    view.setBigUint64(5, BigInt(chunk.offset))
    out.set(chunk.bytes, 13)
    terminalLine.send(out)
  }
  function acked(channel, end) {
    const state = terminals.get(channel)
    if (!state) return
    while (
      state.chunks.length &&
      state.chunks[0].offset + state.chunks[0].bytes.length <= end
    ) {
      state.chunks.shift()
    }
  }
  // 专线重连：没确认的输入从原偏移补发（宿主去重）；太旧的丢弃，宿主见偏移跳过就跳过。
  function resendInput() {
    const now = performance.now()
    let dropped = false
    for (const [channel, state] of terminals) {
      state.chunks = state.chunks.filter((chunk) => {
        if (now - chunk.at <= STALE_INPUT_MS) return true
        dropped = true
        return false
      })
      for (const chunk of state.chunks) sendInput(channel, chunk)
    }
    if (dropped) {
      options.notice(
        navigator.language.startsWith("zh")
          ? "离线期间的终端输入未发送"
          : "Terminal input typed while offline was not sent"
      )
    }
  }
  // 宿主丢了 attach：给每路终端一个空包，前端判为无效包而重新同步（重新 attach）。
  function resyncTerminals() {
    const all = [...terminals]
    terminals.clear()
    for (const [channel, state] of all) {
      closeInflater(channel)
      options.deliver(channel, {
        index: state.next,
        message: new ArrayBuffer(0),
      })
    }
  }

  const NOT_ATTACHED = "The terminal is not attached on this connection."

  /** 终端调用（attach / 写入 / resize / detach）；不是终端调用返回 `undefined`。 */
  function terminal(cmd, payload, headers) {
    if (cmd === "terminal_attach_channel") {
      const channel = channelOfOutput(payload.onOutput)
      terminals.set(channel, {
        terminalId: payload.terminalId,
        clientId: payload.clientId,
        offset: 0,
        chunks: [],
        next: 0,
      })
      return ipc(cmd, payload, headers, terminalLine).catch((error) => {
        terminals.delete(channel)
        throw error
      })
    }
    if (cmd === "terminal_write_attached_raw") {
      const channel = channelOf(
        decodeURIComponent(headers["x-berth-terminal-id"] || ""),
        decodeURIComponent(headers["x-berth-client-id"] || "")
      )
      if (channel === undefined) return Promise.reject(NOT_ATTACHED)
      const state = terminals.get(channel)
      const chunk = {
        offset: state.offset,
        bytes: serialize(payload).data.slice(),
        at: performance.now(),
      }
      state.offset += chunk.bytes.length
      state.chunks.push(chunk)
      sendInput(channel, chunk)
      return Promise.resolve(null)
    }
    if (cmd === "terminal_resize_attached") {
      const channel = channelOf(payload.terminalId, payload.clientId)
      if (channel === undefined) return Promise.reject(NOT_ATTACHED)
      return ipc(
        cmd,
        { ch: channel, rows: payload.rows, cols: payload.cols },
        headers,
        terminalLine
      )
    }
    if (cmd === "terminal_detach") {
      const channel = channelOf(payload.terminalId, payload.clientId)
      if (channel !== undefined) {
        terminals.delete(channel)
        closeInflater(channel)
      }
      return ipc(cmd, payload, headers, terminalLine)
    }
    return undefined
  }

  // 线路：一条 WebSocket，断了就退避重连，新连接接管宿主上的队列，断线期间的消息补发。
  function createLine(path, deadMs, handlers) {
    // 当前连接；地址还在取（`options.url` 异步）时是一个占位对象。
    let socket = null
    // 收到的数据消息条数（不含 resumed 与心跳）：重连时告诉宿主，旧连接上丢的由它补发。
    let received = 0
    let everConnected = false
    let retryDelay = 500
    let retryTimer = null
    let idleTimer = null
    let lostAt = null
    let lastReceivedAt = performance.now()
    // 在途 ping 的发出时间；收到 pong 清空。
    let pingAt = null
    let attempts = 0
    const line = {
      open: false,
      connections: 0,
      send(data) {
        if (line.open) socket.send(data)
        return line.open
      },
      ping,
      wake,
      // 进后台：不再 ping，看门狗换回宿主心跳的节奏。
      relax() {
        if (line.open) watchdog(socket, IDLE_MS, "silent")
      },
      close(code, reason) {
        if (socket instanceof WebSocket) socket.close(code, reason)
      },
    }
    function watchdog(ws, ms, reason) {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => drop(ws, reason), ms)
    }
    function connect() {
      clearTimeout(retryTimer)
      retryTimer = null
      attempts += 1
      const pending = {}
      socket = pending
      Promise.resolve()
        .then(() => options.url(path))
        .then(
          (base) => {
            if (socket === pending) open(base)
          },
          (error) => {
            if (socket !== pending) return
            handlers.state?.(false, error)
            retry()
          }
        )
    }
    function open(base) {
      const ws = new WebSocket(
        `${base}?client=${client}&received=${received}${DEFLATE ? "&z=1" : ""}`
      )
      ws.binaryType = "arraybuffer"
      socket = ws
      watchdog(ws, CONNECT_MS, "connect timeout")
      ws.onopen = () => {
        if (socket !== ws) return
        line.open = true
        line.connections += 1
        lastReceivedAt = performance.now()
        pingAt = null
        retryDelay = 500
        watchdog(ws, foreground() ? deadMs : IDLE_MS, "silent")
        handlers.open()
        handlers.state?.(true, null)
      }
      ws.onmessage = (event) => {
        if (socket !== ws) return
        lastReceivedAt = performance.now()
        watchdog(ws, foreground() ? deadMs : IDLE_MS, "silent")
        if (typeof event.data !== "string") {
          received += 1
          receiveBinary(event.data)
          return
        }
        const message = JSON.parse(event.data)
        if (message.pong) {
          pingAt = null
          return
        }
        if (message.resumed !== undefined) {
          const outage =
            lostAt === null ? 0 : Math.round(performance.now() - lostAt)
          if (outage > LOG_OUTAGE_MS) {
            control(
              "__log",
              `${path} reconnected after ${outage}ms attempts=${attempts} resumed=${message.resumed}`
            )
          }
          lostAt = null
          attempts = 0
          if (everConnected && !message.resumed) handlers.reset()
          everConnected = true
          return
        }
        if (message.e === undefined) return
        received += 1
        options.onEvent(message.e, message.p)
      }
      ws.onclose = (event) => drop(ws, `close ${event.code}`)
    }
    // 弃用这条连接并安排重连；已死的连接 close 可能很久才回调，不等它。
    function drop(ws, reason) {
      if (socket !== ws) return
      const wasOpen = line.open
      socket = null
      line.open = false
      if (wasOpen) {
        // 进 outbox，重连后再发：旧连接已不可信。
        const silent = Math.round(performance.now() - lastReceivedAt)
        control(
          "__log",
          `${path} drop ${reason} silent=${silent}ms pending=${calls.size}`
        )
      }
      handlers.state?.(false, reason)
      clearTimeout(idleTimer)
      try {
        ws.close()
      } catch {
        // 已关闭。
      }
      retry()
    }
    function retry() {
      socket = null
      if (lostAt === null) lostAt = performance.now()
      retryTimer = setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    }
    function ping() {
      if (!line.open) return
      if (pingAt !== null) {
        if (performance.now() - pingAt > deadMs) drop(socket, "no pong")
        return
      }
      pingAt = performance.now()
      try {
        socket.send("ping")
      } catch {
        drop(socket, "ping failed")
      }
    }
    // 线路可能刚恢复：没连着就立刻重连（不等退避）；连着就探测，死了再重建。
    function wake() {
      if (!socket) {
        retryDelay = 500
        connect()
        return
      }
      if (!line.open) return
      const ws = socket
      pingAt = null
      ping()
      if (socket === ws) watchdog(ws, PROBE_MS, "probe")
    }
    connect()
    return line
  }

  // 宿主按 id 去重：已执行的补发结果，没收到的才执行。
  function resendCalls(line) {
    for (const call of calls.values())
      if (call.line === line) line.send(call.frame)
  }
  function reset() {
    resyncTerminals()
    options.onReset()
  }
  const commands = createLine("/__berth/ws", COMMAND_DEAD_MS, {
    open() {
      if (events.length > 0) syncSubscriptions()
      for (const data of outbox.splice(0)) commands.send(data)
      resendCalls(commands)
    },
    reset,
    state: options.onState,
  })
  const terminalLine = createLine("/__berth/term", TERMINAL_DEAD_MS, {
    open() {
      resendCalls(terminalLine)
      resendInput()
    },
    reset,
  })
  const lines = [commands, terminalLine]

  setInterval(() => {
    if (foreground()) for (const line of lines) line.ping()
  }, PING_MS)
  // 页面真正关掉（刷新、关标签页；进 bfcache 不算）：告诉宿主立即丢弃这一页，不等它超时。
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) for (const line of lines) line.close(4000, "bye")
  })
  const wakeAll = () => {
    for (const line of lines) line.wake()
  }
  document.addEventListener("visibilitychange", () => {
    if (foreground()) wakeAll()
    else {
      hiddenAt = performance.now()
      for (const line of lines) line.relax()
    }
  })
  window.addEventListener("online", wakeAll)

  return {
    /** 发一条命令（`payload` 按 Tauri IPC 序列化）；终端命令走专线。 */
    call(cmd, payload, headers = {}) {
      return (
        terminal(cmd, payload, headers) ?? ipc(cmd, payload, headers, commands)
      )
    },
    /** 要收的事件名（全量替换）。 */
    setEvents(names) {
      events = names
      syncSubscriptions()
    },
    /** 记一行到宿主日志。 */
    log(text) {
      control("__log", text)
    },
    get open() {
      return commands.open
    },
  }
}
