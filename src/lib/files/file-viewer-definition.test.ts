import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  FILE_VIEWER_DEFINITIONS,
  OFFICE_EXTENSIONS,
  fileViewerDefinitionFromPath,
  fileViewerKindFromPath,
} from "@/lib/files/file-viewer-definition"

const expectedKinds = [
  "text",
  "markdown",
  "html",
  "plugin",
  "image",
  "office",
  "pdf",
] as const

describe("local file viewer definitions", () => {
  it("covers every supported local viewer kind", () => {
    expect(Object.keys(FILE_VIEWER_DEFINITIONS).sort()).toEqual(
      [...expectedKinds].sort()
    )
  })

  it.each([
    ["src/app.ts", "text"],
    ["README.MARKDOWN", "markdown"],
    ["docs/index.HTM", "html"],
    ["boards/roadmap.canvas.json", "text"],
    ["notes/flow.Excalidraw", "text"],
    ["vault/Drawing 2024.excalidraw.md", "markdown"],
    ["assets/logo.SVG", "image"],
    ["reports/budget.XLSX", "office"],
    ["reports/~$budget.xlsx", "text"],
    ["reports/.~1-budget.docx", "text"],
    ["papers/review.PDF", "pdf"],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(fileViewerKindFromPath(path)).toBe(kind)
    expect(fileViewerDefinitionFromPath(path).kind).toBe(kind)
  })

  it("hands files to a plugin editor when its suffix matches, longest first", () => {
    const suffixes = [".excalidraw", ".excalidraw.md"]
    expect(fileViewerKindFromPath("vault/A.Excalidraw.md", suffixes)).toBe(
      "plugin"
    )
    expect(fileViewerKindFromPath("notes/a.md", suffixes)).toBe("markdown")
    expect(fileViewerDefinitionFromPath("b.excalidraw", suffixes)).toEqual({
      kind: "plugin",
      dataMode: "text",
      reloadPolicy: "text-buffer",
      capabilities: {},
    })
  })

  it("keeps the static contract free of renderer instances", () => {
    expect(FILE_VIEWER_DEFINITIONS.plugin).toEqual({
      kind: "plugin",
      dataMode: "text",
      reloadPolicy: "text-buffer",
      capabilities: {},
    })
  })
})

describe("document format catalog", () => {
  it("matches berth-tool-core DOCUMENT_FORMATS", () => {
    const rust = readFileSync(
      resolve(
        process.cwd(),
        "src-tauri/tool/berth-tool-core/src/file_tools.rs"
      ),
      "utf8"
    )
    const list = /DOCUMENT_FORMATS: &\[&str\] = &\[([^\]]*)\]/.exec(rust)?.[1]
    const formats = [...(list ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(formats.length).toBeGreaterThan(0)
    expect([...OFFICE_EXTENSIONS].sort()).toEqual(formats.sort())
  })
})
