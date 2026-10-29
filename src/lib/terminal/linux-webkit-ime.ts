/** Public xterm surface used by the Linux WebKitGTK IME workaround. */
export type LinuxWebKitTerminalImeTarget = {
  textarea?: HTMLTextAreaElement
  element?: HTMLElement
  /** xterm's programmatic input — forwards data to onData→PTY, no buffer write. */
  input?: (data: string, wasUserInput?: boolean) => void
}

export type LinuxWebKitTerminalImeEnvironment = {
  isLinux: boolean
  isTauri: boolean
}

export function isLinuxWebKitImeEnvironment(
  environment: LinuxWebKitTerminalImeEnvironment
): boolean {
  return environment.isLinux && environment.isTauri
}

/**
 * Linux WebKitGTK + CJK IME: one commit, one send.
 *
 * On-device traces (fcitx/ibus under WebKitGTK) show this environment NEVER
 * emits `compositionstart` or `compositionupdate` — only `compositionend`,
 * preceded by a `keydown` with keyCode 229 and an `input`
 * (inputType `insertFromComposition`). xterm's composition handling assumes
 * `compositionstart` fired, so two of its internal send paths misfire:
 *
 * 1) keydown(229) → CompositionHelper.keydown → `_handleAnyTextareaChanges`.
 *    Because `_isComposing` was never set true (no compositionstart), 229 is
 *    treated as "non-composition input while IME active" and diff-sends
 *    `newValue - oldValue` of the textarea.
 * 2) compositionend → `_finalizeComposition` → sends
 *    `textarea.value.substring(start + dataAlreadySent.length)`. `start` is
 *    stuck at 0 (only compositionstart advances it) and the textarea only ever
 *    accumulates (`一` → `一二` → `一二三`), so this re-sends history.
 *
 * Together they produce the observed `一二二三二三四二三四` for input `一二三四`.
 * Chromium is unaffected because it emits a full compositionstart/update/end
 * sequence, so `start` advances and `_isComposing` mutes path 1.
 *
 * Fix: take the commit away from xterm entirely and send it ourselves once.
 * A capture-phase listener on the HOST element (xterm's container, an ancestor
 * of the textarea) runs during the descent phase, before xterm's own listeners
 * on the textarea, so `stopPropagation()` there genuinely prevents both paths:
 * - keydown 229  → stop  (kills path 1)
 * - compositionstart → stop  (xterm never enters composition state)
 * - compositionend → stop, then `term.input(ev.data)` once (kills path 2,
 *   emits the commit through the normal onData→PTY pipe exactly once)
 *
 * `ev.data` on compositionend is the committed text (verified on-device). We
 * never read or write `textarea.value` — it stays xterm's private state and is
 * cleared naturally by xterm on the trailing Enter/Ctrl+C.
 */
export function bindLinuxWebKitTerminalIme(
  term: LinuxWebKitTerminalImeTarget,
  environment: LinuxWebKitTerminalImeEnvironment
): () => void {
  const host = term.element ?? term.textarea?.parentElement ?? null
  if (!isLinuxWebKitImeEnvironment(environment) || !term.textarea || !host) {
    return () => {}
  }

  let disposed = false

  const onHostKeyDown = (event: Event) => {
    if ((event as KeyboardEvent).keyCode === 229) {
      // Stop xterm's _handleAnyTextareaChanges diff-send (duplicate path 1).
      event.stopPropagation()
    }
  }

  const onHostCompositionStart = (event: Event) => {
    // Keep xterm out of composition state so its finalize math never runs.
    event.stopPropagation()
  }

  const onHostCompositionEnd = (event: Event) => {
    // Stop xterm's finalize (duplicate path 2), then emit the commit once.
    event.stopPropagation()
    const data = (event as CompositionEvent).data
    if (data && data.length > 0) {
      term.input?.(data, true)
    }
  }

  host.addEventListener("keydown", onHostKeyDown, true)
  host.addEventListener("compositionstart", onHostCompositionStart, true)
  host.addEventListener("compositionend", onHostCompositionEnd, true)

  return () => {
    if (disposed) return
    disposed = true
    host.removeEventListener("keydown", onHostKeyDown, true)
    host.removeEventListener("compositionstart", onHostCompositionStart, true)
    host.removeEventListener("compositionend", onHostCompositionEnd, true)
  }
}
