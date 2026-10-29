import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { operation } = vi.hoisted(() => ({ operation: vi.fn() }))
vi.mock("@/lib/api", () => ({ editorLanguagePackOperation: operation }))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("@/lib/notify", () => ({ toast: { error: vi.fn() } }))

import { EditorLanguagePacksSection } from "./editor-language-packs-section"

const npmPack = {
  id: "cpp",
  version: "1.0.0",
  displayName: "C / C++",
  extensions: [".c", ".cpp"],
  languageIds: ["c", "cpp"],
  assetUrl: "https://registry.npmjs.org/berth-language-cpp/-/pack.tgz",
  signatureUrl: "",
  sha256: "",
  size: 100,
  editorApiVersion: 1,
  npmPackageName: "berth-language-cpp",
}

describe("EditorLanguagePacksSection", () => {
  beforeEach(() => {
    operation.mockReset()
    operation.mockResolvedValue({
      catalog: [],
      installed: [],
      catalogStatus: "unconfigured",
    })
  })

  it("loads only locally installed extension packs on mount", async () => {
    render(<EditorLanguagePacksSection />)

    expect(await screen.findByText("title")).toBeInTheDocument()
    expect(operation).toHaveBeenCalledWith("installed")
    expect(screen.queryByText("JSON")).not.toBeInTheDocument()
  })

  it("searches compatible npm packages", async () => {
    operation
      .mockResolvedValueOnce({ catalog: [], installed: [] })
      .mockResolvedValueOnce({ catalog: [npmPack], installed: [] })
    render(<EditorLanguagePacksSection />)

    fireEvent.change(screen.getByLabelText("searchPlaceholder"), {
      target: { value: "cpp" },
    })
    fireEvent.click(screen.getByText("search"))

    expect(await screen.findByText("C / C++")).toBeInTheDocument()
    expect(operation).toHaveBeenLastCalledWith("search-npm", undefined, {
      query: "cpp",
    })
    expect(screen.getByText("install")).toBeInTheDocument()
  })

  it("installs a search result without requiring Node.js", async () => {
    operation
      .mockResolvedValueOnce({ catalog: [], installed: [] })
      .mockResolvedValueOnce({ catalog: [npmPack], installed: [] })
      .mockResolvedValue({ catalog: [], installed: [] })
    render(<EditorLanguagePacksSection />)

    fireEvent.click(screen.getByText("search"))
    fireEvent.click(await screen.findByText("install"))

    await waitFor(() => {
      expect(operation).toHaveBeenCalledWith("install-npm", "cpp", {
        packageName: "berth-language-cpp",
      })
      expect(screen.getByText("install")).toBeEnabled()
    })
  })
})
