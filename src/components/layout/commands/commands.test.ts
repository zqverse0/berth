import { commandForKey, commandHint, COMMAND_KEYS } from "./commands"

describe("workspace commands", () => {
  it("gives every leader key to exactly one command", () => {
    const keys = COMMAND_KEYS.flatMap((c) => (c.key ? [c.key] : []))
    expect(new Set(keys).size).toBe(keys.length)
    // `?` 留给面板搜索
    expect(keys).not.toContain("?")
  })

  it("resolves keys case-insensitively and renders hints", () => {
    expect(commandForKey("B")).toBe("toggle_sidebar")
    expect(commandForKey("?")).toBeUndefined()
    expect(commandHint("toggle_sidebar")).toBe("Ctrl+Space B")
    expect(commandHint("new_canvas")).toBe("")
  })
})
