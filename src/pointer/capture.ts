import type { PointerSelection, SourceRef } from "./types"

export function readDomExcerpt(container?: ParentNode | null): string {
  if (typeof window === "undefined") return ""
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return ""
  }
  const range = selection.getRangeAt(0)
  if (container) {
    try {
      if (
        !container.contains(range.startContainer) ||
        !container.contains(range.endContainer)
      ) {
        return ""
      }
    } catch {
      return ""
    }
  }
  return selection.toString()
}

export function findPdfPageNumber(
  node: Node | null,
  range?: Range | null
): number | null {
  const tryNode = (n: Node | null): number | null => {
    let current: Node | null = n
    while (current) {
      if (current instanceof HTMLElement) {
        // pdf.js 6.x 的页面 div 用 data-page-number；保留旧 data-pdf-page 兼容
        const raw = current.dataset.pageNumber ?? current.dataset.pdfPage
        if (raw) {
          const page = Number.parseInt(raw, 10)
          if (Number.isFinite(page) && page > 0) return page
        }
      }
      current = current.parentNode
    }
    return null
  }

  const pageFromNode = tryNode(node)
  if (pageFromNode) return pageFromNode

  if (range) {
    const pageFromStart = tryNode(range.startContainer)
    if (pageFromStart) return pageFromStart
    const pageFromEnd = tryNode(range.endContainer)
    if (pageFromEnd) return pageFromEnd
    const pageFromAncestor = tryNode(range.commonAncestorContainer)
    if (pageFromAncestor) return pageFromAncestor

    if (range.commonAncestorContainer instanceof HTMLElement) {
      const pageEl =
        range.commonAncestorContainer.closest<HTMLElement>(
          "[data-page-number],[data-pdf-page]"
        ) ??
        range.commonAncestorContainer.querySelector<HTMLElement>(
          "[data-page-number],[data-pdf-page]"
        )
      if (pageEl) {
        const raw = pageEl.dataset.pageNumber ?? pageEl.dataset.pdfPage
        if (raw) {
          const page = Number.parseInt(raw, 10)
          if (Number.isFinite(page) && page > 0) return page
        }
      }
    }
  }

  return null
}

export function selectionHasText(selection: PointerSelection | null): boolean {
  return Boolean(selection?.excerpt.trim())
}

/** 有选中文字时拦截右键，让物体菜单让路。 */
export function shouldInterceptContextMenu(
  selection: PointerSelection | null
): boolean {
  return selectionHasText(selection)
}

export function isPointerOwnedTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("[data-pointer-surface]"))
  )
}

/** 右键点中的节点是否落在当前 DOM 选区内。 */
export function selectionTouchesTarget(target: EventTarget | null): boolean {
  if (typeof window === "undefined" || !(target instanceof Node)) return false
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false
  }
  try {
    if (selection.containsNode(target, true)) return true
    const range = selection.getRangeAt(0)
    const ancestor = range.commonAncestorContainer
    if (target instanceof Element && target.contains(ancestor)) return true
  } catch {
    return false
  }
  return false
}

/**
 * 只有「此刻真有选中，并且右键点在这段选中上」才弹出选中菜单。
 * 过期的 reportSelection、或别处残留的选区，都不能压过文件树/标签物体菜单。
 */
export function resolveContextMenuSelection(input: {
  liveExcerpt: string
  liveTouchesTarget: boolean
  reported: PointerSelection | null
  onOwnedSurface: boolean
}): PointerSelection | null {
  const reported = input.reported
  // 适配器上报的选区优先：xterm DOM 选区和 getSelection() 可能不一致。
  if (input.onOwnedSurface && reported?.excerpt.trim()) {
    return reported
  }
  const live = input.liveExcerpt.trim()
  if (live && input.liveTouchesTarget) {
    const source =
      reported?.source && reported.excerpt.trim() === live
        ? { ...reported.source, excerpt: live }
        : null
    return {
      excerpt: live,
      editable: Boolean(reported?.editable),
      source,
    }
  }
  return null
}

export function sourceFromDomSelection(options: {
  container?: HTMLElement | null
  identity?: SourceRef["identity"] | null
  span?: SourceRef["span"]
  editable?: boolean
}): PointerSelection | null {
  const excerpt = readDomExcerpt(options.container ?? undefined)
  if (!excerpt.trim()) return null
  const identity = options.identity ?? null
  return {
    excerpt,
    editable: Boolean(options.editable),
    source: identity
      ? {
          identity,
          span: options.span,
          excerpt,
        }
      : null,
  }
}
