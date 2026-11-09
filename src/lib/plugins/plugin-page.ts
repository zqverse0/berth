import { readWorkspaceFileBase64 } from "@/lib/api"
import { openUrl } from "@/lib/platform"
import { isRemoteBrowser } from "@/lib/transport/detect"
import { callPluginBackend, runPluginAction } from "@/lib/plugins/plugin-views"

/**
 * 插件页面（docs/plugin-architecture.md §2.4 页面环境）：包内 html 在沙箱 iframe 里运行，页面里的
 * `window.berth` 是宿主注入的桥（`berth-plugin-api/src/page.js`），与这里只经 postMessage 说 JSON-RPC 2.0。
 * 本模块不依赖 React：编辑器 / 侧栏页面（`PluginPageFrame`）与 Markdown 嵌入的隐藏页面共用。
 */

type Project = { id: string; name: string; root: string } | null

export type PageContext =
  | {
      kind: "editor"
      id: string
      /** `embed`：隐藏页面，只为 Markdown 嵌入渲染图片，不显示编辑界面。 */
      mode: "edit" | "embed"
      /** 文件相对 `files.*` 根的路径。 */
      path: string
      readOnly: boolean
      content: string
    }
  | { kind: "view"; id: string; params: Record<string, string> }

export interface PageHost {
  plugin: string
  permissions: readonly string[]
  /** `files.*` 的根：文件所在项目的根，不在项目里时是文件所在目录；没有时 files 不可用。 */
  root: string | null
  project: Project
  locale: string
  context: PageContext
  /** 编辑器页面交来新内容。 */
  onChange?: (content: string) => void
  /** `files.open`：在工作区打开（绝对路径）。 */
  openFile?: (absPath: string) => void
  notify?: (message: string, kind: "info" | "error") => void
  /** `agent.attach`：放进当前 Agent 的输入框（不提交）。 */
  sendToAgent?: (text: string) => void
}

export interface PageConnection {
  /** 给页面发通知（`editor.externalChange`、`editor.drop`）。 */
  send: (method: string, params: Record<string, unknown>) => void
  /** 调页面的钩子（`editor.render`），页面没回复前一直等。 */
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** 换掉宿主侧的回调与上下文（不重载页面）。 */
  update: (host: PageHost) => void
  dispose: () => void
}

/** 包内资源的地址：桌面走 `berth-plugin` 协议，远程浏览器走同源的 `/__berth/plugin/`。 */
export function pluginAssetUrl(plugin: string, path: string): string {
  const rel = [plugin, ...path.split("/")].map(encodeURIComponent).join("/")
  if (isRemoteBrowser() || typeof window === "undefined") {
    return `/__berth/plugin/${rel}`
  }
  const internals = (
    window as {
      __TAURI_INTERNALS__?: {
        convertFileSrc?: (path: string, protocol: string) => string
      }
    }
  ).__TAURI_INTERNALS__
  // `berth-plugin://localhost/`（Windows / Android 是 `http://berth-plugin.localhost/`）
  const base =
    internals?.convertFileSrc?.("", "berth-plugin") ??
    "berth-plugin://localhost/"
  return `${base}${rel}`
}

/**
 * iframe 的 sandbox：桌面协议与主窗口不同源，带 allow-same-origin 页面才能读自己的资源与存储；
 * 远程浏览器里资源与主页面同源，带上它页面就能碰到宿主，所以不带（不透明源，资源回 CORS 头）。
 */
export function pluginFrameSandbox(): string {
  return isRemoteBrowser() ? "allow-scripts" : "allow-scripts allow-same-origin"
}

/** 宿主主题变量，以 `--berth-*` 交给页面（§2.5）。 */
const THEME_VARS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "radius",
  "font-sans",
  "font-mono",
]

function themeSnapshot() {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const vars: Record<string, string> = {}
  for (const name of THEME_VARS) {
    const value = style.getPropertyValue(`--${name}`).trim()
    if (value) vars[`--berth-${name}`] = value
  }
  return {
    theme: root.classList.contains("dark") ? "dark" : "light",
    vars,
  }
}

function platform(): "linux" | "darwin" | "windows" {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent
  if (/Windows/i.test(agent)) return "windows"
  if (/Mac OS X|Macintosh/i.test(agent)) return "darwin"
  return "linux"
}

let versionPromise: Promise<string> | null = null
function berthVersion(): Promise<string> {
  versionPromise ??= import("@tauri-apps/api/app")
    .then(({ getVersion }) => getVersion())
    .catch(() => "")
  return versionPromise
}

class PageError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message)
  }
}

/** `files.*` 的路径：相对根、`/` 分隔，不许 `..` 越出根。 */
export function resolvePagePath(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) {
    throw new PageError("invalid-params", "path must be a non-empty string")
  }
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!parts.length)
        throw new PageError("denied", `${path} is outside the root`)
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  if (!parts.length || /^[a-z]:$/i.test(parts[0]) || path.startsWith("/")) {
    throw new PageError("denied", `${path} must be relative to the root`)
  }
  return parts.join("/")
}

const isAbsolutePath = (path: string) =>
  path.startsWith("/") || /^[a-z]:[\\/]/i.test(path)

const requireFiles = (host: PageHost): string => {
  if (!host.permissions.includes("project.files")) {
    throw new PageError(
      "denied",
      'files needs permission "project.files" in tool.json'
    )
  }
  if (!host.root)
    throw new PageError("unsupported", "no project root for files")
  return host.root
}

const decodeUtf8 = (base64: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  )

/** 页面的一次调用 → 宿主能力。导出给测试；不认识的方法 reject `unsupported`。 */
export async function handlePageCall(
  host: PageHost,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (method) {
    case "files.readBase64": {
      const root = requireFiles(host)
      return readWorkspaceFileBase64(root, resolvePagePath(params.path))
    }
    case "files.readText": {
      const root = requireFiles(host)
      return decodeUtf8(
        await readWorkspaceFileBase64(root, resolvePagePath(params.path))
      )
    }
    case "files.open": {
      const root = requireFiles(host)
      // 绝对路径原样打开：只把文件开给用户看，内容不回页面（想法在主项目，可能不在当前 worktree 里）。
      if (typeof params.path === "string" && isAbsolutePath(params.path)) {
        host.openFile?.(params.path)
        return null
      }
      const rel = resolvePagePath(params.path)
      host.openFile?.(`${root.replace(/[\\/]+$/, "")}/${rel}`)
      return null
    }
    case "ui.openUrl": {
      const url = String(params.url ?? "")
      if (!/^(https?:|mailto:)/i.test(url)) {
        throw new PageError(
          "invalid-params",
          "openUrl takes http(s) or mailto URLs"
        )
      }
      await openUrl(url)
      return null
    }
    case "ui.notify":
      host.notify?.(
        String(params.message ?? ""),
        params.kind === "error" ? "error" : "info"
      )
      return null
    case "agent.attach": {
      if (!host.permissions.includes("agent")) {
        throw new PageError(
          "denied",
          'agent needs permission "agent" in tool.json'
        )
      }
      if (!host.sendToAgent) {
        throw new PageError("unsupported", "agent is not available here")
      }
      host.sendToAgent(String(params.text ?? ""))
      return null
    }
    case "env.project":
      return host.project
    case "scripts.run":
      return runPluginAction({
        plugin: host.plugin,
        script: String(params.script ?? ""),
        input: params.input ?? null,
        project: host.project,
      })
  }
  const namespace = method.split(".")[0]
  if (namespace === "storage" || namespace === "data") {
    return callPluginBackend({
      plugin: host.plugin,
      method,
      params,
      project: host.project,
    })
  }
  throw new PageError("unsupported", `${method} is not available in pages`)
}

/** JSON-RPC 2.0（§2.2）：请求带 id 与 method，回复只带 id，通知只带 method。 */
type RpcMessage = {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: { reason?: string } }
}

/** 页面没发调用时，`page.init` 之后等这么久就算就绪。 */
const SETTLE_FALLBACK_MS = 400

/**
 * 接上一个已挂载的 iframe：页面每次（重）载入发 `page.hello`，宿主回 `page.init`。
 * `onSettled`：页面首屏大概画好了（首个调用已回复，或没有调用），只调一次。
 */
export function connectPluginPage(
  frame: HTMLIFrameElement,
  initial: PageHost,
  onSettled?: () => void
): PageConnection {
  let host = initial
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    // 回复送达后页面还要画一帧
    requestAnimationFrame(() => requestAnimationFrame(() => onSettled?.()))
  }
  let seq = 0
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  // 页面就绪前的通知与请求排队，`page.init` 之后按序送出
  let ready = false
  let queue: RpcMessage[] = []

  // 页面可能是不透明源（远程浏览器），只能以 "*" 投递；收方校验 source 是宿主窗口
  const deliver = (message: RpcMessage) =>
    frame.contentWindow?.postMessage(message, "*")
  const post = (message: Omit<RpcMessage, "jsonrpc">) => {
    const full: RpcMessage = { jsonrpc: "2.0", ...message }
    // 回复页面自己的请求不排队（页面已就绪才会发请求）
    if (!ready && full.method) queue.push(full)
    else deliver(full)
  }

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return
    const message = event.data as RpcMessage | null
    if (!message || message.jsonrpc !== "2.0") return
    const params = message.params ?? {}
    if (!message.method) {
      const waiter = waiting.get(Number(message.id))
      if (!waiter) return
      waiting.delete(Number(message.id))
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
      return
    }
    if (message.id !== undefined) {
      const id = message.id
      handlePageCall(host, message.method, params)
        .then(
          (result) => post({ id, result: result ?? null }),
          (error: unknown) =>
            post({
              id,
              error: {
                code: -32001,
                message: error instanceof Error ? error.message : String(error),
                data: {
                  reason:
                    error instanceof PageError ? error.reason : "internal",
                },
              },
            })
        )
        .finally(settle)
      return
    }
    switch (message.method) {
      case "page.hello":
        ready = false
        void berthVersion().then((version) => {
          deliver({
            jsonrpc: "2.0",
            method: "page.init",
            params: {
              context: host.context,
              locale: host.locale,
              platform: platform(),
              berthVersion: version,
              ...themeSnapshot(),
            },
          })
          ready = true
          const pending = queue
          queue = []
          pending.forEach(deliver)
          setTimeout(settle, SETTLE_FALLBACK_MS)
        })
        break
      case "editor.change":
        if (host.context.kind === "editor" && !host.context.readOnly) {
          host.onChange?.(String(params.content ?? ""))
        }
        break
      case "ui.key":
        // 带修饰键的按键交给宿主快捷键：从 iframe 元素派发，冒泡经过它所在的面板到 window
        frame.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: String(params.key ?? ""),
            code: String(params.code ?? ""),
            ctrlKey: params.ctrlKey === true,
            metaKey: params.metaKey === true,
            altKey: params.altKey === true,
            shiftKey: params.shiftKey === true,
            bubbles: true,
            cancelable: true,
          })
        )
        break
    }
  }
  window.addEventListener("message", onMessage)

  // 宿主换主题（切 `dark` 类、改外观变量）时推给页面
  let lastTheme = ""
  const themeObserver = new MutationObserver(() => {
    const snapshot = themeSnapshot()
    const key = JSON.stringify(snapshot)
    if (key === lastTheme) return
    lastTheme = key
    post({ method: "ui.theme", params: snapshot })
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  })

  return {
    send: (method, params) => post({ method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        waiting.set(id, { resolve, reject })
        post({ id, method, params })
      }),
    update: (next) => {
      host = next
    },
    dispose: () => {
      window.removeEventListener("message", onMessage)
      themeObserver.disconnect()
      for (const waiter of waiting.values())
        waiter.reject(new Error("page closed"))
      waiting.clear()
    },
  }
}
