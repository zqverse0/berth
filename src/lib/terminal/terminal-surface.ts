import type { IDisposable, Terminal } from "@xterm/xterm"

const DEFAULT_FONT_READY_TIMEOUT_MS = 1500

export interface TerminalFontSet {
  check: (font: string) => boolean
  ready: PromiseLike<unknown>
}

export async function waitForTerminalFont(
  fontFamily: string,
  options?: {
    fonts?: TerminalFontSet
    timeoutMs?: number
  }
): Promise<"ready" | "timeout" | "unsupported"> {
  const fonts =
    options?.fonts ??
    (typeof document === "undefined" ? undefined : document.fonts)
  if (!fonts) return "unsupported"
  if (fonts.check(`16px ${fontFamily}`)) return "ready"

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve("timeout"),
      options?.timeoutMs ?? DEFAULT_FONT_READY_TIMEOUT_MS
    )
  })
  const ready: Promise<"ready"> = Promise.resolve(fonts.ready).then(
    () => "ready"
  )
  const result = await Promise.race([ready, timeout])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  return result
}

/**
 * xterm 的 DOM 渲染器每次 resize 都把同一段 CSS 写回自己的 `<style>`。WebKitGTK
 * 对任何 `<style>` 写入都会重算整个文档的样式，本应用一次约 100ms，正好卡在
 * resize 之后那一帧。内容没变时跳过写入；主题等真实变更照常生效。
 */
export function skipUnchangedXtermStyleWrites(host: HTMLElement): void {
  const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")
  if (!text?.get || !text.set) return
  const { get, set } = text
  for (const style of host.querySelectorAll<HTMLStyleElement>(
    ".xterm-screen > style"
  )) {
    Object.defineProperty(style, "textContent", {
      configurable: true,
      get() {
        return get.call(this)
      },
      set(value: string | null) {
        if (get.call(this) !== value) set.call(this, value)
      },
    })
  }
}

type HistoryResetTerminal = Pick<
  Terminal,
  "parser" | "onWriteParsed" | "scrollToBottom" | "buffer"
>

/**
 * 用户往上翻着时，终端状态突变让「翻到的位置」失去意义，xterm 却保留「用户在往上翻」状态，
 * 视口停在旧处不再跟底部（要按回车才回来）。这里在两种突变后回到跟随底部：
 * - 清 scrollback（ED3 `CSI 3 J`）：Ink（Claude Code 等）、pi、opencode 改尺寸或清屏时整屏
 *   重绘都会发，shell 的 `clear` 也会；不处理时视口停在重绘内容第一行。
 * - 退出全屏程序（vim、less、分页器离开 alternate screen）：不处理时回到进入前翻到的旧位置。
 * 普通输出、清屏（ED2）、改尺寸重排时位置仍有效，不动。
 */
export function followBottomOnHistoryReset(
  term: HistoryResetTerminal
): IDisposable {
  let cleared = false
  const handler = term.parser.registerCsiHandler({ final: "J" }, (params) => {
    if (params[0] === 3) cleared = true
    // 交回 xterm 的默认处理，真正清屏仍由它做
    return false
  })
  const parsed = term.onWriteParsed(() => {
    if (!cleared) return
    cleared = false
    term.scrollToBottom()
  })
  const bufferChange = term.buffer.onBufferChange((buffer) => {
    if (buffer.type === "normal") term.scrollToBottom()
  })
  return {
    dispose: () => {
      handler.dispose()
      parsed.dispose()
      bufferChange.dispose()
    },
  }
}

/**
 * 键盘弹出时终端上移的距离：保持光标行可见，同时尽量露出底部（TUI 的输入框、状态栏
 * 都在底部）。`fullHeight` 是终端保持的原高度，`visibleHeight` 是键盘上方剩下的高度。
 */
export function keyboardPanOffset(options: {
  fullHeight: number
  visibleHeight: number
  rows: number
  cursorY: number
}): number {
  const overflow = options.fullHeight - options.visibleHeight
  if (overflow <= 0) return 0
  const rowHeight = options.fullHeight / Math.max(options.rows, 1)
  return Math.min(overflow, Math.max(0, options.cursorY * rowHeight))
}

/** 低于这个差值当作浏览器工具栏伸缩，不是软键盘。 */
const SOFT_KEYBOARD_MIN_HEIGHT = 120

function softKeyboardOpen(): boolean {
  const viewport = window.visualViewport
  return (
    !!viewport &&
    window.innerHeight - viewport.height > SOFT_KEYBOARD_MIN_HEIGHT
  )
}

type KeyboardPanTerminal = Pick<Terminal, "rows" | "buffer" | "onCursorMove">

/**
 * 手机软键盘开合只改高度不改宽度。照常 resize 会让每个普通屏 TUI（Claude Code、pi、
 * Ink 系）收到 SIGWINCH 后清 scrollback 整屏重绘，远程还要重传整段内容。这里在
 * 「同宽变矮」时把终端钉在原高度、整体上移露出光标行，PTY 行数不变；宽度变化（旋转）
 * 或高度恢复时解除，照常 resize。思路同 termux-nowinch：丢弃仅行数变化的 SIGWINCH。
 *
 * 键盘是否弹出看 visualViewport 比布局视口矮了多少（iOS Safari、Android Chrome 都只缩
 * visualViewport）；两者一起缩的浏览器判断不出，退回照常 resize。键行出现等别的同宽缩高
 * 不在键盘期间，照常 resize。
 */
export function bindMobileKeyboardPan(options: {
  /** xterm 的容器（被钉高、被平移）。 */
  host: HTMLElement
  /** 外层裁切框，尺寸随键盘变化。 */
  frame: HTMLElement
  term: KeyboardPanTerminal
  isEnabled: () => boolean
}): IDisposable {
  const { host, frame, term, isEnabled } = options
  let full: { width: number; height: number } | null = null
  let pinned = false

  const pan = () => {
    if (!pinned || !full) return
    const offset = keyboardPanOffset({
      fullHeight: full.height,
      visibleHeight: frame.clientHeight,
      rows: term.rows,
      cursorY: term.buffer.active.cursorY,
    })
    host.style.transform = offset > 0 ? `translateY(${-offset}px)` : ""
  }
  const unpin = () => {
    if (!pinned) return
    pinned = false
    host.style.height = ""
    host.style.transform = ""
  }
  const onFrameResize = () => {
    const width = frame.clientWidth
    const height = frame.clientHeight
    if (
      !isEnabled() ||
      !softKeyboardOpen() ||
      !full ||
      width !== full.width ||
      height >= full.height
    ) {
      full = { width, height }
      unpin()
      return
    }
    pinned = true
    host.style.height = `${full.height}px`
    pan()
  }

  const observer = new ResizeObserver(onFrameResize)
  observer.observe(frame)
  const cursor = term.onCursorMove(pan)
  return {
    dispose: () => {
      observer.disconnect()
      cursor.dispose()
      unpin()
    },
  }
}

type DeferredInsertTerminal = {
  element?: HTMLElement
  input: (data: string, wasUserInput?: boolean) => void
}

/**
 * iOS 键盘（实测自带简体拼音键盘）直接点符号：`keydown`（keyCode 229、key 是该字符、不在组合中）→
 * `input`（insertText），没有组合事件。xterm 对 229 记下 textarea 值、`setTimeout(0)` 后比对
 * 差异发送，但 iOS 把字符写进 textarea 晚于这一拍，比出来没变化；随后的 `input` 又因
 * `_keyDownSeen`（到 keyup 才清）被 xterm 忽略——字符两头落空。长按弹出的符号、拼音选字走
 * 组合事件，xterm 在 compositionend 发送，不受影响。
 *
 * 这里在宿主元素捕获阶段（先于 xterm 挂在 textarea 上的监听）接管这一种：拦下那个 keydown，
 * 等紧随的 insertText 到来自己发一次，并拦下 xterm 的 input 处理，恰好一次。只认「单字符
 * key」：桌面键盘不是 229，Android Gboard 的 229 是 `Unidentified`（退格靠 xterm 比对），都不动。
 */
export function sendDeferredKeyCode229Inserts(
  term: DeferredInsertTerminal
): IDisposable {
  const host = term.element
  if (!host) return { dispose: () => {} }
  let pending = false

  const onKeyDown = (event: KeyboardEvent) => {
    pending =
      event.keyCode === 229 && !event.isComposing && event.key.length === 1
    if (pending) event.stopPropagation()
  }
  const onInput = (event: Event) => {
    if (!pending) return
    pending = false
    const input = event as InputEvent
    if (input.inputType !== "insertText" || input.isComposing || !input.data) {
      return
    }
    event.stopPropagation()
    term.input(input.data)
  }
  const onKeyUp = () => {
    pending = false
  }

  host.addEventListener("keydown", onKeyDown, true)
  host.addEventListener("input", onInput, true)
  host.addEventListener("keyup", onKeyUp, true)
  return {
    dispose: () => {
      host.removeEventListener("keydown", onKeyDown, true)
      host.removeEventListener("input", onInput, true)
      host.removeEventListener("keyup", onKeyUp, true)
    },
  }
}

/**
 * xterm 的隐藏 textarea 只在回车时清空：一行里每次选字都累积进去（实测 iOS 上值一直变长）。
 * 组合期间 xterm 把它摆到光标处、宽度等于预览层，`white-space: nowrap` 下插入点跑到右边缘
 * 以外，iOS 为让插入点可见把整页往右平移。这里在每次组合结束、xterm 发完（它在
 * compositionend 后 `setTimeout(0)` 读值）之后清空；其间有按键就跳过这次，免得打乱 xterm
 * 对 229 按键「记旧值、比新值」的差异发送。折行见 globals.css 的 `.xterm-helper-textarea`。
 */
export function clearImeTextareaAfterCommit(term: {
  textarea?: HTMLTextAreaElement
}): IDisposable {
  const textarea = term.textarea
  if (!textarea) return { dispose: () => {} }
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const onCompositionEnd = () => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      textarea.value = ""
    }, 50)
  }
  textarea.addEventListener("compositionend", onCompositionEnd)
  textarea.addEventListener("keydown", cancel)
  textarea.addEventListener("compositionstart", cancel)
  return {
    dispose: () => {
      cancel()
      textarea.removeEventListener("compositionend", onCompositionEnd)
      textarea.removeEventListener("keydown", cancel)
      textarea.removeEventListener("compositionstart", cancel)
    },
  }
}
