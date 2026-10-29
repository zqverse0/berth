/**
 * Attach-mode lifecycle contract for TerminalView.
 *
 * The workspace's `@xterm/addon-ligatures` package entry is broken
 * (missing lib/addon-ligatures.js), so the optional lazy import is mocked at
 * the test boundary below. The product decision is to reuse TerminalView;
 * these tests lock the
 * runtime-store side of the attach lifecycle that TerminalView wires:
 * mount → attach + sink, unmount → unbind sink while the personal console
 * remains attached, never create/terminate APIs.
 *
 * Renderer contract: all platforms use xterm's built-in DOM renderer.
 * The optional WebGL addon must not be imported or loaded by production
 * terminal code, eliminating the entire glyph-atlas corruption class.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { TerminalStream } from "@/lib/terminal/terminal-stream"
import {
  __setTerminalStreamForTests,
  getTerminalRuntimeActions,
  resetTerminalRuntimeStore,
  useTerminalRuntimeStore,
} from "@/stores/terminal-runtime-store"

// The production import is intentionally lazy and ligatures are disabled by
// default. Keep mount-contract tests independent from the broken package
// entry while preserving the runtime code path for an explicit opt-in.
vi.mock("@xterm/addon-ligatures", () => ({
  LigaturesAddon: class {
    dispose() {}
  },
}))

function makeStream(): TerminalStream & {
  attachCalls: number
  detachCalls: number
  inputSequences: number[]
} {
  const stream = {
    attachCalls: 0,
    detachCalls: 0,
    inputSequences: [] as number[],
    async attach(input: {
      terminalId: string
      clientId: string
      clientLabel: string
    }) {
      stream.attachCalls += 1
      const attachedSnapshot = {
        terminalId: input.terminalId,
        backendInstanceId: "b",
        sequence: 1,
        rows: 24,
        cols: 80,
        ansi: new Uint8Array(),
        historyTruncated: false,
        status: "running" as const,
        exitCode: null,
        exitedAt: null,
        lastKnownCwd: null,
      }
      return {
        snapshot: attachedSnapshot,
        events: {
          async *[Symbol.asyncIterator]() {
            // idle
          },
        },
        async write(inputSequence: number) {
          stream.inputSequences.push(inputSequence)
        },
        async resize(inputSequence: number) {
          stream.inputSequences.push(inputSequence)
          return attachedSnapshot
        },
        async detach() {
          stream.detachCalls += 1
        },
      }
    },
  }
  return stream
}

beforeEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
})

afterEach(() => {
  resetTerminalRuntimeStore()
  __setTerminalStreamForTests(null)
})

describe("TerminalView attach contract (via runtime store)", () => {
  it("mount path attaches existing terminal without create APIs", async () => {
    const stream = makeStream()
    __setTerminalStreamForTests(stream)
    const actions = getTerminalRuntimeActions()

    // TerminalView attach mode does exactly this on mount:
    actions.setOutputSink("t-shared", vi.fn())
    await actions.attachTerminal("t-shared")

    expect(stream.attachCalls).toBe(1)
    expect(useTerminalRuntimeStore.getState().sessions["t-shared"]).toBeTruthy()
    expect(
      useTerminalRuntimeStore.getState().sessions["t-shared"]?.status
    ).toBe("connected")
  })

  it("unmount path only unbinds the view and keeps the console attached", async () => {
    const stream = makeStream()
    __setTerminalStreamForTests(stream)
    const actions = getTerminalRuntimeActions()

    actions.setOutputSink("t-shared", vi.fn())
    await actions.attachTerminal("t-shared")

    // TerminalView attach cleanup only removes its rendering sink.
    actions.setOutputSink("t-shared", null)

    expect(stream.detachCalls).toBe(0)
    expect(useTerminalRuntimeStore.getState().sessions["t-shared"]).toBeTruthy()
  })

  it("remount re-attaches so the new xterm starts from a fresh snapshot", async () => {
    const stream = makeStream()
    __setTerminalStreamForTests(stream)
    const actions = getTerminalRuntimeActions()

    actions.setOutputSink("t-shared", vi.fn())
    await actions.attachTerminal("t-shared", { freshSnapshot: true })
    actions.setOutputSink("t-shared", null)
    const firstRevision =
      useTerminalRuntimeStore.getState().sessions["t-shared"]?.snapshotRevision

    // The previous xterm (and everything it rendered) is gone; the cached
    // snapshot predates that output, so the new view must not reuse it.
    actions.setOutputSink("t-shared", vi.fn())
    await actions.attachTerminal("t-shared", { freshSnapshot: true })

    expect(stream.attachCalls).toBe(2)
    expect(
      useTerminalRuntimeStore.getState().sessions["t-shared"]?.snapshotRevision
    ).toBe((firstRevision ?? 0) + 1)
    expect(
      readFileSync(resolve(__dirname, "terminal-view.tsx"), "utf-8")
    ).toContain("attachTerminal(terminalId, { freshSnapshot: true })")
  })

  it("personal console accepts input without a control handshake", async () => {
    const stream = makeStream()
    __setTerminalStreamForTests(stream)
    const actions = getTerminalRuntimeActions()
    await actions.attachTerminal("t1")

    actions.sendInput("t1", "hello")
    await actions.resize("t1", 10, 10)
    expect(stream.inputSequences).toEqual([1, 2])
    expect(
      "inputSequence" in (useTerminalRuntimeStore.getState().sessions.t1 ?? {})
    ).toBe(false)
  })
})

describe("TerminalView renderer contract", () => {
  const terminalViewSource = readFileSync(
    resolve(__dirname, "terminal-view.tsx"),
    "utf-8"
  )
  const terminalSurfaceSource = readFileSync(
    resolve(__dirname, "../../lib/terminal/terminal-surface.ts"),
    "utf-8"
  )
  const globalsCss = readFileSync(
    resolve(__dirname, "../../app/globals.css"),
    "utf-8"
  )

  it("does not import or load @xterm/addon-webgl", () => {
    expect(terminalViewSource).not.toMatch(/@xterm\/addon-webgl/)
    expect(terminalSurfaceSource).not.toMatch(/@xterm\/addon-webgl/)
  })

  it("does not reference attachWebglAddon or webglController", () => {
    expect(terminalViewSource).not.toMatch(/attachWebglAddon/)
    expect(terminalViewSource).not.toMatch(/webglController/)
    expect(terminalSurfaceSource).not.toMatch(/attachWebglAddon/)
  })

  it("still imports waitForTerminalFont for font readiness", () => {
    expect(terminalViewSource).toMatch(/waitForTerminalFont/)
    expect(terminalSurfaceSource).toMatch(/export.*waitForTerminalFont/)
  })

  it("still loads core xterm addons (FitAddon, WebLinksAddon)", () => {
    expect(terminalViewSource).toMatch(/@xterm\/addon-fit/)
    expect(terminalViewSource).toMatch(/@xterm\/addon-web-links/)
  })

  it("measures character widths with the Unicode 11 table", () => {
    expect(terminalViewSource).toMatch(/new Unicode11Addon\(\)/)
    expect(terminalViewSource).toMatch(/unicode\.activeVersion = "11"/)
  })

  it("keeps a single visibility-resume fit path", () => {
    const visibilityResumeEffects = terminalViewSource.match(
      /useEffect\(\(\) => \{\s+if \(!isVisible\) return/g
    )

    expect(visibilityResumeEffects).toHaveLength(1)
  })

  it("shows attach failures caught by the runtime store", () => {
    expect(terminalViewSource).toMatch(
      /attachStatus === "degraded"[\s\S]*attachErrorMessage \|\|\s+localAttachError/
    )
  })

  it("delegates the only visible terminal scrollbar to shared ScrollArea", () => {
    expect(terminalViewSource).toMatch(
      /import \{ ScrollArea \} from "@\/components\/ui\/scroll-area"/
    )
    expect(terminalViewSource.match(/<ScrollArea/g)).toHaveLength(1)
    expect(globalsCss).toMatch(
      /\[data-terminal-surface="true"\][^{]*\.xterm-scrollable-element\s*>\s*\.scrollbar\s*\{[^}]*display:\s*none\s*!important/s
    )
  })
})
