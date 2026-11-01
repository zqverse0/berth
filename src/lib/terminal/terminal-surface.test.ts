import { afterEach, describe, expect, it, vi } from "vitest"
import { Terminal } from "@xterm/xterm"
import {
  bindMobileKeyboardPan,
  clearImeTextareaAfterCommit,
  followBottomOnHistoryReset,
  keyboardPanOffset,
  sendDeferredKeyCode229Inserts,
  skipUnchangedXtermStyleWrites,
  waitForTerminalFont,
} from "./terminal-surface"

describe("waitForTerminalFont", () => {
  it("returns immediately when the font is already available", async () => {
    const fonts = {
      check: vi.fn(() => true),
      ready: new Promise<never>(() => {}),
    }

    await expect(
      waitForTerminalFont("JetBrains Mono", { fonts, timeoutMs: 1 })
    ).resolves.toBe("ready")
  })

  it("uses the timeout fallback when font readiness stalls", async () => {
    vi.useFakeTimers()
    const fonts = {
      check: vi.fn(() => false),
      ready: new Promise<never>(() => {}),
    }
    const result = waitForTerminalFont("Missing Font", {
      fonts,
      timeoutMs: 10,
    })

    await vi.advanceTimersByTimeAsync(10)
    await expect(result).resolves.toBe("timeout")
    vi.useRealTimers()
  })
})

describe("skipUnchangedXtermStyleWrites", () => {
  it("keeps the stylesheet when xterm rewrites identical CSS", () => {
    const host = document.createElement("div")
    host.innerHTML = '<div class="xterm-screen"><style>.a{}</style></div>'
    const style = host.querySelector("style") as HTMLStyleElement
    skipUnchangedXtermStyleWrites(host)
    const node = style.firstChild

    style.textContent = ".a{}"
    expect(style.firstChild).toBe(node)

    style.textContent = ".b{}"
    expect(style.textContent).toBe(".b{}")
    expect(style.firstChild).not.toBe(node)
  })
})

describe("followBottomOnHistoryReset", () => {
  const write = (term: Terminal, data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve))
  // pi 改尺寸时的整屏重绘：清屏、回原点、清 scrollback，再整段重放
  const piFullRedraw = `\x1b[2J\x1b[H\x1b[3J${Array.from(
    { length: 30 },
    (_, i) => `redraw ${i}`
  ).join("\r\n")}`

  async function scrolledUpTerm(): Promise<Terminal> {
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 1000 })
    await write(
      term,
      Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n")
    )
    term.scrollLines(-50)
    return term
  }

  it("xterm alone leaves a scrolled-up viewport at the top after ED3", async () => {
    const term = await scrolledUpTerm()
    await write(term, piFullRedraw)
    const buffer = term.buffer.active
    expect(buffer.baseY).toBeGreaterThan(0)
    expect(buffer.viewportY).toBe(0)
    term.dispose()
  })

  it("returns to following the bottom once the scrollback is cleared", async () => {
    const term = await scrolledUpTerm()
    const follow = followBottomOnHistoryReset(term)
    await write(term, piFullRedraw)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    // 之后的输出继续跟底部
    await write(term, "\r\nmore\r\nmore")
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    follow.dispose()
    term.dispose()
  })

  it("returns to the bottom when a full-screen program exits", async () => {
    const term = await scrolledUpTerm()
    const follow = followBottomOnHistoryReset(term)
    await write(term, "\x1b[?1049hvim\x1b[?1049l\r\n$ ")
    expect(term.buffer.active.type).toBe("normal")
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    follow.dispose()
    term.dispose()
  })

  it("keeps a scrolled-up viewport for ordinary clears (ED2)", async () => {
    const term = await scrolledUpTerm()
    const follow = followBottomOnHistoryReset(term)
    const before = term.buffer.active.viewportY
    await write(term, "\x1b[2J")
    expect(term.buffer.active.viewportY).toBe(before)
    follow.dispose()
    term.dispose()
  })
})

describe("keyboardPanOffset", () => {
  const base = { fullHeight: 600, visibleHeight: 300, rows: 30 }

  it("shows the bottom when the cursor sits low (TUI input box)", () => {
    expect(keyboardPanOffset({ ...base, cursorY: 28 })).toBe(300)
  })

  it("keeps a high cursor row visible", () => {
    expect(keyboardPanOffset({ ...base, cursorY: 5 })).toBe(100)
  })

  it("does not move when nothing is covered", () => {
    expect(
      keyboardPanOffset({ ...base, visibleHeight: 600, cursorY: 28 })
    ).toBe(0)
  })
})

describe("bindMobileKeyboardPan", () => {
  let resize: () => void = () => {}
  let keyboardHeight = 0

  function setup(enabled = true) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe() {}
        disconnect() {}
      }
    )
    vi.stubGlobal("visualViewport", {
      get height() {
        return window.innerHeight - keyboardHeight
      },
    })
    const frame = document.createElement("div")
    const host = document.createElement("div")
    frame.appendChild(host)
    let size = { width: 390, height: 600 }
    Object.defineProperty(frame, "clientWidth", { get: () => size.width })
    Object.defineProperty(frame, "clientHeight", { get: () => size.height })
    const term = {
      rows: 30,
      buffer: { active: { cursorY: 28 } },
      onCursorMove: () => ({ dispose() {} }),
    } as unknown as Parameters<typeof bindMobileKeyboardPan>[0]["term"]
    const pan = bindMobileKeyboardPan({
      host,
      frame,
      term,
      isEnabled: () => enabled,
    })
    const setFrame = (next: { width: number; height: number }) => {
      size = next
      resize()
    }
    setFrame(size)
    return { host, setFrame, pan }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    keyboardHeight = 0
  })

  it("pins the height and pans up while the keyboard is open", () => {
    const { host, setFrame, pan } = setup()
    keyboardHeight = 300
    setFrame({ width: 390, height: 300 })
    expect(host.style.height).toBe("600px")
    expect(host.style.transform).toBe("translateY(-300px)")

    keyboardHeight = 0
    setFrame({ width: 390, height: 600 })
    expect(host.style.height).toBe("")
    expect(host.style.transform).toBe("")
    pan.dispose()
  })

  it("resizes normally when the width changes (rotation)", () => {
    const { host, setFrame, pan } = setup()
    keyboardHeight = 300
    setFrame({ width: 844, height: 200 })
    expect(host.style.height).toBe("")
    pan.dispose()
  })

  it("resizes normally for shrinks without a keyboard (extra-keys row)", () => {
    const { host, setFrame, pan } = setup()
    setFrame({ width: 390, height: 556 })
    expect(host.style.height).toBe("")
    pan.dispose()
  })

  it("does nothing off mobile", () => {
    const { host, setFrame, pan } = setup(false)
    keyboardHeight = 300
    setFrame({ width: 390, height: 300 })
    expect(host.style.height).toBe("")
    pan.dispose()
  })
})

describe("sendDeferredKeyCode229Inserts", () => {
  function setup() {
    const element = document.createElement("div")
    const textarea = document.createElement("textarea")
    element.appendChild(textarea)
    document.body.appendChild(element)
    const input = vi.fn()
    // 模拟 xterm 挂在 textarea 上的监听：被拦下就收不到
    const xterm = vi.fn()
    for (const type of ["keydown", "input"])
      textarea.addEventListener(type, (event) => xterm(event.type))
    const fix = sendDeferredKeyCode229Inserts({ element, input })
    const key = (
      type: string,
      keyCode: number,
      k: string,
      isComposing = false
    ) =>
      textarea.dispatchEvent(
        new KeyboardEvent(type, { keyCode, key: k, isComposing, bubbles: true })
      )
    const type = (inputType: string, data: string, isComposing = false) =>
      textarea.dispatchEvent(
        new InputEvent("input", { inputType, data, isComposing, bubbles: true })
      )
    const done = () => {
      fix.dispose()
      element.remove()
    }
    return { input, xterm, key, type, done }
  }

  it("sends a directly tapped iOS symbol exactly once (keydown 229 + insertText)", () => {
    const t = setup()
    t.key("keydown", 229, "/")
    t.type("insertText", "/")
    t.key("keyup", 191, "/")
    expect(t.input.mock.calls).toEqual([["/"]])
    expect(t.xterm).not.toHaveBeenCalled()
    t.done()
  })

  it("leaves IME composition to xterm (pinyin, long-press symbols)", () => {
    const t = setup()
    t.key("keydown", 229, "l")
    t.type("insertCompositionText", "l", true)
    t.type("insertFromComposition", "了", true)
    expect(t.input).not.toHaveBeenCalled()
    expect(t.xterm).toHaveBeenCalledWith("input")
    t.done()
  })

  it("leaves insertText without a 229 keydown to xterm", () => {
    const t = setup()
    t.type("insertText", "～")
    t.key("keydown", 65, "a")
    t.type("insertText", "a")
    expect(t.input).not.toHaveBeenCalled()
    expect(t.xterm.mock.calls).toEqual([["input"], ["keydown"], ["input"]])
    t.done()
  })

  it("leaves Android's Unidentified 229 keys to xterm's textarea diff", () => {
    const t = setup()
    t.key("keydown", 229, "Unidentified")
    t.type("deleteContentBackward", "")
    expect(t.input).not.toHaveBeenCalled()
    expect(t.xterm.mock.calls).toEqual([["keydown"], ["input"]])
    t.done()
  })
})

describe("clearImeTextareaAfterCommit", () => {
  afterEach(() => vi.useRealTimers())

  function setup() {
    vi.useFakeTimers()
    const textarea = document.createElement("textarea")
    const clear = clearImeTextareaAfterCommit({ textarea })
    const fire = (type: string) => textarea.dispatchEvent(new Event(type))
    return { textarea, clear, fire }
  }

  it("clears the accumulated value after xterm has read the commit", () => {
    const { textarea, clear, fire } = setup()
    textarea.value = "那就好不是吧"
    fire("compositionend")
    // xterm 在 compositionend 后 setTimeout(0) 读值：那一拍还在
    vi.advanceTimersByTime(0)
    expect(textarea.value).toBe("那就好不是吧")
    vi.advanceTimersByTime(50)
    expect(textarea.value).toBe("")
    clear.dispose()
  })

  it("skips the clear when a key or a new composition follows at once", () => {
    const { textarea, clear, fire } = setup()
    textarea.value = "你好"
    fire("compositionend")
    fire("keydown")
    vi.advanceTimersByTime(100)
    expect(textarea.value).toBe("你好")
    fire("compositionend")
    fire("compositionstart")
    vi.advanceTimersByTime(100)
    expect(textarea.value).toBe("你好")
    clear.dispose()
  })
})
