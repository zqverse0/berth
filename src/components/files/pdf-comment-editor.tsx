"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, MessageSquareQuote, Pencil, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_HEX,
  type PdfHighlight,
} from "@/lib/pdf/pdf-highlight-store"
import { computeMenuPosition, type MenuAnchor } from "@/pointer/position"
import { copyPlainToClipboard } from "@/pointer/clipboard"

/**
 * 胶囊菜单中「高亮」动作展开的调色板 + 可选注释输入区。
 * 填了注释点色块 → 高亮 + 批注；不填 → 纯高亮。
 */
export interface PdfHighlightPaletteProps {
  onPick: (color: string, comment?: string) => void
  /** 默认注释内容（编辑已有高亮时回填） */
  initialComment?: string
}

export function PdfHighlightPalette({
  onPick,
  initialComment,
}: PdfHighlightPaletteProps) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const [commentOpen, setCommentOpen] = useState(
    Boolean(initialComment?.trim())
  )
  const [text, setText] = useState(initialComment ?? "")

  const pick = useCallback(
    (color: string) => {
      onPick(color, text.trim() || undefined)
    },
    [onPick, text]
  )

  const toggleComment = useCallback(() => {
    setCommentOpen((open) => !open)
  }, [])

  return (
    <div className="flex w-full max-w-full flex-col px-3 py-1.5">
      <div className="flex items-center gap-2.5">
        <span className="text-xs text-muted-foreground font-medium shrink-0">
          {t("pdfHighlight")}
        </span>
        <div className="flex items-center gap-1.5">
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              data-color={color}
              title={color}
              aria-label={color}
              className="size-5.5 cursor-pointer rounded-full border border-border/60 transition-transform hover:scale-115 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: HIGHLIGHT_HEX[color] }}
              onClick={() => pick(color)}
            />
          ))}
        </div>
        <span className="h-3 w-px shrink-0 bg-border/60 mx-0.5" aria-hidden />
        <button
          type="button"
          title={t("pdfComment")}
          aria-label={t("pdfComment")}
          aria-expanded={commentOpen}
          className={cn(
            "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            commentOpen || text.trim()
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
          onClick={toggleComment}
        >
          <MessageSquareQuote className="size-3.5" />
        </button>
      </div>
      {commentOpen ? (
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("pdfHighlightCommentPlaceholder")}
          className="mt-1.5 w-full resize-none rounded-md bg-accent/40 px-2 py-1.5 text-[13px] leading-relaxed text-popover-foreground placeholder:text-muted-foreground focus:outline-none select-text min-h-[56px] max-h-40 overflow-y-auto"
          rows={2}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault()
              const trimmed = text.trim()
              if (trimmed) pick("yellow")
            }
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * 点击页面上已有下划线注释或高亮后的内容卡片。
 *
 * 布局完全对齐 TranslatePanel 规范，支持原地下划线锚点定位或居中展示。
 */
export interface PdfCommentEditorProps {
  highlight: PdfHighlight
  anchor?: MenuAnchor | null
  /** 保存注释（空串表示移除注释） */
  onSaveComment: (comment: string) => void
  /** 删除整条高亮/注释 */
  onDeleteHighlight: () => void
  onClose: () => void
}

export function PdfCommentEditor({
  highlight,
  anchor,
  onSaveComment,
  onDeleteHighlight,
  onClose,
}: PdfCommentEditorProps) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const [comment, setComment] = useState(highlight.comment ?? "")
  const [isEditing, setIsEditing] = useState(!highlight.comment?.trim())
  const containerRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const handleOutside = (event: Event) => {
      const target = event.target as Node | null
      if (!target) return
      if (containerRef.current && containerRef.current.contains(target)) {
        return
      }
      onCloseRef.current()
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current()
    }

    document.addEventListener("pointerdown", handleOutside, true)
    document.addEventListener("mousedown", handleOutside, true)
    window.addEventListener("keydown", handleKey)

    return () => {
      document.removeEventListener("pointerdown", handleOutside, true)
      document.removeEventListener("mousedown", handleOutside, true)
      window.removeEventListener("keydown", handleKey)
    }
  }, [])

  const handleSave = useCallback(() => {
    onSaveComment(comment.trim())
  }, [comment, onSaveComment])

  const handleCopy = useCallback(() => {
    if (!highlight.comment) return
    void copyPlainToClipboard(highlight.comment)
  }, [highlight.comment])

  const position = useMemo(() => {
    if (!anchor || typeof window === "undefined") return null
    return computeMenuPosition(
      anchor,
      { width: 320, height: 160 },
      { width: window.innerWidth, height: window.innerHeight },
      { preferredPlacement: "below" }
    )
  }, [anchor])

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t("pdfHighlightCommentTitle")}
      className={
        position
          ? "fixed z-[95] flex w-80 max-w-[calc(100vw-24px)] flex-col rounded-xl border border-border/80 bg-popover/95 backdrop-blur-xl text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 select-none overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100"
          : "fixed left-1/2 top-1/2 z-[95] flex w-80 max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border/80 bg-popover/95 backdrop-blur-xl text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 select-none overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100"
      }
      style={
        position
          ? {
              left: `${position.left}px`,
              top: `${position.top}px`,
            }
          : undefined
      }
      onMouseDown={(e) => {
        // 允许卡片内按钮点击、文字选择和输入，仅对空白区域阻止外部选区被误折叠
        if (
          (e.target as HTMLElement)?.closest(
            ".select-text, input, textarea, button, [contenteditable='true']"
          )
        ) {
          return
        }
        e.preventDefault()
      }}
    >
      {/* 头部标题与直接关闭按钮 */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-[11px] text-muted-foreground/80">
          {t("pdfComment")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="size-5 p-0 text-muted-foreground hover:text-foreground cursor-pointer rounded-full"
          onClick={onClose}
        >
          <X className="size-3" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {isEditing ? (
        <div className="flex w-full flex-col px-3 pt-2 pb-2">
          <textarea
            autoFocus
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={t("pdfHighlightCommentPlaceholder")}
            className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-popover-foreground placeholder:text-muted-foreground focus:outline-none select-text min-h-[64px] max-h-48 overflow-y-auto"
            rows={3}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault()
                handleSave()
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2 text-xs">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 cursor-pointer gap-1 px-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={onDeleteHighlight}
            >
              <Trash2 className="size-3" />
              {t("pdfHighlightCommentDelete")}
            </Button>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 cursor-pointer px-2 text-xs"
                onClick={() => {
                  if (highlight.comment?.trim()) {
                    setComment(highlight.comment)
                    setIsEditing(false)
                  } else {
                    onClose()
                  }
                }}
              >
                {t("pdfHighlightCommentCancel")}
              </Button>
              <Button
                type="button"
                size="xs"
                className="h-6 cursor-pointer px-2.5 text-xs font-medium"
                onClick={handleSave}
              >
                {t("pdfHighlightCommentSave")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex w-full flex-col">
          <div className="max-h-52 overflow-y-auto px-3 pt-2 pb-1 text-[13px] leading-relaxed select-text">
            <p className="whitespace-pre-wrap break-words text-popover-foreground">
              {highlight.comment}
            </p>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border/50 px-3 py-1.5 text-xs">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="secondary"
                size="xs"
                className="h-6 cursor-pointer gap-1 px-2 text-xs font-medium"
                onClick={handleCopy}
              >
                <Copy className="size-3" />
                {t("pdfCommentCopy")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 cursor-pointer gap-1 px-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={onDeleteHighlight}
              >
                <Trash2 className="size-3" />
                {t("pdfHighlightCommentDelete")}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 cursor-pointer gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setIsEditing(true)}
            >
              <Pencil className="size-3" />
              {t("pdfCommentEdit")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
