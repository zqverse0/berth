import { describe, expect, it } from "vitest"
import { nextWarmTerminalIds } from "./warm-terminals"

const live = new Set(["t1", "t2", "t3", "t4", "t5", "t6"])
const none = new Set<string>()

describe("nextWarmTerminalIds", () => {
  it("keeps the 4 most recently shown terminals", () => {
    let warm: readonly string[] = []
    for (const id of ["t1", "t2", "t3", "t4", "t5"])
      warm = nextWarmTerminalIds(warm, live, [id], none)
    expect(warm).toEqual(["t2", "t3", "t4", "t5"])
    // 再显示 t2：移到最新，挤掉最旧的 t3
    warm = nextWarmTerminalIds(warm, live, ["t6", "t2"], none)
    expect(warm).toEqual(["t4", "t5", "t6", "t2"])
  })

  it("never drops visible terminals, even past the cap", () => {
    const shown = ["t1", "t2", "t3", "t4", "t5"]
    expect(nextWarmTerminalIds(["t6"], live, shown, none)).toEqual(shown)
  })

  it("drops closed and hidden exited terminals but keeps a visible exited one", () => {
    const warm = nextWarmTerminalIds(
      ["t1", "t2", "gone"],
      live,
      ["t3"],
      new Set(["t1", "t3"])
    )
    expect(warm).toEqual(["t2", "t3"])
  })

  it("returns the same array when nothing changes", () => {
    const warm = ["t1", "t2"]
    expect(nextWarmTerminalIds(warm, live, ["t2"], none)).toBe(warm)
  })
})
