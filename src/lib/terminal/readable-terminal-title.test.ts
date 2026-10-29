import { describe, expect, it } from "vitest"
import {
  looksLikeTerminalId,
  readableTerminalTitle,
} from "@/lib/terminal/readable-terminal-title"

describe("readableTerminalTitle", () => {
  it("keeps explicit human titles", () => {
    expect(
      readableTerminalTitle({
        title: "Repo shell",
        shell: "/bin/zsh",
        initialCwd: "/workspace/demo-app",
        terminalId: "123e4567-e89b-12d3-a456-426614174000",
      })
    ).toBe("Repo shell")
  })

  it("replaces uuid titles with shell · cwd basename", () => {
    expect(
      readableTerminalTitle({
        title: "123e4567-e89b-12d3-a456-426614174000",
        shell: "/usr/bin/zsh",
        initialCwd: "/workspace/demo-app",
        terminalId: "123e4567-e89b-12d3-a456-426614174000",
      })
    ).toBe("zsh · demo-app")
  })

  it("falls back to Terminal when nothing readable is available", () => {
    expect(
      readableTerminalTitle({
        title: "123e4567-e89b-12d3-a456-426614174000",
        terminalId: "123e4567-e89b-12d3-a456-426614174000",
      })
    ).toBe("Terminal")
  })

  it("detects uuid-like terminal ids", () => {
    expect(looksLikeTerminalId("123e4567-e89b-12d3-a456-426614174000")).toBe(
      true
    )
    expect(looksLikeTerminalId("logs")).toBe(false)
  })
})
