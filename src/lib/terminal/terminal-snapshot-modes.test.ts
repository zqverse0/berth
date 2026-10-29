/**
 * 宿主快照（src-tauri/src/terminal/snapshot.rs）对全屏应用的字节约定：
 * 普通屏历史 → `?1049h` → 按行定位的全屏内容 → 模式 → 光标。
 * 画到 reset 后的真实 xterm 上，必须回到全屏 + 鼠标/方向键模式，退出后普通屏仍在。
 */
import { describe, expect, it } from "vitest"
import { Terminal } from "@xterm/xterm"

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function row(term: Terminal, y: number): string {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? ""
}

describe("full-screen snapshot replay", () => {
  it("restores the alternate screen and the app's input modes", async () => {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    await write(term, "\x1b[?1000h\x1b[?1hstale")
    term.reset()

    await write(
      term,
      "history\r\nprompt$ cline" +
        "\x1b[0m\x1b[?1049h" +
        "\x1b[1;1H┌──────┐\x1b[2;1H│ chat │\x1b[3;1H└──────┘\x1b[4;1H\x1b[5;1H❯ ask" +
        "\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1h" +
        "\x1b[0m\x1b[5;6H\x1b[?25h"
    )

    expect(term.buffer.active.type).toBe("alternate")
    expect(term.modes.mouseTrackingMode).toBe("any")
    expect(term.modes.bracketedPasteMode).toBe(true)
    expect(term.modes.applicationCursorKeysMode).toBe(true)
    expect(row(term, 1)).toBe("│ chat │")
    expect([term.buffer.active.cursorY, term.buffer.active.cursorX]).toEqual([
      4, 5,
    ])

    await write(term, "\x1b[?1049l")
    expect(term.buffer.active.type).toBe("normal")
    expect(row(term, 0)).toBe("history")
    expect(row(term, 1)).toBe("prompt$ cline")
    term.dispose()
  })
})
