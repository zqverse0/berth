// 页面环境的桥（docs/plugin-architecture.md §2.4）：宿主把它注入插件 html 的最前面，页面里的
// `window.berth` 就是它。与宿主只经 postMessage 说 JSON-RPC 2.0（§2.2）：
//   页面 → 宿主：请求 `<命名空间>.<方法>`；通知 page.hello、editor.change {content}、ui.key {key, code, …修饰键}
//   宿主 → 页面：通知 page.init {context, theme, vars, locale, platform, berthVersion}、ui.theme {theme, vars}、
//                 editor.externalChange {content}、editor.drop {…}；请求 editor.render（页面回结果）
;(() => {
  if (window.berth) return
  const host = window.parent
  const post = (message) =>
    host.postMessage({ jsonrpc: "2.0", ...message }, "*")
  const notify = (method, params) => post({ method, params })

  // 不透明源（远程浏览器里的沙箱）访问 localStorage 会抛错：换成内存实现，页面库照常运行。
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      void window[name]
    } catch {
      const data = new Map()
      Object.defineProperty(window, name, {
        configurable: true,
        value: {
          getItem: (key) =>
            data.has(String(key)) ? data.get(String(key)) : null,
          setItem: (key, value) => void data.set(String(key), String(value)),
          removeItem: (key) => void data.delete(String(key)),
          clear: () => data.clear(),
          key: (index) => [...data.keys()][index] ?? null,
          get length() {
            return data.size
          },
        },
      })
    }
  }

  let seq = 0
  const pending = new Map()
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      post({ id, method, params })
    })

  const listeners = new Map()
  const on = (event, listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
    return () => listeners.get(event).delete(listener)
  }
  const emit = (event, data) => {
    for (const listener of listeners.get(event) ?? []) {
      try {
        listener(data)
      } catch (error) {
        console.error(error)
      }
    }
  }

  let init = null
  let content = ""
  let theme = "light"
  let markReady
  const ready = new Promise((resolve) => (markReady = resolve))

  const applyTheme = (next, vars) => {
    theme = next === "dark" ? "dark" : "light"
    const root = document.documentElement
    root.classList.toggle("dark", theme === "dark")
    root.style.colorScheme = theme
    for (const [name, value] of Object.entries(vars ?? {}))
      root.style.setProperty(name, value)
  }

  // 插件在这里把攒着的改动交出去（防抖中的 change）：按键转发、失焦、隐藏前都先调。
  const flushers = new Set()
  const flush = () => {
    for (const flusher of flushers) {
      try {
        flusher()
      } catch (error) {
        console.error(error)
      }
    }
  }
  window.addEventListener("blur", flush)
  window.addEventListener("pagehide", flush)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush()
  })

  // 带修饰键的按键交给宿主快捷键；保存归宿主，页面里不再处理 Ctrl/⌘+S。
  window.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey || event.altKey)) return
      flush()
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      const { key, code, ctrlKey, metaKey, altKey, shiftKey } = event
      notify("ui.key", { key, code, ctrlKey, metaKey, altKey, shiftKey })
    },
    true
  )

  const handlers = new Map()
  let held = []
  const answer = (message) =>
    Promise.resolve()
      .then(() => handlers.get(message.method)(message.params))
      .then(
        (result) => post({ id: message.id, result: result ?? null }),
        (error) =>
          post({
            id: message.id,
            error: {
              code: -32001,
              message: String(error?.message ?? error),
              data: { reason: "internal" },
            },
          })
      )
  const handle = (method, handler) => {
    handlers.set(method, handler)
    const ready = held.filter((message) => message.method === method)
    held = held.filter((message) => message.method !== method)
    ready.forEach(answer)
    return () => handlers.delete(method)
  }

  // 宿主调页面的钩子（`editor.render`）
  const hooks = { "editor.render": "render" }
  const events = {
    "ui.theme": "theme",
    "editor.externalChange": "externalChange",
    "editor.drop": "drop",
  }

  window.addEventListener("message", (event) => {
    if (event.source !== host) return
    const message = event.data
    if (!message || message.jsonrpc !== "2.0") return
    if (!message.method) {
      // 回复：页面发出的请求
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message)
        error.reason = message.error.data?.reason ?? "internal"
        waiter.reject(error)
      } else {
        waiter.resolve(message.result)
      }
      return
    }
    const params = message.params ?? {}
    if (message.method === "page.init") {
      init = params
      content = params.context?.content ?? ""
      applyTheme(params.theme, params.vars)
      markReady()
      return
    }
    if (message.id !== undefined && hooks[message.method]) {
      const request = { id: message.id, method: hooks[message.method], params }
      // 页面脚本（module，晚于桥运行）还没登记处理函数时先存着，登记时补上
      if (handlers.has(request.method)) answer(request)
      else held.push(request)
      return
    }
    const name = events[message.method]
    if (!name) return
    if (name === "theme") applyTheme(params.theme, params.vars)
    if (name === "externalChange") content = String(params.content ?? "")
    emit(
      name,
      name === "theme" ? theme : name === "externalChange" ? content : params
    )
  })

  const context = () => {
    const raw = init?.context ?? {}
    if (raw.kind !== "editor") return raw
    return {
      ...raw,
      load: () => Promise.resolve(content),
      change: (next) => {
        content = String(next)
        notify("editor.change", { content })
      },
      onExternalChange: (listener) => on("externalChange", listener),
      onFlush: (flusher) => {
        flushers.add(flusher)
        return () => flushers.delete(flusher)
      },
      onDrop: (listener) => on("drop", listener),
      onRender: (handler) => handle("render", handler),
    }
  }

  window.berth = {
    ready,
    files: {
      readText: (path) => call("files.readText", { path }),
      readBase64: (path) => call("files.readBase64", { path }),
      open: (path) => call("files.open", { path }),
    },
    storage: {
      get: (key) =>
        call("storage.get", { key }).then((value) => value ?? undefined),
      set: (key, value) => call("storage.set", { key, value }),
      remove: (key) => call("storage.remove", { key }),
      dir: null,
    },
    scripts: {
      run: (script, input) =>
        call("scripts.run", { script, input: input ?? null }),
    },
    agent: {
      attach: (item) => call("agent.attach", item),
    },
    ui: {
      theme: () => Promise.resolve(theme),
      onTheme: (listener) => on("theme", listener),
      notify: (message, kind = "info") => call("ui.notify", { message, kind }),
      openUrl: (url) => call("ui.openUrl", { url }),
      get locale() {
        return init?.locale ?? "en"
      },
      get context() {
        return context()
      },
    },
    env: {
      get platform() {
        return init?.platform
      },
      get berthVersion() {
        return init?.berthVersion
      },
      vars: {},
      project: () => call("env.project"),
    },
  }

  notify("page.hello")
})()
