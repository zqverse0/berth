import { describe, expect, it, vi } from "vitest"
import {
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
