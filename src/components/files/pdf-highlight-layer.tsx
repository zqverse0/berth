/**
 * PDF 高亮 overlay 层：色块渲染在 React 自有的绝对定位覆盖层里，
 * 覆盖 pdf.js 的滚动可视区，随滚动/缩放/懒渲染动态重算位置。
 *
 * 坐标是 0–1 归一化（相对页面 box）；色块像素位置通过页面元素
 * `getBoundingClientRect` 相对 overlay 容器实时计算。
 *
 * 为什么不 portal 进 `.page`：pdf.js 的 `PDFPageView` 在渲染/缩放/文本层
 * 重建时会对 `.page` 内部做 `replaceChildren()`/`remove()`/`textContent=""`，
 * React portal 的子节点会被 pdf.js 原生清掉，React 卸载时在旧容器上
 * `removeChild` 找不到子节点 → `NotFoundError`。因此 overlay 必须放在
 * pdf.js 从不触碰的 DOM 位置（滚动容器内、`.pdfViewer` 的兄弟节点），
 * React 拥有其全部 DOM。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import {
  HIGHLIGHT_HEX,
  HIGHLIGHT_OPACITY,
  type PdfHighlight,
} from "@/lib/pdf/pdf-highlight-store"
import { mergePdfSelectionRects } from "@/lib/pdf/pdf-selection-geometry"

interface PdfHighlightLayerProps {
  highlights: PdfHighlight[]
  /** `.pdfViewer` 元素；页面元素是其直接子级，滚动容器是其父级 */
  viewerElement: HTMLElement | null
  /** PDF 当前缩放比例；缩放后需要重新计算页面坐标 */
  scale: number
  /** 点击色块 → 自定义高亮操作（可选） */
  onHighlightClick?: (highlight: PdfHighlight, anchor?: DOMRect) => void
  /** 选中色块按 Backspace/Delete 时删除高亮 */
  onDeleteHighlight?: (highlightId: string) => void
  /** 点击注释下划线 → 打开注释卡片 */
  onNoteClick?: (highlight: PdfHighlight, anchor?: DOMRect) => void
}

interface BlockPlacement {
  key: string
  highlight: PdfHighlight
  kind: "highlight" | "note"
  color: string
  title: string
  left: number
  top: number
  width: number
  height: number
}

function groupByPage(highlights: PdfHighlight[]): Map<number, PdfHighlight[]> {
  const map = new Map<number, PdfHighlight[]>()
  for (const highlight of highlights) {
    const list = map.get(highlight.page) ?? []
    list.push(highlight)
    map.set(highlight.page, list)
  }
  return map
}

export function PdfHighlightLayer({
  highlights,
  viewerElement,
  scale,
  onHighlightClick,
  onDeleteHighlight,
  onNoteClick,
}: PdfHighlightLayerProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [placements, setPlacements] = useState<BlockPlacement[]>([])
  const rafRef = useRef<number>(0)
  const placementsRef = useRef(highlights)

  /** 重算所有已挂载页面的色块与下划线像素位置。 */
  const recompute = useCallback(() => {
    const overlay = overlayRef.current
    const container = viewerElement?.parentElement ?? null
    if (!overlay || !viewerElement || !container) {
      setPlacements([])
      return
    }
    // 页面和色块都在同一个滚动坐标系中，必须以实际 overlay 为原点，
    // 不能使用固定在视口上的滚动容器，否则会重复计算 scroll 偏移。
    const overlayRect = overlay.getBoundingClientRect()
    const next: BlockPlacement[] = []
    const byPage = groupByPage(placementsRef.current)
    for (const [page, pageHighlights] of byPage) {
      const pageElement = viewerElement.querySelector(
        `[data-page-number="${page}"]`
      )
      if (!pageElement) continue
      const pageRect = pageElement.getBoundingClientRect()
      for (const highlight of pageHighlights) {
        const isNote = highlight.kind === "note"
        const mergedRects = mergePdfSelectionRects(highlight.rects)
        if (isNote) {
          mergedRects.forEach((rect, rectIndex) => {
            const width = rect.w * pageRect.width
            next.push({
              key: `${highlight.id}:${rectIndex}`,
              highlight,
              kind: "note",
              color: "",
              title: highlight.comment || highlight.quote,
              left: pageRect.left - overlayRect.left + rect.x * pageRect.width,
              top:
                pageRect.top -
                overlayRect.top +
                (rect.y + rect.h) * pageRect.height +
                1,
              width,
              height: 2,
            })
          })
        } else {
          const color =
            HIGHLIGHT_HEX[highlight.color ?? "yellow"] ?? HIGHLIGHT_HEX.yellow
          mergedRects.forEach((rect, rectIndex) => {
            next.push({
              key: `${highlight.id}:${rectIndex}`,
              highlight,
              kind: "highlight",
              color,
              title: highlight.comment ?? highlight.quote,
              left: pageRect.left - overlayRect.left + rect.x * pageRect.width,
              top: pageRect.top - overlayRect.top + rect.y * pageRect.height,
              width: rect.w * pageRect.width,
              height: rect.h * pageRect.height,
            })
          })
        }
      }
    }
    setPlacements(next)
  }, [viewerElement])

  /** rAF 节流：滚动时高频触发只重算一次。 */
  const scheduleRecompute = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => recompute())
  }, [recompute])

  // 首次挂载、文档缩放或高亮列表变化时重算。
  useLayoutEffect(() => {
    placementsRef.current = highlights
    scheduleRecompute()
  }, [highlights, scheduleRecompute, scale])

  // 滚动、容器尺寸、懒渲染页面增删 → 重算。
  useEffect(() => {
    const container = viewerElement?.parentElement ?? null
    if (!container) return

    const onScroll = () => scheduleRecompute()
    container.addEventListener("scroll", onScroll, { passive: true })

    const resizeObserver = new ResizeObserver(() => scheduleRecompute())
    resizeObserver.observe(container)

    const observer = new MutationObserver(() => scheduleRecompute())
    if (viewerElement) {
      observer.observe(viewerElement, { childList: true })
    }

    return () => {
      cancelAnimationFrame(rafRef.current)
      container.removeEventListener("scroll", onScroll)
      resizeObserver.disconnect()
      observer.disconnect()
    }
  }, [scheduleRecompute, viewerElement])

  // 卸载时清理挂起的 rAF。
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  if (!viewerElement) return null
  const container = viewerElement.parentElement
  if (!container) return null

  return createPortal(
    <div
      ref={overlayRef}
      className="berth-pdf-highlight-layer"
      aria-hidden="false"
    >
      {placements.map((placement) =>
        placement.kind === "note" ? (
          <button
            key={placement.key}
            type="button"
            className="berth-pdf-note-underline"
            title={placement.title}
            style={{
              left: `${placement.left}px`,
              top: `${placement.top}px`,
              width: `${placement.width}px`,
              height: `${placement.height}px`,
            }}
            onClick={(event) => {
              if (!onNoteClick) return
              event.preventDefault()
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              onNoteClick(placement.highlight, rect)
            }}
          />
        ) : (
          <button
            key={placement.key}
            type="button"
            className="berth-pdf-highlight"
            tabIndex={0}
            title={placement.title}
            style={{
              left: `${placement.left}px`,
              top: `${placement.top}px`,
              width: `${placement.width}px`,
              height: `${placement.height}px`,
              backgroundColor: placement.color,
              opacity: HIGHLIGHT_OPACITY,
            }}
            onClick={(event) => {
              event.currentTarget.focus()
              if (!onHighlightClick) return
              event.preventDefault()
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              onHighlightClick(placement.highlight, rect)
            }}
            onKeyDown={(event) => {
              if (event.key === "Backspace" || event.key === "Delete") {
                event.preventDefault()
                event.stopPropagation()
                onDeleteHighlight?.(placement.highlight.id)
              }
            }}
          />
        )
      )}
    </div>,
    container
  )
}
