import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  bindLinuxWebKitTerminalIme,
  isLinuxWebKitImeEnvironment,
  type LinuxWebKitTerminalImeTarget,
} from "./linux-webkit-ime"

const supportedEnvironment = {
  isLinux: true,
  isTauri: true,
}

type TermFixture = LinuxWebKitTerminalImeTarget & {
  textarea: HTMLTextAreaElement
  element: HTMLDivElement
  /** keyCodes that reached xterm's textarea keydown handler. */
  xtermKeyDownSeen: number[]
  /** composition event types that reached xterm's textarea handlers. */
  xtermCompositionSeen: string[]
  /** payloads xterm would send via _inputEvent (insertText only). */
  xtermInputSeen: string[]
  /** data forwarded through term.input (our single commit path). */
  inputSent: string[]
}

/**
 * Mirrors the real DOM and listener topology:
 * - xterm registers keydown / compositionstart / compositionend / input
 *   listeners on the TEXTAREA (see CoreBrowserTerminal.open()).
 * - bindLinuxWebKitTerminalIme registers CAPTURE listeners on the host element
 *   (the textarea's ancestor), which run during the descent phase — before the
 *   textarea's own listeners — so stopPropagation() there can block them.
 */
function createTerm(): TermFixture {
  const element = document.createElement("div")
  const textarea = document.createElement("textarea")
  const compositionView = document.createElement("div")
  compositionView.className = "composition-view"
  element.append(textarea, compositionView)
  document.body.append(element)

  const xtermKeyDownSeen: number[] = []
  const xtermCompositionSeen: string[] = []
  const xtermInputSeen: string[] = []
  const inputSent: string[] = []

  textarea.addEventListener(
    "keydown",
    (e) => xtermKeyDownSeen.push((e as KeyboardEvent).keyCode),
    true
  )
  for (const type of ["compositionstart", "compositionend"]) {
    textarea.addEventListener(
      type,
      (e) => xtermCompositionSeen.push(e.type),
      true
    )
  }
  textarea.addEventListener(
    "input",
    (e) => {
      const ev = e as InputEvent
      // Model CoreBrowserTerminal._inputEvent: only insertText is forwarded.
      if (ev.inputType === "insertText" && ev.data) {
        xtermInputSeen.push(ev.data)
      }
    },
    true
  )

  const input = (data: string) => {
    inputSent.push(data)
  }

  return {
    textarea,
    element,
    input,
    xtermKeyDownSeen,
    xtermCompositionSeen,
    xtermInputSeen,
    inputSent,
  }
}

function keydown229(textarea: HTMLTextAreaElement) {
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", { keyCode: 229, bubbles: true } as never)
  )
}

function endComposition(textarea: HTMLTextAreaElement, data: string) {
  textarea.dispatchEvent(
    new CompositionEvent("compositionend", { data, bubbles: true })
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe("isLinuxWebKitImeEnvironment", () => {
  it("is true only for local Linux Tauri", () => {
    expect(isLinuxWebKitImeEnvironment(supportedEnvironment)).toBe(true)
    expect(
      isLinuxWebKitImeEnvironment({ ...supportedEnvironment, isLinux: false })
    ).toBe(false)
    expect(
      isLinuxWebKitImeEnvironment({ ...supportedEnvironment, isTauri: false })
    ).toBe(false)
  })
})

describe("bindLinuxWebKitTerminalIme", () => {
  it("sends one commit exactly once for the WebKitGTK sequence (no compositionstart)", () => {
    const term = createTerm()
    const dispose = bindLinuxWebKitTerminalIme(term, supportedEnvironment)

    // On-device sequence for a single character: keydown(229) then
    // compositionend carrying the committed text. No compositionstart.
    keydown229(term.textarea)
    endComposition(term.textarea, "你")

    // Exactly one send, through term.input, with the commit text.
    expect(term.inputSent).toEqual(["你"])
    dispose()
  })

  it("blocks xterm's duplicate paths (keydown 229 and compositionend)", () => {
    const term = createTerm()
    const dispose = bindLinuxWebKitTerminalIme(term, supportedEnvironment)

    keydown229(term.textarea)
    endComposition(term.textarea, "你")

    // xterm never sees the composition character keydown nor the commit end,
    // so neither _handleAnyTextareaChanges nor _finalizeComposition can fire.
    expect(term.xtermKeyDownSeen).toEqual([])
    expect(term.xtermCompositionSeen).toEqual([])
    dispose()
  })

  it("does not duplicate across successive commits", () => {
    const term = createTerm()
    const dispose = bindLinuxWebKitTerminalIme(term, supportedEnvironment)

    for (const ch of ["一", "二", "三", "四"]) {
      keydown229(term.textarea)
      endComposition(term.textarea, ch)
    }

    // Regression guard for "一二二三二三四二三四".
    expect(term.inputSent).toEqual(["一", "二", "三", "四"])
    dispose()
  })

  it("never writes textarea.value — the field belongs to xterm", () => {
    const term = createTerm()
    const dispose = bindLinuxWebKitTerminalIme(term, supportedEnvironment)

    term.textarea.value = "一二三"
    keydown229(term.textarea)
    endComposition(term.textarea, "四")

    expect(term.textarea.value).toBe("一二三")
    dispose()
  })

  it("lets non-composition keydowns reach xterm", () => {
    const term = createTerm()
    const dispose = bindLinuxWebKitTerminalIme(term, supportedEnvironment)

    term.textarea.dispatchEvent(
      new KeyboardEvent("keydown", { keyCode: 65, bubbles: true } as never)
    )
    expect(term.xtermKeyDownSeen).toEqual([65])
    dispose()
  })

  it("ignores a compositionend with empty data", () => {
    const term = createTerm()
    const dispose = bindLinuxWebKitTerminalIme(term, supportedEnvironment)

    endComposition(term.textarea, "")
    expect(term.inputSent).toEqual([])
    dispose()
  })

  it("does not install listeners in unsupported environments", () => {
    for (const environment of [
      { ...supportedEnvironment, isLinux: false },
      { ...supportedEnvironment, isTauri: false },
    ]) {
      const term = createTerm()
      const hostListener = vi.spyOn(term.element, "addEventListener")
      bindLinuxWebKitTerminalIme(term, environment)()
      expect(hostListener).not.toHaveBeenCalled()
      hostListener.mockRestore()
    }
  })

  it("stops intercepting after dispose", () => {
    const term = createTerm()
    const dispose = bindLinuxWebKitTerminalIme(term, supportedEnvironment)
    dispose()

    keydown229(term.textarea)
    endComposition(term.textarea, "你")

    // With interception gone, xterm's own handlers see the raw events again.
    expect(term.xtermKeyDownSeen).toEqual([229])
    expect(term.xtermCompositionSeen).toEqual(["compositionend"])
    expect(term.inputSent).toEqual([])
  })
})
