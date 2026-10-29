import { beforeEach, describe, expect, it, vi } from "vitest"

const { operation } = vi.hoisted(() => ({ operation: vi.fn() }))
vi.mock("@/lib/api", () => ({
  editorLanguagePackOperation: operation,
}))

const {
  invalidateEditorLanguagePacks,
  loadEditorLanguageById,
  loadEditorLanguageForPath,
} = await import("./language-packs")

describe("editor language packs", () => {
  beforeEach(() => {
    operation.mockReset()
    invalidateEditorLanguagePacks()
  })

  it("keeps pathless documents in plain text without a backend call", async () => {
    await expect(loadEditorLanguageForPath(null)).resolves.toEqual([])
    expect(operation).not.toHaveBeenCalled()
  })

  it("keeps unsupported files in plain text", async () => {
    operation.mockResolvedValue({
      catalog: [],
      installed: [
        {
          id: "rust",
          version: "1",
          displayName: "Rust",
          extensions: [".rs"],
          enabled: true,
          entryPath: "/packs/rust/language.mjs",
        },
      ],
    })

    await expect(
      loadEditorLanguageForPath("/repo/readme.txt")
    ).resolves.toEqual([])
    expect(operation).toHaveBeenCalledWith("installed")
  })

  it("loads a built-in parser when no downloaded pack is available", async () => {
    operation.mockResolvedValue({ catalog: [], installed: [] })

    const extension = await loadEditorLanguageForPath("/repo/package.json")

    expect(extension).not.toEqual([])
    expect(operation).toHaveBeenCalledWith("installed")
  })

  it("loads built-in language IDs for Diff and Merge", async () => {
    operation.mockResolvedValue({ catalog: [], installed: [] })

    const extension = await loadEditorLanguageById("typescript")

    expect(extension).not.toEqual([])
  })

  it("falls back to a built-in parser when local pack lookup fails", async () => {
    operation.mockRejectedValue(new Error("pack directory unavailable"))

    const extension = await loadEditorLanguageForPath("/repo/main.rs")

    expect(extension).not.toEqual([])
  })
})
