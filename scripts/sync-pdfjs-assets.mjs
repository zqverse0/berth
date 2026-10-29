import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const packagePath = require.resolve("pdfjs-dist/package.json")
const packageDir = path.dirname(packagePath)
const { version } = JSON.parse(fs.readFileSync(packagePath, "utf8"))
const outputRoot = path.resolve("public", "pdfjs")
const outputDir = path.join(outputRoot, version)

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.mkdirSync(outputDir, { recursive: true })

for (const entry of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const source = path.join(packageDir, entry)
  if (!fs.existsSync(source)) throw new Error(`Missing PDF.js asset: ${entry}`)
  fs.cpSync(source, path.join(outputDir, entry), { recursive: true })
}

const worker = path.join(packageDir, "build", "pdf.worker.min.mjs")
if (!fs.existsSync(worker)) throw new Error("Missing PDF.js worker")
fs.copyFileSync(worker, path.join(outputDir, "pdf.worker.min.mjs"))

// Excalidraw 手绘字体：CSP 只放行同源字体，画板经 EXCALIDRAW_ASSET_PATH 从这里取
const excalidrawFonts = path.join(
  path.dirname(require.resolve("@excalidraw/excalidraw")),
  "fonts"
)
const excalidrawOutput = path.resolve("public", "excalidraw")
fs.rmSync(excalidrawOutput, { recursive: true, force: true })
fs.cpSync(excalidrawFonts, path.join(excalidrawOutput, "fonts"), {
  recursive: true,
})
