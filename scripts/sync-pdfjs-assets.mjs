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

// 旧版拷到这里的 Excalidraw 字体（画板已移到 excalidraw 插件，字体随插件包）：删掉，免得打进安装包
fs.rmSync(path.resolve("public", "excalidraw"), { recursive: true, force: true })
