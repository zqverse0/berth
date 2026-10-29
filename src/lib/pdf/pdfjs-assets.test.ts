import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  PDFJS_VERSION,
  PDFJS_WORKER_URL,
  pdfDocumentAssetOptions,
} from "./pdfjs-assets"

describe("pdfjs assets", () => {
  it("keeps worker and document assets under the installed version", () => {
    expect(PDFJS_WORKER_URL).toBe(`/pdfjs/${PDFJS_VERSION}/pdf.worker.min.mjs`)
    expect(pdfDocumentAssetOptions.cMapUrl).toContain(
      `/pdfjs/${PDFJS_VERSION}/`
    )
  })

  it("ships the complete offline asset set for that version", () => {
    const root = path.join(process.cwd(), "public", "pdfjs", PDFJS_VERSION)
    for (const entry of [
      "cmaps",
      "standard_fonts",
      "wasm",
      "iccs",
      "pdf.worker.min.mjs",
    ]) {
      expect(fs.existsSync(path.join(root, entry)), entry).toBe(true)
    }
    expect(fs.readdirSync(path.dirname(root))).toEqual([PDFJS_VERSION])
  })
})
