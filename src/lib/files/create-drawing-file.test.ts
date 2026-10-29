import { describe, expect, it, vi } from "vitest"

const existing = new Set(["untitled.md", "untitled-2.md"])
vi.mock("@/lib/api", () => ({
  createFileTreeEntry: async (_root: string, _dir: string, name: string) => {
    if (existing.has(name)) throw { code: "already_exists", message: "exists" }
    return name
  },
}))

import { createUniqueRootFile } from "./create-drawing-file"

describe("createUniqueRootFile", () => {
  it("numbers the name until it is free", async () => {
    await expect(createUniqueRootFile("/p", "untitled", ".md")).resolves.toBe(
      "/p/untitled-3.md"
    )
    await expect(
      createUniqueRootFile("/p", "drawing", ".excalidraw.md")
    ).resolves.toBe("/p/drawing.excalidraw.md")
  })
})
