/**
 * PDF 选区几何捕获：把 `Range.getClientRects()` 的客户端矩形归一化为
 * 0–1 页面百分比坐标，并按页分组。
 *
 * 与 pointer 模块配合（方案 A）：pdf-preview 在 `containerRef` 上监听
 * `mouseup`（冒泡早于 pointer 的 document 监听），把几何暂存起来，
 * 供点击 pointer 工具栏的「高亮」动作时读取 —— 因为点击按钮前选区已被折叠。
 */

import type { PdfHighlightRect } from "./pdf-highlight-store"

/** 捕获结果：被选文本 + 页码 → 归一化矩形列表。 */
export type PdfSelectionGeometry = {
  quote: string
  /** key 为 1-based 页码 */
  pages: Map<number, PdfHighlightRect[]>
}

/** pdfjs 每页元素的选择器（div[data-page-number]）。 */
export const PAGE_SELECTOR = "[data-page-number]"

/** 判断客户端矩形是否落在页面 box 内（容错：负宽高/零面积/越界丢弃）。 */
export function rectWithinPage(
  clientRect: Pick<
    DOMRect,
    "left" | "top" | "right" | "bottom" | "width" | "height"
  >,
  pageBox: Pick<DOMRect, "left" | "top" | "width" | "height">
): boolean {
  if (clientRect.width <= 0 || clientRect.height <= 0) return false
  const overlapLeft = Math.max(clientRect.left, pageBox.left)
  const overlapRight = Math.min(clientRect.right, pageBox.left + pageBox.width)
  const overlapTop = Math.max(clientRect.top, pageBox.top)
  const overlapBottom = Math.min(
    clientRect.bottom,
    pageBox.top + pageBox.height
  )
  return overlapLeft < overlapRight && overlapTop < overlapBottom
}

/** 把客户端矩形归一化为 0–1 页面百分比坐标；无效返回 null。 */
export function normalizeRectToPage(
  clientRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  pageBox: Pick<DOMRect, "left" | "top" | "width" | "height">
): PdfHighlightRect | null {
  if (pageBox.width <= 0 || pageBox.height <= 0) return null
  if (clientRect.width <= 0 || clientRect.height <= 0) return null
  return {
    x: (clientRect.left - pageBox.left) / pageBox.width,
    y: (clientRect.top - pageBox.top) / pageBox.height,
    w: clientRect.width / pageBox.width,
    h: clientRect.height / pageBox.height,
  }
}

/**
 * 用客户端坐标定位所属页面元素（pdfjs `.page`）。
 * 优先 elementFromPoint（命中 textLayer span / canvas / 高亮块都能向上找到 page），
 * 失败时回退为按矩形中心遍历所有页面 box。
 */
export function findPageElement(
  viewerElement: HTMLElement,
  centerX: number,
  centerY: number
): HTMLElement | null {
  if (typeof document !== "undefined") {
    const hit = document.elementFromPoint(centerX, centerY)
    if (hit && viewerElement.contains(hit)) {
      const page = hit.closest<HTMLElement>(PAGE_SELECTOR)
      if (page) return page
    }
  }
  // 回退：遍历可见页面，中心点包含在内取最小面积者
  let best: HTMLElement | null = null
  let bestArea = Infinity
  for (const page of viewerElement.querySelectorAll<HTMLElement>(
    PAGE_SELECTOR
  )) {
    const box = page.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) continue
    if (
      centerX >= box.left &&
      centerX <= box.right &&
      centerY >= box.top &&
      centerY <= box.bottom
    ) {
      const area = box.width * box.height
      if (area < bestArea) {
        bestArea = area
        best = page
      }
    }
  }
  return best
}

function pageNumber(pageEl: HTMLElement): number | null {
  const raw = pageEl.getAttribute("data-page-number")
  if (!raw) return null
  const page = Number(raw)
  return Number.isFinite(page) ? page : null
}

const SAME_LINE_TOLERANCE = 0.006

type SelectionLine = {
  left: number
  right: number
  top: number
  bottom: number
  centerY: number
}

function cleanFloat(value: number): number {
  return Math.round(value * 1e8) / 1e8
}

/** 把同一视觉行中被空格或 span 拆开的选区片段合并成一条连续线/连续色块。 */
export function mergePdfSelectionRects(
  rects: PdfHighlightRect[]
): PdfHighlightRect[] {
  const lines: SelectionLine[] = []
  const sorted = [...rects]
    .filter((rect) => rect.w > 0 && rect.h > 0)
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const rect of sorted) {
    const top = rect.y
    const bottom = rect.y + rect.h
    const centerY = (top + bottom) / 2
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.centerY - centerY) <=
        Math.max(
          SAME_LINE_TOLERANCE,
          Math.min(candidate.bottom - candidate.top, rect.h) * 0.75
        )
    )

    if (line) {
      line.left = Math.min(line.left, rect.x)
      line.right = Math.max(line.right, rect.x + rect.w)
      line.top = Math.min(line.top, top)
      line.bottom = Math.max(line.bottom, bottom)
      line.centerY = (line.top + line.bottom) / 2
      continue
    }

    lines.push({
      left: rect.x,
      right: rect.x + rect.w,
      top,
      bottom,
      centerY,
    })
  }

  return lines
    .sort((left, right) => left.top - right.top || left.left - right.left)
    .map((line) => ({
      x: cleanFloat(line.left),
      y: cleanFloat(line.top),
      w: cleanFloat(line.right - line.left),
      h: cleanFloat(line.bottom - line.top),
    }))
}

/**
 * 捕获当前 DOM 选区的 PDF 几何。
 * 返回 null 表示无有效选区（空/折叠/不在 viewer 内/无可见矩形）。
 */
export function capturePdfSelectionGeometry(
  viewerElement: HTMLElement
): PdfSelectionGeometry | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0)
    return null
  const range = selection.getRangeAt(0)
  if (!viewerElement.contains(range.commonAncestorContainer)) return null
  const quote = selection.toString().trim()
  if (!quote) return null

  const pages = new Map<number, PdfHighlightRect[]>()
  const clientRects = range.getClientRects()
  for (const clientRect of Array.from(clientRects)) {
    const centerX = clientRect.left + clientRect.width / 2
    const centerY = clientRect.top + clientRect.height / 2
    const pageEl = findPageElement(viewerElement, centerX, centerY)
    if (!pageEl) continue
    const page = pageNumber(pageEl)
    if (page === null) continue
    const pageBox = pageEl.getBoundingClientRect()
    if (!rectWithinPage(clientRect, pageBox)) continue
    const norm = normalizeRectToPage(clientRect, pageBox)
    if (!norm) continue
    const list = pages.get(page) ?? []
    list.push(norm)
    pages.set(page, list)
  }
  if (pages.size === 0) return null

  const mergedPages = new Map<number, PdfHighlightRect[]>()
  for (const [page, list] of pages) {
    const merged = mergePdfSelectionRects(list)
    if (merged.length > 0) {
      mergedPages.set(page, merged)
    }
  }
  if (mergedPages.size === 0) return null
  return { quote, pages: mergedPages }
}
