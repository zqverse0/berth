/**
 * xterm 宽度表必须与 Agent CLI / daemon 一致：emoji 占 2 列。
 * 默认 Unicode 6 表把 ✅ 算 1 列，后续字符会整体左移一格。
 */
import { describe, expect, it } from "vitest"
import { Terminal } from "@xterm/xterm"
import { Unicode11Addon } from "@xterm/addon-unicode11"

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe("terminal unicode width", () => {
  it("puts the character after an emoji in the third column", async () => {
    const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = "11"

    await write(term, "✅x")

    const line = term.buffer.active.getLine(0)
    expect(line?.getCell(0)?.getWidth()).toBe(2)
    expect(line?.getCell(2)?.getChars()).toBe("x")
    term.dispose()
  })
})
