import type { WorkspaceFileRef } from "@/lib/files/file-workspace-tab"

/** 上次读到的位置：页码 + 页内 PDF 坐标（pdf.js `updateviewarea` 的 location）+ 缩放方式。 */
export interface PdfReadingPosition {
  page: number
  top: number
  left: number
  /** true = 适应宽度；false 时用 `scale`。 */
  fitWidth: boolean
  scale: number
}

const KEY_PREFIX = "berth:pdf-position:"

// 不带 sourceRevision：文件更新后仍回到原位置（页码由调用方按新页数夹紧）。
// ponytail: 每个读过的 PDF 留一条 localStorage，不做淘汰；条目上千再加 LRU。
function positionKey(file: WorkspaceFileRef): string {
  return `${KEY_PREFIX}${file.rootPath}\0${file.path}`
}

export function loadPdfReadingPosition(
  file: WorkspaceFileRef
): PdfReadingPosition | null {
  try {
    const raw = localStorage.getItem(positionKey(file))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PdfReadingPosition>
    if (
      !Number.isInteger(value.page) ||
      (value.page ?? 0) < 1 ||
      !Number.isFinite(value.top) ||
      !Number.isFinite(value.left) ||
      typeof value.fitWidth !== "boolean" ||
      !Number.isFinite(value.scale) ||
      (value.scale ?? 0) <= 0
    )
      return null
    return value as PdfReadingPosition
  } catch {
    return null
  }
}

export function savePdfReadingPosition(
  file: WorkspaceFileRef,
  position: PdfReadingPosition
): void {
  try {
    localStorage.setItem(positionKey(file), JSON.stringify(position))
  } catch {
    // 存储满或被禁用：只是丢失位置记忆。
  }
}
