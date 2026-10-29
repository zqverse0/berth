import { describe, expect, it } from "vitest"

import { SETTINGS_PAGE_IDS } from "@/lib/workspace/settings-tab"
import { SETTINGS_PAGE_LOADERS } from "./index"

describe("settings pages", () => {
  it("registers every settings tab as a standalone page loader", () => {
    expect(Object.keys(SETTINGS_PAGE_LOADERS).sort()).toEqual(
      [...SETTINGS_PAGE_IDS].sort()
    )
  })
})
