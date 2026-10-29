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
