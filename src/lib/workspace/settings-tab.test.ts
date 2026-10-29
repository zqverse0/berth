import { describe, expect, it } from "vitest"
import { isSettingsPageId } from "@/lib/workspace/settings-tab"

describe("settings tab contract", () => {
  it("accepts active settings page ids and rejects retired ones", () => {
    expect(isSettingsPageId("model-providers")).toBe(true)
    expect(isSettingsPageId("advanced")).toBe(true)
    expect(isSettingsPageId("workbench-layout")).toBe(false)
    expect(isSettingsPageId("system")).toBe(false)
    expect(isSettingsPageId("mcp")).toBe(false)
  })
})
