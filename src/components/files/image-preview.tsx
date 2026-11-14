"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import type { ImageResourceFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import type { FileViewerToolbarState } from "@/lib/files/file-viewer-definition"
import { useSplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction-context"
import { useFileViewerController } from "@/components/files/file-viewer-runtime"

const ZOOM_STEP = 0.25
const ZOOM_MIN = 0.1
const ZOOM_MAX = 10
const IMAGE_PADDING = 48 // p-6 * 2

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Compute the fitted (object-fit: contain) size of an image within a container.
 * Returns the CSS pixel dimensions the image would have at zoom=1.
 */
function fittedSize(
  naturalW: number,
  naturalH: number,
  containerW: number,
  containerH: number
): { width: number; height: number } {
  if (naturalW === 0 || naturalH === 0 || containerW === 0 || containerH === 0)
    return { width: 0, height: 0 }
  const availW = containerW - IMAGE_PADDING
  const availH = containerH - IMAGE_PADDING
  if (availW <= 0 || availH <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, availW / naturalW, availH / naturalH)
  return {
    width: Math.round(naturalW * scale),
    height: Math.round(naturalH * scale),
  }
}

export function ImagePreview({
  tab,
  visible = true,
}: {
  tab: ImageResourceFileWorkspaceTab
  /** 隐藏时不建 object URL、不挂 <img>，切走的 tab 不持有解码后的位图 */
  visible?: boolean
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const layoutTransaction = useSplitLayoutTransaction()
  const [zoom, setZoom] = useState(1)
  const [naturalWidth, setNaturalWidth] = useState(0)
  const [naturalHeight, setNaturalHeight] = useState(0)

  const blob = tab.preview.blob
  const fileSize = blob?.size ?? 0
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  // create / revoke 成对放在同一 effect：StrictMode 重跑与隐藏、关 tab 都不会留下或用到失效的 URL
  useEffect(() => {
    if (!blob || !visible) return
    const url = URL.createObjectURL(blob)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URL 是外部资源，只能在 effect 里同步
    setObjectUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setObjectUrl(null)
    }
  }, [blob, visible])

  const [containerSize, setContainerSize] = useState<{
    w: number
    h: number
  }>({ w: 0, h: 0 })

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))
  }, [])

  const handleZoomReset = useCallback(() => {
    setZoom(1)
  }, [])

  const handleImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget
      setNaturalWidth(img.naturalWidth)
      setNaturalHeight(img.naturalHeight)
    },
    []
  )

  // Track container size with ResizeObserver + wheel handler (passive: false).
  // Uses a callback ref so setup happens when the DOM node appears
  // (it's conditionally rendered behind !tab.loading).
  const scrollRef = useRef<HTMLDivElement>(null)
  // 隐藏时滚动容器随 <img> 卸掉，切回时恢复上次的滚动位置
  const scrollPos = useRef({ left: 0, top: 0 })
  const roRef = useRef<ResizeObserver | null>(null)
  const wheelHandler = useRef((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setZoom((z) => {
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta))
      })
    }
  })

  const scrollCallbackRef = useCallback(
    (el: HTMLDivElement | null) => {
      // Tear down previous
      const prev = scrollRef.current
      if (prev) {
        prev.removeEventListener("wheel", wheelHandler.current)
      }
      if (roRef.current) {
        roRef.current.disconnect()
        roRef.current = null
      }

      scrollRef.current = el
      if (!el) return
      el.scrollLeft = scrollPos.current.left
      el.scrollTop = scrollPos.current.top

      // ResizeObserver。分隔线预览期间只保留最新值，提交时再更新一次 React。
      let pendingSize: { w: number; h: number } | null = null
      const applyPendingSize = () => {
        if (!pendingSize) return
        setContainerSize(pendingSize)
        pendingSize = null
      }
      const onResize = (entries: ResizeObserverEntry[]) => {
        const entry = entries[0]
        if (!entry) return
        pendingSize = {
          w: entry.contentRect.width,
          h: entry.contentRect.height,
        }
        if (layoutTransaction) layoutTransaction.schedule(applyPendingSize)
        else applyPendingSize()
      }
      roRef.current = new ResizeObserver(onResize)
      roRef.current.observe(el)

      // Wheel handler with { passive: false } so preventDefault works
      el.addEventListener("wheel", wheelHandler.current, { passive: false })
    },
    [layoutTransaction]
  )

  // Right-click drag to pan
  const dragRef = useRef<{
    active: boolean
    startX: number
    startY: number
    scrollX: number
    scrollY: number
  } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return
    const el = scrollRef.current
    if (!el) return
    e.preventDefault()
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      scrollX: el.scrollLeft,
      scrollY: el.scrollTop,
    }
    el.style.cursor = "grabbing"
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag?.active) return
      const el = scrollRef.current
      if (!el) return
      el.scrollLeft = drag.scrollX - (e.clientX - drag.startX)
      el.scrollTop = drag.scrollY - (e.clientY - drag.startY)
    }
    const handleMouseUp = () => {
      if (!dragRef.current?.active) return
      dragRef.current = null
      const el = scrollRef.current
      if (el) el.style.cursor = ""
    }
    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // Compute display dimensions dynamically from natural size + container size
  const ready =
    naturalWidth > 0 &&
    naturalHeight > 0 &&
    containerSize.w > 0 &&
    containerSize.h > 0
  const base = fittedSize(
    naturalWidth,
    naturalHeight,
    containerSize.w,
    containerSize.h
  )
  const displayWidth = ready ? base.width * zoom : undefined
  const displayHeight = ready ? base.height * zoom : undefined
  const zoomPercent = Math.round(zoom * 100)
  const toolbarController = useMemo<FileViewerToolbarState | null>(() => {
    if (!blob) return null
    return {
      kind: "image",
      zoom: {
        value: zoomPercent,
        min: ZOOM_MIN * 100,
        max: ZOOM_MAX * 100,
        in: handleZoomIn,
        out: handleZoomOut,
        reset: handleZoomReset,
      },
      metadata: [
        ...(naturalWidth > 0 && naturalHeight > 0
          ? [
              {
                label: t("imageDimensions"),
                value: `${naturalWidth} x ${naturalHeight}`,
              },
            ]
          : []),
        ...(fileSize > 0
          ? [{ label: t("imageFileSize"), value: formatFileSize(fileSize) }]
          : []),
      ],
    }
  }, [
    blob,
    fileSize,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    naturalHeight,
    naturalWidth,
    t,
    zoomPercent,
  ])
  useFileViewerController(toolbarController)

  return (
    <div className="h-full flex flex-col">
      {tab.loading && (
        <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
          {t("loading")}
        </div>
      )}
      {objectUrl && (
        <div
          ref={scrollCallbackRef}
          className="flex-1 min-h-0 overflow-auto bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
          onMouseDown={handleMouseDown}
          onContextMenu={handleContextMenu}
          onScroll={(e) => {
            scrollPos.current = {
              left: e.currentTarget.scrollLeft,
              top: e.currentTarget.scrollTop,
            }
          }}
        >
          <div
            className="box-border p-6"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "100%",
              minHeight: "100%",
              ...(displayWidth != null
                ? {
                    width: displayWidth + IMAGE_PADDING,
                    height: (displayHeight ?? 0) + IMAGE_PADDING,
                  }
                : {}),
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={objectUrl}
              alt={tab.title}
              onLoad={handleImageLoad}
              style={{
                display: "block",
                flexShrink: 0,
                ...(displayWidth != null
                  ? { width: displayWidth, height: displayHeight }
                  : { maxWidth: "100%", maxHeight: "100%" }),
              }}
            />
          </div>
        </div>
      )}
      {!blob && tab.loading && (
        <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
          {t("loading")}
        </div>
      )}
    </div>
  )
}
