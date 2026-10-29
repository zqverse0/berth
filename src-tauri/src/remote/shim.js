// 浏览器经 tailnet 打开 Berth 时注入（`remote/mod.rs` 插在 <head> 最前）：实现
// `window.__TAURI_INTERNALS__`，让桌面前端原样运行。协议对照 tauri 的 core.js / ipc-protocol.js。
// 两条 WebSocket（帧格式见 `remote/mod.rs` 顶部）：命令线 /__berth/ws 走命令与事件；终端专线
// /__berth/term 只走终端（attach / resize / detach、按键字节流、输出）。按键不再是一次次命令：
// 本地入队即返回，按字节偏移可靠送达，断线重连后从宿主确认的位置补发，不丢也不重复。
// - 会动到宿主桌面的调用（窗口、对话框、打开外部程序、更新重启）在这里改成浏览器行为或空操作。
;(function () {
  if (window.__TAURI_INTERNALS__) return

  // http 非 localhost 不是安全上下文：没有 crypto.randomUUID，前端有多处在用。
  if (!crypto.randomUUID) {
    crypto.randomUUID = function () {
      const b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }
  }

  // Next dev 的热更新 WebSocket 连不上宿主，重连 12 次后会整页重载（约 43 秒一次）。
  // 给它一个永远停在 CONNECTING 的假连接：不触发断线，也就不重载；远端要新代码时手动刷新。
  const NativeWebSocket = window.WebSocket
  window.WebSocket = function (url, protocols) {
    if (String(url).includes("/_next/webpack-hmr")) {
      return { readyState: 0, OPEN: 1, send() {}, close() {} }
    }
    return new NativeWebSocket(url, protocols)
  }
  Object.assign(window.WebSocket, NativeWebSocket)
  window.WebSocket.prototype = NativeWebSocket.prototype

  const client = crypto.randomUUID()
  // 同一命令同一小请求体的上次结果：宿主算出结果未变只回「未变」（轮询省带宽）。
  const ETAG_MAX_BODY = 2048
  // 超过这么久的命令记到宿主日志（总耗时 vs 宿主执行耗时），用来定位远程卡顿。
  const SLOW_IPC_MS = 3000
  const lastResult = new Map()
  // 断线前没送到的终端输入，重连时已过这么久就丢弃并提示：断线期间敲的键不在很久之后突然执行。
  const STALE_INPUT_MS = 10000
  // 终端专线开关：false 时终端调用走命令线（旧路径），专线出问题时回退用。
  const TERM_LINE = true
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
  // 能解 deflate-raw 就让宿主压缩终端输出（iOS Safari 16.4+）。
  const DEFLATE = (() => {
    try {
      new DecompressionStream("deflate-raw")
      return true
    } catch {
      return false
    }
  })()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const callbacks = new Map()
  function uid() {
    return crypto.getRandomValues(new Uint32Array(1))[0]
  }
  function registerCallback(callback, once) {
    const id = uid()
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id)
      return callback && callback(data)
    })
    return id
  }
  function runCallback(id, data) {
    const callback = callbacks.get(id)
    if (callback) callback(data)
  }

  // 事件名 → (eventId → 回调 id)。
  const listeners = new Map()
  let nextEventId = 1
  let subscribeTimer = null
  function syncSubscriptions() {
    clearTimeout(subscribeTimer)
    subscribeTimer = setTimeout(() => {
      control("__subscribe", JSON.stringify([...listeners.keys()]))
    }, 20)
  }
  function unlisten(event, eventId) {
    const ids = listeners.get(event)
    if (!ids) return
    const handler = ids.get(eventId)
    if (handler !== undefined) callbacks.delete(handler)
    ids.delete(eventId)
    if (ids.size === 0) {
      listeners.delete(event)
      syncSubscriptions()
    }
  }

  // `[u32 meta 长度][meta JSON][请求体]`
  function frame(meta, body) {
    const head = encoder.encode(JSON.stringify(meta))
    const out = new Uint8Array(4 + head.length + body.length)
    new DataView(out.buffer).setUint32(0, head.length)
    out.set(head, 4)
    out.set(body, 4 + head.length)
    return out
  }

  // 连接断开时：没有 id 的控制消息（日志）先攒着；带 id 的命令留在 calls 里，连上后重发。
  const outbox = []
  function control(cmd, text) {
    const data = frame({ cmd }, encoder.encode(text))
    if (!commands.send(data) && cmd === "__log") outbox.push(data)
  }

  function processIpcMessage(payload) {
    if (
      payload instanceof ArrayBuffer ||
      ArrayBuffer.isView(payload) ||
      Array.isArray(payload)
    ) {
      const data = Array.isArray(payload)
        ? new Uint8Array(payload)
        : payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : new Uint8Array(
              payload.buffer,
              payload.byteOffset,
              payload.byteLength
            )
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

  // id → 进行中的命令；断线重连后按 id 顺序在原线路重发，宿主按 id 去重（已执行的补发结果）。
  const calls = new Map()
  let nextCallId = 1
  function ipc(cmd, payload, options, line = commands) {
    const { json, data } = processIpcMessage(payload)
    const key = json && data.length <= ETAG_MAX_BODY ? `${cmd}\n${data}` : null
    const cached = key ? lastResult.get(key) : undefined
    const headers = Object.fromEntries(
      new Headers((options && options.headers) || {})
    )
    const id = nextCallId++
    const meta = { id, cmd, json, h: headers }
    // 带输入序号（终端写入、resize）：宿主在输入道上按到达顺序逐个执行。
    if (
      "x-berth-input-sequence" in headers ||
      (json &&
        payload &&
        typeof payload === "object" &&
        "inputSequence" in payload)
    ) {
      meta.lane = true
    }
    if (cached) meta.etag = cached.etag
    const body = json ? encoder.encode(data) : data
    return new Promise((resolve, reject) => {
      const call = {
        cmd,
        key,
        cached,
        meta,
        input: !json && meta.lane === true,
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
    if (total > SLOW_IPC_MS) {
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
        // attach 快照：ANSI 原始字节在手机上补成前端要的 base64。
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

  function toBase64(bytes) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        resolve(reader.result.slice(reader.result.indexOf(",") + 1))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(new Blob([bytes]))
    })
  }

  // 每路终端一个解压流：宿主共享一个 deflate 上下文，块必须按序喂进同一个流。
  const inflaters = new Map()
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
      readPackets(channel, state, stream.readable.getReader())
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
        if (!callbacks.has(channel)) {
          inflaters.delete(channel)
          reader.cancel().catch(() => {})
          return
        }
        runCallback(channel, {
          index: state.index++,
          message: buf.slice(offset + 4, offset + 4 + len).buffer,
        })
        offset += 4 + len
      }
      state.pending = buf.slice(offset)
    }
  }

  function receiveBinary(buffer) {
    const view = new DataView(buffer)
    const kind = view.getUint8(0)
    if (kind === FRAME_TERMINAL) {
      runCallback(view.getUint32(1), {
        index: view.getUint32(5),
        message: buffer.slice(9),
      })
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

  const WINDOW_READS =
    /^(is_|inner_|outer_|scale_factor|title$|theme$|current_monitor|primary_monitor|available_monitors|monitor_from_point|cursor_position|get_)/
  const WINDOW_ROUTES = {
    open_commit_window: (a) => `/commit?folderId=${a.folderId}`,
    open_stash_window: (a) => `/stash?folderId=${a.folderId}`,
    open_push_window: (a) => `/push?folderId=${a.folderId}`,
    open_merge_window: (a) =>
      `/merge?folderId=${a.folderId}&operation=${encodeURIComponent(a.operation)}` +
      (a.upstreamCommit
        ? `&upstreamCommit=${encodeURIComponent(a.upstreamCommit)}`
        : ""),
  }
  const BROWSER_UNAVAILABLE = new Set(["perform_app_update", "restart_app"])
  const HOST_ONLY_NOOPS = new Set([
    "open_logs_dir",
    "update_traffic_light_position",
    "send_notification",
  ])

  // 返回 undefined 表示交给宿主执行。
  function intercept(cmd, args) {
    if (cmd === "plugin:event|listen") {
      const eventId = nextEventId++
      if (!listeners.has(args.event)) {
        listeners.set(args.event, new Map())
        syncSubscriptions()
      }
      listeners.get(args.event).set(eventId, args.handler)
      return eventId
    }
    if (cmd === "plugin:event|unlisten") {
      unlisten(args.event, args.eventId)
      return null
    }
    if (WINDOW_ROUTES[cmd]) {
      const path = WINDOW_ROUTES[cmd](args)
      window.open(
        path,
        cmd.replace("open_", "").replace("_window", "") + "-" + args.folderId
      )
      return { path }
    }
    if (BROWSER_UNAVAILABLE.has(cmd)) {
      throw "Not available in the browser; use the Berth desktop app."
    }
    if (HOST_ONLY_NOOPS.has(cmd)) return null
    const [, plugin, command] = /^plugin:([^|]+)\|(.+)$/.exec(cmd) || []
    if (!plugin) return undefined
    switch (plugin) {
      case "window":
      case "webview":
        if (WINDOW_READS.test(command)) return undefined
        // 浏览器打开的提交 / 推送等子页：关闭即关掉这个标签页。
        if ((command === "close" || command === "destroy") && window.opener) {
          window.close()
        }
        return null
      case "dialog":
        if (command === "message") {
          window.alert(args.message)
          return "Ok"
        }
        if (command === "ask" || command === "confirm") {
          return window.confirm(args.message)
        }
        // 文件选择框只能开在宿主桌面上：浏览器里按取消处理。
        return null
      case "opener":
        if (command === "open_url") window.open(args.url, "_blank", "noopener")
        return null
      case "process":
      case "updater":
      case "notification":
        return null
      default:
        return undefined
    }
  }

  // 终端专线上的 attach：channel → 输入缓冲。按键按累计字节偏移编号，宿主确认后丢弃。
  const terminals = new Map()
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
      notice(
        navigator.language.startsWith("zh")
          ? "离线期间的终端输入未发送"
          : "Terminal input typed while offline was not sent"
      )
    }
  }
  // 浏览器里没有前端的提示组件可用：一个几秒后消失的浮层。
  function notice(text) {
    const el = document.createElement("div")
    el.textContent = text
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;" +
      "padding:8px 14px;border-radius:8px;background:rgba(0,0,0,.8);color:#fff;" +
      "font:13px system-ui,sans-serif;pointer-events:none"
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 4000)
  }
  // 返回 undefined 表示不是专线上的调用（照旧走命令线）。
  function terminalCall(cmd, payload, options) {
    if (cmd === "terminal_attach_channel") {
      const output = payload.onOutput
      const ref =
        typeof output === "string"
          ? output
          : output && output.__TAURI_TO_IPC_KEY__()
      const channel = Number(String(ref).replace("__CHANNEL__:", ""))
      terminals.set(channel, {
        terminalId: payload.terminalId,
        clientId: payload.clientId,
        offset: 0,
        chunks: [],
      })
      return ipc(cmd, payload, options, terminalLine).catch((error) => {
        terminals.delete(channel)
        throw error
      })
    }
    if (cmd === "terminal_write_attached_raw") {
      const headers = Object.fromEntries(
        new Headers((options && options.headers) || {})
      )
      const channel = channelOf(
        decodeURIComponent(headers["x-berth-terminal-id"] || ""),
        decodeURIComponent(headers["x-berth-client-id"] || "")
      )
      if (channel === undefined) return undefined
      const state = terminals.get(channel)
      const { data } = processIpcMessage(payload)
      const chunk = {
        offset: state.offset,
        bytes: data.slice(),
        at: performance.now(),
      }
      state.offset += chunk.bytes.length
      state.chunks.push(chunk)
      sendInput(channel, chunk)
      return Promise.resolve(null)
    }
    if (cmd === "terminal_resize_attached") {
      const channel = channelOf(payload.terminalId, payload.clientId)
      if (channel === undefined) return undefined
      return ipc(
        cmd,
        { ch: channel, rows: payload.rows, cols: payload.cols },
        options,
        terminalLine
      )
    }
    if (cmd === "terminal_detach") {
      const channel = channelOf(payload.terminalId, payload.clientId)
      if (channel === undefined) return undefined
      terminals.delete(channel)
      const inflater = inflaters.get(channel)
      if (inflater) {
        inflaters.delete(channel)
        inflater.writer.close().catch(() => {})
      }
      return ipc(cmd, payload, options, terminalLine)
    }
    return undefined
  }

  function invoke(cmd, payload = {}, options) {
    if (TERM_LINE) {
      const routed = terminalCall(cmd, payload || {}, options)
      if (routed !== undefined) return routed
    }
    try {
      const local = intercept(cmd, payload || {})
      if (local !== undefined) return Promise.resolve(local)
    } catch (error) {
      return Promise.reject(error)
    }
    return ipc(cmd, payload, options)
  }

  function dispatch(message) {
    if (message.e === undefined) return
    const ids = listeners.get(message.e)
    if (!ids) return
    for (const [id, handler] of ids) {
      runCallback(handler, { event: message.e, id, payload: message.p })
    }
  }

  // 线路：一条 WebSocket，断了就退避重连，新连接接管宿主上的队列，断线期间的消息补发。
  // 前台时每 PING_MS 发 ping：一段时间（各线路的 deadMs）没收到任何数据、或 ping 没等到 pong，就当连接已死立刻重建。
  // 对端 RST 时页面常收不到 close（实测手机上要等 40 秒）；下行可能还在收数据而上行已死，
  // 只看「有没有数据进来」会把它当活的，用户的输入全丢。
  // 后台不 ping（省电），靠宿主 15 秒心跳，IDLE_MS 没数据才重连（iOS 切后台后常无声断开）。
  // 新连接 CONNECT_MS 内没建立就放弃重来：手机回前台时线路可能还没恢复，那次握手会一直挂着。
  const PING_MS = 2000
  // 专线上只有小帧，pong 不会排在大块后面；命令线可能正下载大响应，慢链路上给足余量。
  const TERMINAL_DEAD_MS = 5000
  const COMMAND_DEAD_MS = 10000
  const IDLE_MS = 40000
  const CONNECT_MS = 5000
  // 回到前台时用 ping 探测旧连接，这么久没回音就重建。
  const PROBE_MS = 3000
  const RETRY_MAX_MS = 4000
  // 断线超过这么久才记日志（真机上看重连到底花了多久）。
  const LOG_OUTAGE_MS = 3000
  const foreground = () => document.visibilityState === "visible"
  function createLine(path, deadMs, handlers) {
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
        if (socket) socket.close(code, reason)
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
      const scheme = location.protocol === "https:" ? "wss:" : "ws:"
      const ws = new NativeWebSocket(
        `${scheme}//${location.host}${path}?client=${client}&received=${received}${DEFLATE ? "&z=1" : ""}`
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
          // 宿主丢了这条线的状态（重启、掉线太久、断线期间事件溢出）：界面已不可信，整页重载。
          if (everConnected && !message.resumed) location.reload()
          everConnected = true
          return
        }
        if (message.e !== undefined) received += 1
        dispatch(message)
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
      if (lostAt === null) lostAt = performance.now()
      clearTimeout(idleTimer)
      try {
        ws.close()
      } catch {
        // 已关闭。
      }
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

  const commands = createLine("/__berth/ws", COMMAND_DEAD_MS, {
    open() {
      if (listeners.size > 0) syncSubscriptions()
      for (const data of outbox.splice(0)) commands.send(data)
      resendCalls(commands)
    },
  })
  const terminalLine = TERM_LINE
    ? createLine("/__berth/term", TERMINAL_DEAD_MS, {
        open() {
          resendCalls(terminalLine)
          resendInput()
        },
      })
    : commands
  const lines = TERM_LINE ? [commands, terminalLine] : [commands]
  // 宿主按 id 去重：已执行的补发结果，没收到的才执行。
  function resendCalls(line) {
    const now = performance.now()
    for (const call of calls.values()) {
      if (call.line !== line) continue
      // 命令线上的旧式终端输入（专线关闭时）：太旧的清空内容再补发，序号照旧。
      if (call.input && now - call.started > STALE_INPUT_MS) {
        call.frame = frame(call.meta, new Uint8Array(0))
      }
      line.send(call.frame)
    }
  }
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
    else for (const line of lines) line.relax()
  })
  window.addEventListener("online", wakeAll)

  // 页面报错记到宿主日志：远端浏览器（iPad Safari 等）不便打开开发者工具。
  function report(kind, error) {
    const text = error && error.stack ? error.stack : String(error)
    control(
      "__log",
      `${kind} ${location.pathname} ${navigator.userAgent}\n${text}`.slice(
        0,
        4000
      )
    )
    // dev 前端改过代码：本页没有热更新（见上方 WebSocket），按需加载的新代码块与旧模块对不上。
    // 整页重载拿新代码；60 秒内只重载一次，真有 bug 时不至于循环刷新。
    if (text.includes("module factory is not available")) {
      const last = Number(sessionStorage.getItem("berth-stale-reload") || 0)
      if (Date.now() - last > 60000) {
        sessionStorage.setItem("berth-stale-reload", String(Date.now()))
        location.reload()
      }
    }
  }
  window.addEventListener("error", (event) =>
    report("error", event.error || event.message)
  )
  window.addEventListener("unhandledrejection", (event) =>
    report("rejection", event.reason)
  )

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: registerCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc: (path) => path,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: { path: { sep: "/", delimiter: ":" } },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: unlisten }
  window.isTauri = true
  window.__BERTH_REMOTE__ = true
})()
