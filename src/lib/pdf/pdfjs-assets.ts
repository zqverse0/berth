import pdfjsPackage from "pdfjs-dist/package.json"

export const PDFJS_VERSION = pdfjsPackage.version
export const PDFJS_ASSET_BASE = `/pdfjs/${PDFJS_VERSION}`
export const PDFJS_WORKER_URL = `${PDFJS_ASSET_BASE}/pdf.worker.min.mjs`

export const pdfDocumentAssetOptions = {
  cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
  wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
  iccUrl: `${PDFJS_ASSET_BASE}/iccs/`,
}
