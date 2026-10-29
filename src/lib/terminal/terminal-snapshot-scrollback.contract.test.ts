/**
 * Contract for projection snapshots: the backend supplies retained logical
 * history plus the current screen, and the client resets before every paint.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Terminal } from "@xterm/xterm"
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from "./terminal-constants"
import { createTerminalWriteAdapter } from "./terminal-write-adapter"

function bufferText(term: Terminal): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "")
  }
  return lines.join("\n")
}

function writeSync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function paintSnapshot(term: Terminal, ansi: string): Promise<void> {
  term.reset()
  const adapter = createTerminalWriteAdapter({
    write: (data, callback) => term.write(data, callback),
  })
  await new Promise<void>((resolve) => adapter.write(ansi, resolve))
  adapter.dispose()
}

describe("terminal projection snapshot painting", () => {
  it("keeps the lightweight frontend default below the history ceiling", () => {
    expect(DEFAULT_TERMINAL_SCROLLBACK).toBe(5_000)
    expect(DEFAULT_TERMINAL_SCROLLBACK).toBeLessThanOrEqual(
      MAX_TERMINAL_SCROLLBACK
    )
    expect(MAX_TERMINAL_SCROLLBACK).toBe(50_000)
  })

  const terminals: Terminal[] = []

  afterEach(() => {
    while (terminals.length > 0) terminals.pop()?.dispose()
  })

  function createTerm(cols = 40, rows = 6): Terminal {
    const term = new Terminal({
      cols,
      rows,
      // This contract deliberately uses the retained-history ceiling so it
      // can exercise CSI 3 J and backend-history replay without conflating
      // xterm's lightweight production default with daemon history.
      scrollback: MAX_TERMINAL_SCROLLBACK,
      allowProposedApi: true,
    })
    terminals.push(term)
    return term
  }

  it("keeps CSI 3 J semantics available to raw xterm", async () => {
    const term = createTerm()
    await writeSync(term, "EARLY_QUESTION\r\n" + "middle\r\n".repeat(20))
    expect(bufferText(term)).toContain("EARLY_QUESTION")

    await writeSync(term, "\x1b[3J")

    expect(term.buffer.active.baseY).toBe(0)
    expect(bufferText(term)).not.toContain("EARLY_QUESTION")
  })

  it("replays backend history after reset without a clear-screen sequence", async () => {
    const term = createTerm()
    const snapshot =
      "\x1b[0m" +
      "EARLY_QUESTION\r\n" +
      "context-line\r\n".repeat(10) +
      "RECENT_ONLY\r\n"

    await paintSnapshot(term, snapshot)

    expect(bufferText(term)).toContain("EARLY_QUESTION")
    expect(bufferText(term)).toContain("RECENT_ONLY")
  })

  it("is idempotent when the same authoritative snapshot is painted twice", async () => {
    const term = createTerm()
    const snapshot = "\x1b[0mEARLY\r\nRECENT\r\n"

    await paintSnapshot(term, snapshot)
    await paintSnapshot(term, snapshot)

    const text = bufferText(term)
    expect(text.match(/EARLY/g)?.length).toBe(1)
    expect(text.match(/RECENT/g)?.length).toBe(1)
  })
})
