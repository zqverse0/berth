import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const component = readFileSync(
  resolve(process.cwd(), "src/components/files/pdf-preview.tsx"),
  "utf8"
)
const css = readFileSync(
  resolve(process.cwd(), "src/components/files/pdf-text-layer.css"),
  "utf8"
)

describe("PDF.js viewer style ownership", () => {
  it("loads the official viewer geometry contract", () => {
    expect(component).toContain('import "pdfjs-dist/web/pdf_viewer.css"')
  })

  it("keeps Berth CSS limited to the surrounding surface", () => {
    expect(css).toContain(".pdf-viewer-container")
    expect(css).not.toContain("--total-scale-factor")
    expect(css).not.toMatch(/\.textLayer\s*\{/)
    // 选区交给 pdf.js 自带的按页绘制，不能被关掉
    expect(component).not.toContain("enableSelectionRendering: false")
  })
})
