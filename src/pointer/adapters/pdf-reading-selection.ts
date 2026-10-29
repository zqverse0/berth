export type PdfCaret = {
  node: Node
  offset: number
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE
}

export function pdfTextLayerFromNode(node: Node | null): Element | null {
  const element = node && isElement(node) ? node : node?.parentElement
  return element?.closest(".textLayer") ?? null
}

type SpanBox = {
  span: Element
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 一次拖选内的 span 几何缓存：每层只量一次 span（相对文字层左上角），之后每次移动
 * 只量文字层本身。滚动 / 缩放会移动文字层，但不改变 span 在层内的位置。
 */
export type PdfHitCache = WeakMap<Element, SpanBox[]>

function measureLayer(layer: Element, origin: DOMRect): SpanBox[] {
  return Array.from(layer.querySelectorAll("span")).map((span) => {
    const rect = span.getBoundingClientRect()
    return {
      span,
      left: rect.left - origin.left,
      top: rect.top - origin.top,
      right: rect.right - origin.left,
      bottom: rect.bottom - origin.top,
    }
  })
}

/**
 * 按文字层实际排出的字形位置定位（替代字体 + scaleX），不按字符数等分——
 * i 和 W 宽度差几倍，等分会让光标落到别的字母上。二分只量 log n 个字。
 */
function caretInSpan(box: SpanBox, clientX: number): PdfCaret {
  const text = box.span.firstChild
  const content = text?.textContent ?? ""
  if (!text || text.nodeType !== Node.TEXT_NODE || content.length === 0) {
    return { node: box.span, offset: 0 }
  }
  const range = document.createRange()
  const charRect = (index: number) => {
    range.setStart(text, index)
    range.setEnd(text, index + 1)
    return range.getBoundingClientRect()
  }
  let low = 0
  let high = content.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (charRect(mid).right <= clientX) low = mid + 1
    else high = mid
  }
  if (low === content.length) return { node: text, offset: low }
  const rect = charRect(low)
  return {
    node: text,
    offset: clientX > rect.left + rect.width / 2 ? low + 1 : low,
  }
}

/**
 * 只打中指针所在视觉行上的 span，避免 PDF.js 重叠层把整页拖进选区。
 * `nearestLine`：拖选途中指针落在行距 / 段距里时取最近的一行，选区跟手而不是停住再跳。
 */
export function caretFromPointInPdfTextLayer(
  root: ParentNode,
  clientX: number,
  clientY: number,
  options: { cache?: PdfHitCache; nearestLine?: boolean } = {}
): PdfCaret | null {
  for (const layer of root.querySelectorAll(".textLayer")) {
    const origin = layer.getBoundingClientRect()
    if (
      clientX < origin.left ||
      clientX > origin.right ||
      clientY < origin.top ||
      clientY > origin.bottom
    ) {
      continue
    }
    let boxes = options.cache?.get(layer)
    if (!boxes) {
      boxes = measureLayer(layer, origin)
      // 文字层还没渲染完时不缓存空结果。
      if (boxes.length > 0) options.cache?.set(layer, boxes)
    }
    const x = clientX - origin.left
    const y = clientY - origin.top

    let hit: SpanBox | null = null
    for (const box of boxes) {
      if (x < box.left || x > box.right || y < box.top || y > box.bottom)
        continue
      const area = (box.right - box.left) * (box.bottom - box.top)
      if (!hit || area < (hit.right - hit.left) * (hit.bottom - hit.top))
        hit = box
    }
    if (hit) return caretInSpan(hit, clientX)

    let best: { box: SpanBox; score: number } | null = null
    for (const box of boxes) {
      const height = box.bottom - box.top
      const dy = Math.abs((box.top + box.bottom) / 2 - y)
      if (!options.nearestLine && dy > Math.max(4, height)) continue
      const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0
      // 优先同一行：竖直距离权重远大于水平距离。
      const score = options.nearestLine ? dy * 4 + dx : dy + dx
      if (!best || score < best.score) best = { box, score }
    }
    if (best) return caretInSpan(best.box, clientX)
  }
  return null
}

/**
 * 选区终点落在某段文字的偏移 0（指针在行首左侧）时，改到上一段文字末尾：选中内容不变，
 * 但避开 pdf.js 文字层全局 selectionchange 里 `endOffset === 0` 时向前找兄弟节点
 * 找到文档根而抛错（`anchor.previousSibling` of null）。
 */
function endBeforeLineStart(end: PdfCaret, start: PdfCaret): PdfCaret {
  if (end.offset !== 0) return end
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  walker.currentNode = end.node
  for (let node = walker.previousNode(); node; node = walker.previousNode()) {
    const length = node.textContent?.length ?? 0
    if (length === 0) continue
    // 已经退到起点之前：选区本来就是空的，收成起点。
    if (
      node !== start.node &&
      start.node.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_PRECEDING
    )
      return start
    return {
      node,
      offset: node === start.node ? Math.max(start.offset, length) : length,
    }
  }
  return start
}

export function applyPdfCaretRange(from: PdfCaret, to: PdfCaret): boolean {
  if (typeof window === "undefined") return false
  const selection = window.getSelection()
  if (!selection) return false
  // 空选区不留折叠的 range：折叠在偏移 0 时同样会触发上面 pdf.js 的那段查找。
  if (from.node === to.node && from.offset === to.offset) {
    selection.removeAllRanges()
    return true
  }
  const range = document.createRange()
  const position = from.node.compareDocumentPosition(to.node)
  const reversed =
    from.node === to.node
      ? from.offset > to.offset
      : Boolean(position & Node.DOCUMENT_POSITION_PRECEDING)
  try {
    const [first, last] = reversed ? [to, from] : [from, to]
    range.setStart(first.node, first.offset)
    const end = endBeforeLineStart(last, first)
    range.setEnd(end.node, end.offset)
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  } catch {
    return false
  }
}

/**
 * 用指针下的可见 glyph 建选区，而不是浏览器顺着重叠 span 的 DOM 顺序扩选。
 * 补的是 pdf.js 原生拖选在 WebKitGTK 上的空缺：2026-10-15 实测停用后会整页全选且卡顿，不要删。
 */
export function bindPdfReadingSelection(root: HTMLElement): () => void {
  let start: PdfCaret | null = null
  let dragging = false
  let pointerId: number | null = null
  let cache: PdfHitCache = new WeakMap()

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (!pdfTextLayerFromNode(event.target as Node | null)) return
    cache = new WeakMap()
    const caret = caretFromPointInPdfTextLayer(
      root,
      event.clientX,
      event.clientY,
      { cache }
    )
    if (!caret) return
    event.preventDefault()
    start = caret
    dragging = true
    pointerId = event.pointerId
    applyPdfCaretRange(caret, caret)
    try {
      root.setPointerCapture(event.pointerId)
    } catch {
      // 捕获失败时仍靠 window 上的 move/up。
    }
  }

  // 一帧最多算一次选区：pointermove 频率常高于刷新率。
  let frame: number | null = null
  let last: { x: number; y: number } | null = null
  const update = () => {
    frame = null
    if (!dragging || !start || !last) return
    const caret = caretFromPointInPdfTextLayer(root, last.x, last.y, {
      cache,
      nearestLine: true,
    })
    if (caret) applyPdfCaretRange(start, caret)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || !start) return
    if (pointerId != null && event.pointerId !== pointerId) return
    event.preventDefault()
    last = { x: event.clientX, y: event.clientY }
    if (frame === null) frame = requestAnimationFrame(update)
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!dragging) return
    if (pointerId != null && event.pointerId !== pointerId) return
    // 松手位置以最后一次移动为准，不丢掉还没刷新的那一帧。
    if (frame !== null) {
      cancelAnimationFrame(frame)
      update()
    }
    dragging = false
    pointerId = null
    start = null
    try {
      root.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
  }

  root.addEventListener("pointerdown", onPointerDown)
  root.addEventListener("pointermove", onPointerMove)
  root.addEventListener("pointerup", onPointerUp)
  root.addEventListener("pointercancel", onPointerUp)

  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
    root.removeEventListener("pointerdown", onPointerDown)
    root.removeEventListener("pointermove", onPointerMove)
    root.removeEventListener("pointerup", onPointerUp)
    root.removeEventListener("pointercancel", onPointerUp)
  }
}
