import { describe, expect, it } from "vitest"
import { pickStatusDot } from "@/components/ui/status-dot"

describe("pickStatusDot", () => {
  it("shows the highest-priority state only", () => {
    expect(pickStatusDot("pinned", "working")).toBe("working")
    expect(pickStatusDot("new", "pinned")).toBe("new")
    expect(pickStatusDot("pinned", "attention", "new")).toBe("attention")
    expect(pickStatusDot(null, false, undefined)).toBeNull()
  })
})
