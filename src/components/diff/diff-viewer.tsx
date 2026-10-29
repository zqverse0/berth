"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { getChunks, type Chunk, unifiedMergeView } from "@codemirror/merge"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { useZoomLevel, useEditorFont } from "@/hooks/use-appearance"
import {
  createAppearanceExtensions,
  createBaseExtensions,
  createCapabilityExtensions,
} from "@/lib/editor/extensions"
import {
  invalidateEditorLanguagePacks,
  loadEditorLanguageById,
} from "@/lib/editor/language-packs"
import { cn } from "@/lib/utils"

export interface DiffViewerProps {
  original: string
  modified: string
  originalLabel?: string
  modifiedLabel?: string
  language?: string
  className?: string
  onSelection?: (selection: DiffViewerSelection | null) => void
}

export interface DiffViewerSelection {
  text: string
  location: string
  range: { start: number; end: number }
  sourceContent: string
  anchor: { left: number; top: number } | null
}

function selectionOf(view: EditorView): DiffViewerSelection | null {
  const selection = view.state.selection.main
  if (selection.empty) return null
  const text = view.state.sliceDoc(selection.from, selection.to)
  if (!text.trim()) return null
  const start = view.state.doc.lineAt(selection.from).number
  let end = view.state.doc.lineAt(selection.to).number
  if (end > start && selection.to === view.state.doc.line(end).from) end -= 1
  const coords = view.coordsAtPos(selection.from)
  return {
    text,
    location: `modified lines ${start}-${end}`,
    range: { start, end: Math.max(start, end) },
    sourceContent: view.state.doc.toString(),
    anchor: coords ? { left: coords.left, top: coords.top } : null,
  }
}

function changedLines(
  chunks: readonly Chunk[],
  original: string,
  modified: string
) {
  const count = (text: string) => (text ? text.split("\n").length : 0)
  let additions = 0
  let deletions = 0
  for (const chunk of chunks) {
    additions += count(modified.slice(chunk.fromB, chunk.endB))
    deletions += count(original.slice(chunk.fromA, chunk.endA))
  }
  return { additions, deletions }
}

export function DiffViewer({
  original,
  modified,
  originalLabel,
  modifiedLabel,
  language,
  className,
  onSelection,
}: DiffViewerProps) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const resolvedOriginalLabel = originalLabel ?? t("original")
  const resolvedModifiedLabel = modifiedLabel ?? t("modified")
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [chunks, setChunks] = useState<readonly Chunk[]>([])
  const [languageExtension, setLanguageExtension] = useState<Extension>([])
  const [currentChangeIndex, setCurrentChangeIndex] = useState(-1)
  const onSelectionRef = useRef(onSelection)
  const { zoomLevel } = useZoomLevel()
  const { editorFontStack, editorFontSize, editorLigatures, editorWordWrap } =
    useEditorFont()

  useEffect(() => {
    onSelectionRef.current = onSelection
  }, [onSelection])

  useEffect(() => {
    if (!language || language === "plaintext") return
    let cancelled = false
    const load = () => {
      void loadEditorLanguageById(language)
        .then((extension) => {
          if (!cancelled) setLanguageExtension(extension)
        })
        .catch(() => {
          if (!cancelled) setLanguageExtension([])
        })
    }
    const reload = () => {
      invalidateEditorLanguagePacks()
      load()
    }
    load()
    window.addEventListener("berth:language-packs-changed", reload)
    return () => {
      cancelled = true
      window.removeEventListener("berth:language-packs-changed", reload)
    }
  }, [language])

  const appearance = useMemo(
    () => ({
      fontFamily: editorFontStack,
      fontSize: (editorFontSize * zoomLevel) / 100,
      fontLigatures: editorLigatures,
      wordWrap: editorWordWrap,
    }),
    [
      editorFontStack,
      editorFontSize,
      editorLigatures,
      editorWordWrap,
      zoomLevel,
    ]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const state = EditorState.create({
      doc: modified,
      extensions: [
        ...createBaseExtensions(),
        ...createAppearanceExtensions(appearance),
        ...createCapabilityExtensions({ readOnly: true, search: true }),
        languageExtension,
        unifiedMergeView({
          original,
          highlightChanges: true,
          gutter: true,
          mergeControls: false,
          allowInlineDiffs: true,
          collapseUnchanged: { margin: 3, minSize: 8 },
          diffConfig: { timeout: 750 },
        }),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            onSelectionRef.current?.(selectionOf(update.view))
          }
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    let disposed = false
    const nextChunks = getChunks(view.state)?.chunks ?? []
    queueMicrotask(() => {
      if (disposed) return
      setChunks(nextChunks)
      setCurrentChangeIndex(nextChunks.length ? 0 : -1)
    })
    if (nextChunks[0]) {
      view.dispatch({
        effects: EditorView.scrollIntoView(nextChunks[0].fromB, {
          y: "center",
        }),
      })
    }
    return () => {
      disposed = true
      view.destroy()
      viewRef.current = null
    }
  }, [appearance, languageExtension, modified, original])

  const navigate = (index: number) => {
    const view = viewRef.current
    if (!view || !chunks.length) return
    const next = Math.max(0, Math.min(index, chunks.length - 1))
    const position = Math.min(chunks[next].fromB, view.state.doc.length)
    setCurrentChangeIndex(next)
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    })
    view.focus()
  }
  const stats = changedLines(chunks, original, modified)

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium">
          {resolvedOriginalLabel} → {resolvedModifiedLabel}
        </span>
        {chunks.length > 0 && (
          <>
            <span className="ml-auto shrink-0 font-mono text-green-600 dark:text-green-400">
              +{stats.additions}
            </span>
            <span className="shrink-0 font-mono text-red-600 dark:text-red-400">
              -{stats.deletions}
            </span>
            <span className="hidden shrink-0 sm:inline">
              {t("changeCount", { count: chunks.length })}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={t("prev")}
                onClick={() => navigate(currentChangeIndex - 1)}
                disabled={currentChangeIndex <= 0}
                className="inline-flex items-center rounded border border-border bg-background p-1 disabled:opacity-40"
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <span className="tabular-nums text-[10px]">
                {currentChangeIndex + 1}/{chunks.length}
              </span>
              <button
                type="button"
                aria-label={t("next")}
                onClick={() => navigate(currentChangeIndex + 1)}
                disabled={currentChangeIndex >= chunks.length - 1}
                className="inline-flex items-center rounded border border-border bg-background p-1 disabled:opacity-40"
              >
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>
      <div ref={hostRef} className="cm-diff-host min-h-0 flex-1" />
    </div>
  )
}
