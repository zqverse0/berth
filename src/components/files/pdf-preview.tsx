"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { MouseEvent as ReactMouseEvent } from "react"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { useTranslations } from "next-intl"
import { Highlighter } from "lucide-react"
import { toast } from "@/lib/notify"
import type { WorkspaceFileRef } from "@/lib/files/file-workspace-tab"
import type { FileViewerToolbarState } from "@/lib/files/file-viewer-definition"
import { openPdfDocument } from "@/lib/pdf/open-pdf-document"
import {
  acquirePdfSession,
  pdfSessionKey,
  type PdfSessionAcquire,
} from "@/lib/pdf/pdf-session-cache"
import {
  loadPdfReadingPosition,
  savePdfReadingPosition,
  type PdfReadingPosition,
} from "@/lib/pdf/pdf-reading-position"
import { joinRootRel } from "@/lib/files/file-open-target"
import { isLocalDesktop, openPath, openUrl } from "@/lib/platform"
import { useSplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction-context"
import { useFileViewerController } from "@/components/files/file-viewer-runtime"
import {
  createHighlight,
  loadHighlights,
  saveHighlights,
  type PdfHighlight,
} from "@/lib/pdf/pdf-highlight-store"
import {
  capturePdfSelectionGeometry,
  type PdfSelectionGeometry,
} from "@/lib/pdf/pdf-selection-geometry"
import {
  clearSettledSelection,
  paintSettledSelection,
  snapSelectionToWords,
} from "@/lib/pdf/pdf-selection-settle"
import { useOptionalPointer, type PointerSelectionAction } from "@/pointer"
import type { MenuAnchor } from "@/pointer/position"
import { installSafeGetComputedStyle } from "@/lib/safe-get-computed-style"
import { PdfHighlightLayer } from "./pdf-highlight-layer"
import { PdfHighlightPalette, PdfCommentEditor } from "./pdf-comment-editor"

import "pdfjs-dist/web/pdf_viewer.css"
import "./pdf-text-layer.css"

export interface PdfPreviewProps {
  file: WorkspaceFileRef
  sourceRevision: number
  /** Optional bounded text provider for the current-document context bridge. */
  onTextContent?: (content: string) => void
  initialPage?: number | null
}

type SelectionEnds = [Node | null, number, Node | null, number]

function selectionEnds(selection: Selection): SelectionEnds {
  return [
    selection.anchorNode,
    selection.anchorOffset,
    selection.focusNode,
    selection.focusOffset,
  ]
}

const MAX_PDF_CONTEXT_CHARS = 256 * 1024
const MIN_SCALE = 0.1
const MAX_SCALE = 3
const SCALE_STEP = 1.2

type PdfViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs")
type PdfViewerInstance = InstanceType<PdfViewerModule["PDFViewer"]>

export function PdfPreview({
  file,
  sourceRevision,
  onTextContent,
  initialPage,
}: PdfPreviewProps) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const translateRef = useRef(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])
  const { rootPath, path } = file
  const localDesktop = isLocalDesktop()
  const layoutTransaction = useSplitLayoutTransaction()
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerElementRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PdfViewerInstance | null>(null)
  const fitWidthRef = useRef(true)
  const [viewerModule, setViewerModule] = useState<PdfViewerModule | null>(null)
  const sessionAcquireRef = useRef<PdfSessionAcquire | null>(null)
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [activePage, setActivePage] = useState(1)
  const [scale, setScale] = useState(1)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<PdfHighlight[]>([])
  const [editingHighlightId, setEditingHighlightId] = useState<string | null>(
    null
  )
  const [editingAnchor, setEditingAnchor] = useState<MenuAnchor | null>(null)
  const [viewerElement, setViewerElement] = useState<HTMLElement | null>(null)
  const lastSelectionRef = useRef<PdfSelectionGeometry | null>(null)
  /** 松手整理后的选区端点；选区再变（新拖选、键盘扩选、折叠）就撤掉补缝色块。 */
  const settledEndsRef = useRef<SelectionEnds | null>(null)
  const hydratedRef = useRef(false)
  const dirtyRef = useRef(false)

  const sessionKey = useMemo(
    () => pdfSessionKey({ rootPath, path }, sourceRevision),
    [path, rootPath, sourceRevision]
  )

  useEffect(() => {
    installSafeGetComputedStyle()
    let cancelled = false
    void import("pdfjs-dist")
      .then((pdfjsLib) => {
        ;(
          globalThis as typeof globalThis & {
            pdfjsLib?: typeof pdfjsLib
          }
        ).pdfjsLib = pdfjsLib
        return import("pdfjs-dist/web/pdf_viewer.mjs")
      })
      .then((module) => {
        if (!cancelled) setViewerModule(module)
      })
      .catch((caught) => {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleOpenExternal = useCallback(async () => {
    try {
      await openPath(joinRootRel(rootPath, path))
    } catch (caught) {
      toast.error(translateRef.current("pdfOpenExternalFailed"), {
        description: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }, [path, rootPath])

  const openSession = useCallback(
    (signal: AbortSignal) =>
      openPdfDocument({
        file: { rootPath, path },
        revision: sourceRevision,
        signal,
        requestPassword: async () =>
          window.prompt(translateRef.current("pdfPassword")) ?? null,
      }),
    [path, rootPath, sourceRevision]
  )

  useEffect(() => {
    let cancelled = false
    setStatus("loading")
    setError(null)
    setPdfDoc(null)
    setLoadedSessionKey(null)
    setTotal(0)
    setActivePage(1)
    fitWidthRef.current = true

    const acquisition = acquirePdfSession(sessionKey, openSession)
    sessionAcquireRef.current = acquisition

    void (async () => {
      try {
        const lease = await acquisition.promise
        if (cancelled) {
          lease.release()
          return
        }
        if (sessionAcquireRef.current !== acquisition) {
          lease.release()
          return
        }
        const opened = lease.session
        if (!opened.document.numPages || opened.document.numPages < 1) {
          lease.release()
          throw new Error("PDF has no pages")
        }
        setTotal(opened.document.numPages)
        setLoadedSessionKey(sessionKey)
        setPdfDoc(opened.document)
        setStatus("ready")
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : typeof caught === "string"
                ? caught
                : translateRef.current("pdfLoadFailed")
          )
          setStatus("error")
        }
      }
    })()

    return () => {
      cancelled = true
      const current = sessionAcquireRef.current
      sessionAcquireRef.current = null
      setPdfDoc(null)
      current?.release()
    }
  }, [openSession, sessionKey])

  useEffect(() => {
    const container = containerRef.current
    const viewerElement = viewerElementRef.current
    if (
      !pdfDoc ||
      loadedSessionKey !== sessionKey ||
      !viewerModule ||
      !container ||
      !viewerElement
    )
      return

    const eventBus = new viewerModule.EventBus()
    const linkService = new viewerModule.PDFLinkService({ eventBus })
    const viewerAbortController = new AbortController()
    const viewerSession = acquirePdfSession(sessionKey, openSession)
    const viewerOptions = {
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      textLayerMode: 1,
      removePageBorders: true,
      abortSignal: viewerAbortController.signal,
    }
    const viewer = new viewerModule.PDFViewer(viewerOptions)
    viewerRef.current = viewer
    linkService.setViewer(viewer)

    const positionFile = { rootPath, path }
    // 显式跳转（引用 / 搜索结果）优先于上次阅读位置。
    const saved =
      initialPage == null ? loadPdfReadingPosition(positionFile) : null
    // 恢复完成前 pdf.js 会报告第 1 页的位置，不能拿它覆盖已存的位置。
    let restored = false
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let pendingPosition: PdfReadingPosition | null = null
    const flushPosition = () => {
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = null
      if (pendingPosition) savePdfReadingPosition(positionFile, pendingPosition)
      pendingPosition = null
    }
    const initPages = () => {
      const restore = () => {
        if (saved && !saved.fitWidth) {
          fitWidthRef.current = false
          viewer.currentScale = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, saved.scale)
          )
        } else {
          viewer.currentScaleValue = "page-width"
        }
        if (saved) {
          viewer.scrollPageIntoView({
            pageNumber: Math.min(viewer.pagesCount, saved.page),
            destArray: [null, { name: "XYZ" }, saved.left, saved.top, null],
          })
        }
        restored = true
      }
      if (layoutTransaction) layoutTransaction.schedule(restore)
      else restore()
      if (saved) return
      const requested = initialPage ?? 1
      viewer.currentPageNumber = Math.min(
        viewer.pagesCount,
        Math.max(1, requested)
      )
    }
    // 文件 tab 常驻但隐藏（display:none）时 pdf.js 量不到尺寸、滚动会抛错：等容器可见再初始化
    let initPending = false
    const hidden = () => container.checkVisibility?.() === false
    const handlePagesInit = () => {
      if (hidden()) initPending = true
      else initPages()
    }
    const handleViewArea = (event: {
      location?: { pageNumber: number; top: number; left: number }
    }) => {
      const location = event.location
      if (!restored || !location) return
      pendingPosition = {
        page: location.pageNumber,
        top: location.top,
        left: location.left,
        fitWidth: fitWidthRef.current,
        scale: viewer.currentScale,
      }
      if (saveTimer === null) saveTimer = setTimeout(flushPosition, 500)
    }
    const handlePageChanging = (event: { pageNumber: number }) => {
      setActivePage(event.pageNumber)
    }
    const handleScaleChanging = (event: { scale: number }) => {
      setScale(event.scale)
    }

    eventBus.on("pagesinit", handlePagesInit)
    eventBus.on("pagechanging", handlePageChanging)
    eventBus.on("scalechanging", handleScaleChanging)
    eventBus.on("updateviewarea", handleViewArea)
    viewer.setDocument(pdfDoc)
    linkService.setDocument(pdfDoc)

    const applyFitWidthIfNeeded = () => {
      if (!fitWidthRef.current || container.clientWidth <= 0) return
      const page = viewer.getPageView?.(viewer.currentPageNumber - 1)
      const currentScale = viewer.currentScale
      // drawingDelay:0 → 先 cssTransform 已有 canvas，下一 macrotask 再栅格化，
      // 避免松手瞬间把页面清空。
      if (
        page &&
        page.width > 0 &&
        currentScale > 0 &&
        typeof viewer.updateScale === "function"
      ) {
        const pageWidthScale = (container.clientWidth / page.width) * page.scale
        const scaleFactor = pageWidthScale / currentScale
        if (Number.isFinite(scaleFactor) && scaleFactor > 0) {
          viewer.updateScale({
            scaleFactor,
            drawingDelay: 0,
          })
          return
        }
      }
      viewer.currentScaleValue = "page-width"
    }
    const scheduleFitWidth = () => {
      if (initPending) {
        if (hidden()) return
        initPending = false
        initPages()
        return
      }
      if (layoutTransaction) layoutTransaction.schedule(applyFitWidthIfNeeded)
      else applyFitWidthIfNeeded()
    }
    const resizeObserver = new ResizeObserver(scheduleFitWidth)
    resizeObserver.observe(container)

    return () => {
      viewerRef.current = null
      resizeObserver.disconnect()
      eventBus.off("pagesinit", handlePagesInit)
      eventBus.off("pagechanging", handlePageChanging)
      eventBus.off("scalechanging", handleScaleChanging)
      eventBus.off("updateviewarea", handleViewArea)
      flushPosition()
      viewer.forceRendering = () => false
      if (viewer.renderingQueue) {
        viewer.renderingQueue.renderView = () => false
      }
      viewer.setDocument(null as unknown as PDFDocumentProxy)
      linkService.setDocument(null)
      viewerAbortController.abort()
      viewerSession.release()
    }
  }, [
    initialPage,
    layoutTransaction,
    loadedSessionKey,
    openSession,
    path,
    pdfDoc,
    rootPath,
    sessionKey,
    viewerModule,
  ])

  useEffect(() => {
    if (
      !pdfDoc ||
      loadedSessionKey !== sessionKey ||
      total < 1 ||
      !onTextContent
    )
      return
    let cancelled = false
    let extractionStarted = false
    const acquisition = acquirePdfSession(sessionKey, openSession)
    const extractionTimer = window.setTimeout(() => {
      extractionStarted = true
      void (async () => {
        const pages: string[] = []
        let length = 0
        try {
          const lease = await acquisition.promise
          if (cancelled) return
          const document = lease.session.document
          for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
            if (cancelled) break
            const page = await document.getPage(pageNumber)
            if (cancelled) break
            const textContent = await page.getTextContent()
            if (cancelled) break
            const text = textContent.items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" ")
              .trim()
            if (text) {
              const pageText = `\n\n[Page ${pageNumber}]\n${text}`
              const remaining = MAX_PDF_CONTEXT_CHARS - length
              if (remaining <= 0) break
              pages.push(pageText.slice(0, remaining))
              length += Math.min(pageText.length, remaining)
            }
            if (cancelled || length >= MAX_PDF_CONTEXT_CHARS) break
            if (pageNumber % 4 === 0) {
              await new Promise<void>((resolve) =>
                window.setTimeout(resolve, 0)
              )
            }
          }
        } catch (error) {
          if (cancelled) return
          console.error("[PdfPreview] failed to extract text", error)
        } finally {
          acquisition.release()
        }
        if (!cancelled) onTextContent(pages.join(""))
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(extractionTimer)
      if (!extractionStarted) acquisition.release()
    }
  }, [loadedSessionKey, onTextContent, openSession, pdfDoc, sessionKey, total])

  // pdf.js 把外链渲染成普通 <a href>，默认会让整个 webview 跳过去；
  // 改由系统浏览器打开。文内跳转（#dest）仍交给 pdf.js。
  const handleExternalLinkClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>(
        ".annotationLayer a[href]"
      )
      if (!link || !/^(https?|mailto):/i.test(link.href)) return
      event.preventDefault()
      event.stopPropagation()
      void openUrl(link.href)
    },
    []
  )

  // 选区几何：松手时记一份，供焦点移到批注输入框（选区已丢）后仍能高亮。
  // 用 pointerup 而不是 mouseup：文字层拖选在 pointerdown 上 preventDefault，
  // 兼容 mouse 事件不会再派发。拖选（pdf-reading-selection）把指针捕获在外层容器上，
  // 松手事件不经过本组件，所以挂在 document 上，排在拖选收尾之后。
  const handleSelectionPointerUp = useCallback(() => {
    const viewerElement = viewerElementRef.current
    const container = containerRef.current
    const selection = window.getSelection()
    if (!viewerElement || !container || !selection) return
    if (viewerElement.contains(selection.anchorNode))
      snapSelectionToWords(selection)
    const geom = capturePdfSelectionGeometry(viewerElement)
    if (geom && geom.pages.size > 0) {
      lastSelectionRef.current = geom
      paintSettledSelection(container, geom)
      settledEndsRef.current = selectionEnds(selection)
    }
  }, [])

  useEffect(() => {
    const onSelectionChange = () => {
      const container = containerRef.current
      const selection = window.getSelection()
      const settled = settledEndsRef.current
      if (!container || !settled) return
      if (
        selection &&
        selectionEnds(selection).every((end, index) => end === settled[index])
      )
        return
      settledEndsRef.current = null
      clearSettledSelection(container)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    document.addEventListener("pointerup", handleSelectionPointerUp)
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("pointerup", handleSelectionPointerUp)
    }
  }, [handleSelectionPointerUp])

  const captureCurrentSelection = useCallback(() => {
    // 当前选区仍在页面里时以它为准（含键盘扩选），否则用松手时记下的那份。
    const viewerElement = viewerElementRef.current
    const live = viewerElement
      ? capturePdfSelectionGeometry(viewerElement)
      : null
    if (live && live.pages.size > 0) {
      lastSelectionRef.current = live
      return live
    }
    return lastSelectionRef.current
  }, [])

  // PDF 就绪后加载 sidecar 高亮。
  // 依赖用原始字段 rootPath/path 而非 file 对象：父组件传 inline 对象字面量，
  // 每次渲染都是新引用（pointer 菜单开关就会触发），若依赖 file 会导致
  // hydrate 在用户创建高亮后重跑，把 setHighlights 覆盖回空 sidecar。
  useEffect(() => {
    if (!pdfDoc || loadedSessionKey !== sessionKey) return
    let cancelled = false
    hydratedRef.current = false
    void loadHighlights({ rootPath, path }).then((loaded) => {
      if (cancelled) return
      setHighlights(loaded)
      hydratedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [loadedSessionKey, path, pdfDoc, rootPath, sessionKey])

  // 高亮变化时保存（仅用户操作后，避免初始加载回写）
  useEffect(() => {
    if (!hydratedRef.current || !dirtyRef.current) return
    void saveHighlights({ rootPath, path }, highlights).then((saved) => {
      if (!saved) toast.error(t("pdfHighlightSaveFailed"))
    })
    dirtyRef.current = false
  }, [highlights, path, rootPath, t])

  const handlePickColor = useCallback(
    (
      color: string,
      comment?: string,
      passedGeometry?: PdfSelectionGeometry | null
    ): boolean => {
      const geometry = passedGeometry ?? captureCurrentSelection()
      if (!geometry || geometry.pages.size === 0) {
        toast.error(t("pdfHighlightSelectionUnavailable"))
        return false
      }

      const created: PdfHighlight[] = []
      for (const [page, rects] of geometry.pages) {
        const highlight = createHighlight(page, rects, geometry.quote, color)
        if (comment) highlight.comment = comment
        created.push(highlight)
      }
      if (created.length === 0) {
        toast.error(t("pdfHighlightSelectionUnavailable"))
        return false
      }

      setHighlights((prev) => [...prev, ...created])
      dirtyRef.current = true
      lastSelectionRef.current = null
      return true
    },
    [captureCurrentSelection, t]
  )

  const handleHighlightClick = useCallback(
    (highlight: PdfHighlight, anchor?: DOMRect) => {
      // 点击已有高亮：带注释的打开编辑卡片，纯高亮的没有可编辑内容
      if (!highlight.comment?.trim() && highlight.kind !== "note") return
      setEditingHighlightId(highlight.id)
      setEditingAnchor(
        anchor
          ? {
              left: anchor.left,
              top: anchor.top,
              right: anchor.right,
              bottom: anchor.bottom,
            }
          : null
      )
    },
    []
  )

  const handleSaveComment = useCallback(
    (comment: string) => {
      if (!editingHighlightId) return
      setHighlights((prev) =>
        prev.map((highlight) =>
          highlight.id === editingHighlightId
            ? {
                ...highlight,
                comment: comment || undefined,
                updatedAt: new Date().toISOString(),
              }
            : highlight
        )
      )
      dirtyRef.current = true
      setEditingHighlightId(null)
      setEditingAnchor(null)
    },
    [editingHighlightId]
  )

  const handleDeleteHighlight = useCallback(() => {
    if (!editingHighlightId) return
    setHighlights((prev) =>
      prev.filter((highlight) => highlight.id !== editingHighlightId)
    )
    dirtyRef.current = true
    setEditingHighlightId(null)
    setEditingAnchor(null)
  }, [editingHighlightId])

  const handleDeleteHighlightById = useCallback((highlightId: string) => {
    setHighlights((prev) =>
      prev.filter((highlight) => highlight.id !== highlightId)
    )
    dirtyRef.current = true
  }, [])

  const handleCloseCommentEditor = useCallback(() => {
    setEditingHighlightId(null)
    setEditingAnchor(null)
  }, [])

  // pointer 通用动作插槽：PDF 选中时展示「高亮」（调色板 + 可选注释）
  const pointer = useOptionalPointer()
  const highlightAction = useMemo<PointerSelectionAction>(
    () => ({
      id: "pdf-highlight",
      matches: (selection) => selection.source?.span?.unit === "page",
      label: t("pdfHighlight"),
      icon: <Highlighter className="h-3.5 w-3.5 shrink-0 text-yellow-500" />,
      panel: ({ closeMenu }) => {
        const currentGeometry = captureCurrentSelection()
        return (
          <PdfHighlightPalette
            onPick={(color, comment) => {
              if (handlePickColor(color, comment, currentGeometry)) closeMenu()
            }}
          />
        )
      },
    }),
    [captureCurrentSelection, handlePickColor, t]
  )

  useEffect(() => {
    if (!pointer) return
    const unregisterHighlight = pointer.registerSelectionAction(highlightAction)
    return () => {
      unregisterHighlight()
    }
  }, [pointer, highlightAction])

  const editingHighlight = useMemo(
    () =>
      editingHighlightId
        ? (highlights.find(
            (highlight) => highlight.id === editingHighlightId
          ) ?? null)
        : null,
    [editingHighlightId, highlights]
  )

  const setPage = useCallback(
    (pageNumber: number) => {
      const viewer = viewerRef.current
      if (!viewer || total < 1) return
      viewer.currentPageNumber = Math.min(total, Math.max(1, pageNumber))
    },
    [total]
  )

  const stepZoom = useCallback((direction: "in" | "out") => {
    const viewer = viewerRef.current
    if (!viewer) return
    const next =
      direction === "in"
        ? Math.min(MAX_SCALE, viewer.currentScale * SCALE_STEP)
        : Math.max(MIN_SCALE, viewer.currentScale / SCALE_STEP)
    fitWidthRef.current = false
    viewer.currentScale = next
  }, [])

  const applyFitWidth = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    fitWidthRef.current = true
    viewer.currentScaleValue = "page-width"
  }, [])
  const toolbarController = useMemo<FileViewerToolbarState>(
    () => ({
      kind: "pdf",
      ...(status === "ready"
        ? {
            zoom: {
              value: Math.round(scale * 100),
              min: MIN_SCALE * 100,
              max: MAX_SCALE * 100,
              in: () => stepZoom("in"),
              out: () => stepZoom("out"),
            },
            pdf: {
              page: activePage,
              total,
              setPage,
              fitWidth: applyFitWidth,
            },
          }
        : {}),
      ...(localDesktop ? { openExternal: handleOpenExternal } : {}),
    }),
    [
      activePage,
      applyFitWidth,
      handleOpenExternal,
      localDesktop,
      scale,
      setPage,
      status,
      stepZoom,
      total,
    ]
  )
  useFileViewerController(toolbarController)

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {status === "loading" && (
        <div className="p-3 text-sm text-muted-foreground">
          {t("pdfLoading")}
        </div>
      )}
      {status === "error" && (
        <div role="alert" className="p-3 text-sm">
          {t("pdfLoadFailed")}
          {error ? `: ${error}` : ""}
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div style={{ all: "revert" }}>
          <div
            ref={containerRef}
            className="pdf-viewer-container"
            onClickCapture={handleExternalLinkClick}
          >
            <div
              ref={(element) => {
                viewerElementRef.current = element
                setViewerElement(element)
              }}
              className="pdfViewer"
            />
          </div>
        </div>
      </div>
      <PdfHighlightLayer
        highlights={highlights}
        viewerElement={viewerElement}
        scale={scale}
        onDeleteHighlight={handleDeleteHighlightById}
        onHighlightClick={handleHighlightClick}
        onNoteClick={handleHighlightClick}
      />
      {editingHighlight ? (
        <PdfCommentEditor
          highlight={editingHighlight}
          anchor={editingAnchor}
          onSaveComment={handleSaveComment}
          onDeleteHighlight={handleDeleteHighlight}
          onClose={handleCloseCommentEditor}
        />
      ) : null}
    </div>
  )
}
