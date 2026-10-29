/**
 * PDF 选区松手后的两步整理：
 * 1. 吸附整词：pdf.js 文字层用替代字体拉伸整段，段内逐字位置不准；跨词拖选时把两端推到词边缘。
 * 2. 补缝：pdf.js 只给有文字的 span 画选区，词与词之间断开；松手后按行画连续色块，
 *    直接挂在页面元素里、用百分比定位，滚动 / 缩放不用重算。拖动中仍由 pdf.js 绘制。
 */

import type { PdfSelectionGeometry } from "./pdf-selection-geometry"

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })

/** 松手后的选区色块；容器带这个类时隐藏 pdf.js 自己的选区。 */
export const SETTLED_BLOCK_CLASS = "berth-pdf-settled-selection"
export const SETTLED_CONTAINER_CLASS = "berth-pdf-selection-settled"

/** 文本里的一个边界若落在词中间，推到词首（toStart）或词尾。 */
export function wordEdge(text: string, offset: number, toStart: boolean) {
  for (const { index, segment, isWordLike } of segmenter.segment(text)) {
    if (offset <= index) break
    const end = index + segment.length
    if (isWordLike && offset < end) return toStart ? index : end
  }
  return offset
}

function wordCount(text: string) {
  let count = 0
  for (const { isWordLike } of segmenter.segment(text)) if (isWordLike) count++
  return count
}

function edge(node: Node, offset: number, toStart: boolean) {
  return node.nodeType === Node.TEXT_NODE
    ? wordEdge(node.textContent ?? "", offset, toStart)
    : offset
}

/** 跨两个以上词时把选区两端吸附到整词；一个词以内保持逐字。 */
export function snapSelectionToWords(selection: Selection) {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  if (selection.isCollapsed || !anchorNode || !focusNode) return
  if (wordCount(selection.toString()) < 2) return
  const position = anchorNode.compareDocumentPosition(focusNode)
  const backward =
    anchorNode === focusNode
      ? focusOffset < anchorOffset
      : (position & Node.DOCUMENT_POSITION_PRECEDING) !== 0
  selection.setBaseAndExtent(
    anchorNode,
    edge(anchorNode, anchorOffset, !backward),
    focusNode,
    edge(focusNode, focusOffset, backward)
  )
}

export function clearSettledSelection(container: HTMLElement) {
  container.classList.remove(SETTLED_CONTAINER_CLASS)
  for (const block of container.querySelectorAll(`.${SETTLED_BLOCK_CLASS}`))
    block.remove()
}

export function paintSettledSelection(
  container: HTMLElement,
  geometry: PdfSelectionGeometry
) {
  clearSettledSelection(container)
  for (const [page, rects] of geometry.pages) {
    const pageElement = container.querySelector(`[data-page-number="${page}"]`)
    if (!pageElement) continue
    for (const rect of rects) {
      const block = document.createElement("div")
      block.className = SETTLED_BLOCK_CLASS
      block.style.left = `${rect.x * 100}%`
      block.style.top = `${rect.y * 100}%`
      block.style.width = `${rect.w * 100}%`
      block.style.height = `${rect.h * 100}%`
      pageElement.appendChild(block)
    }
  }
  container.classList.add(SETTLED_CONTAINER_CLASS)
}
