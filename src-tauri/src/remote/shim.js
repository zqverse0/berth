// 浏览器经 URL 打开 Berth 时注入（`remote/mod.rs` 插在 <head> 最前，前面接着协议客户端
// `src/lib/transport/remote-line.js` 的 `createRemoteSession`）：实现 `window.__TAURI_INTERNALS__`，
// 让桌面前端原样运行。协议对照 tauri 的 core.js / ipc-protocol.js；连接、补发、终端专线都在协议客户端里。
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
  function unlisten(event, eventId) {
    const ids = listeners.get(event)
    if (!ids) return
    const handler = ids.get(eventId)
    if (handler !== undefined) callbacks.delete(handler)
    ids.delete(eventId)
    if (ids.size === 0) {
      listeners.delete(event)
      session.setEvents([...listeners.keys()])
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

  const session = createRemoteSession({
    url: (path) =>
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`,
    deliver: runCallback,
    alive: (channel) => callbacks.has(channel),
    onEvent(name, payload) {
      const ids = listeners.get(name)
      if (!ids) return
      for (const [id, handler] of ids) {
        runCallback(handler, { event: name, id, payload })
      }
    },
    // 宿主丢了这一页的状态（重启、掉线太久、断线超过半分钟期间有事件、事件溢出）：界面已不可信，
    // 整页重载拿最新状态。
    onReset: () => location.reload(),
    notice,
  })

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
        session.setEvents([...listeners.keys()])
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

  function invoke(cmd, payload = {}, options) {
    try {
      const local = intercept(cmd, payload || {})
      if (local !== undefined) return Promise.resolve(local)
    } catch (error) {
      return Promise.reject(error)
    }
    const headers = Object.fromEntries(
      new Headers((options && options.headers) || {})
    )
    return session.call(cmd, payload || {}, headers)
  }

  // 页面报错记到宿主日志：远端浏览器（iPad Safari 等）不便打开开发者工具。
  function report(kind, error) {
    // Safari 的 stack 不含 message，单独拼上，否则日志与下面的匹配都只剩位置。
    const message = error && error.message ? `${error.message}\n` : ""
    const text = error && error.stack ? message + error.stack : String(error)
    session.log(
      `${kind} ${location.pathname} ${navigator.userAgent}\n${text}`.slice(
        0,
        4000
      )
    )
    // dev 前端改过代码：本页没有热更新（见上方 WebSocket），按需加载的新代码块与旧模块对不上。
    // 手机唤醒时网络未就绪或 chunk 已换代，按需加载会 `Failed to load chunk`，同样重载。
    // 整页重载拿新代码；60 秒内只重载一次，真有 bug 时不至于循环刷新。
    if (
      text.includes("module factory is not available") ||
      text.includes("Failed to load chunk")
    ) {
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
