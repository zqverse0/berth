import { describe, expect, it } from "vitest"

import { normalizeAppUpdateError } from "@/lib/updater"

describe("normalizeAppUpdateError", () => {
  it("classifies a missing Tauri release manifest as a source outage", () => {
    const rawMessage = "Could not fetch a valid release JSON from the remote"

    expect(normalizeAppUpdateError(new Error(rawMessage))).toEqual({
      kind: "source_unreachable",
      rawMessage,
    })
  })
})
