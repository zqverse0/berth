"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, ArrowRight, CheckCheck } from "lucide-react"
import type { Extension } from "@codemirror/state"
import { useTranslations } from "next-intl"
import { CodeEditor } from "@/components/editor/code-editor"
import { Button } from "@/components/ui/button"
import { SplitHandle, SplitPane, SplitView } from "@/components/ui/split-view"
import { useZoomLevel, useEditorFont } from "@/hooks/use-appearance"
import {
  invalidateEditorLanguagePacks,
  loadEditorLanguageById,
} from "@/lib/editor/language-packs"
import { cn } from "@/lib/utils"
import { buildResult, computeMergeHunks } from "./merge-diff"

interface ThreePaneMergeEditorProps {
  base: string
  ours: string
  theirs: string
  merged: string
  language?: string
  className?: string
  onContentChange?: (content: string) => void
  onConflictStatusChange?: (hasUnresolved: boolean) => void
}

export function ThreePaneMergeEditor({
  base,
  ours,
  theirs,
  merged,
  language,
  className,
  onContentChange,
  onConflictStatusChange,
}: ThreePaneMergeEditorProps) {
  const t = useTranslations("MergePage")
  const { zoomLevel } = useZoomLevel()
  const [languageExtension, setLanguageExtension] = useState<Extension>([])
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
  const { editorFontStack, editorFontSize, editorLigatures, editorWordWrap } =
    useEditorFont()
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
  const hunks = useMemo(
    () => computeMergeHunks(base, ours, theirs),
    [base, ours, theirs]
  )
  const mergeIdentity = useMemo(() => {
    let hash = 2166136261
    for (const text of [base, ours, theirs]) {
      for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
      }
    }
    return (hash >>> 0).toString(36)
  }, [base, ours, theirs])
  const [applied, setApplied] = useState<Map<string, "left" | "right">>(
    new Map()
  )
  const [result, setResult] = useState(merged || base)

  const unresolved = hunks.filter(
    (hunk) => hunk.type === "conflict" && !applied.has(hunk.id)
  )
  const pending = hunks.filter(
    (hunk) => hunk.type !== "conflict" && !applied.has(hunk.id)
  )

  useEffect(() => {
    onConflictStatusChange?.(unresolved.length > 0)
  }, [onConflictStatusChange, unresolved.length])

  const publishApplied = (nextApplied: Map<string, "left" | "right">) => {
    const nextResult = buildResult(base, hunks, nextApplied)
    setResult(nextResult)
    onContentChange?.(nextResult)
  }

  const apply = (id: string, side: "left" | "right") => {
    const nextApplied = new Map(applied).set(id, side)
    setApplied(nextApplied)
    publishApplied(nextApplied)
  }
  const applyPending = (side: "left" | "right") => {
    const nextApplied = new Map(applied)
    for (const hunk of pending) {
      const available = side === "left" ? hunk.leftHunk : hunk.rightHunk
      if (available) nextApplied.set(hunk.id, side)
    }
    setApplied(nextApplied)
    publishApplied(nextApplied)
  }
  const handleResultChange = (content: string) => {
    setResult(content)
    onContentChange?.(content)
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-center gap-3 border-b bg-muted/50 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t("localVersion")}
        </span>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-xs">
          <span className="font-medium">{t("result")}</span>
          {unresolved.length > 0 && (
            <span className="text-red-500">
              ({t("conflictCount", { count: unresolved.length })})
            </span>
          )}
          {pending.length > 0 && (
            <>
              <Button
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => applyPending("left")}
              >
                <ArrowRight className="mr-0.5 h-2.5 w-2.5" />
                {t("applyLeftNonConflicting")}
              </Button>
              <Button
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => applyPending("right")}
              >
                {t("applyRightNonConflicting")}
                <ArrowLeft className="ml-0.5 h-2.5 w-2.5" />
              </Button>
            </>
          )}
          {!unresolved.length && !pending.length && (
            <CheckCheck className="h-3 w-3 text-green-500" />
          )}
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {t("remoteVersion")}
        </span>
      </div>

      {unresolved.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-b px-2 py-1">
          {unresolved.map((hunk, index) => (
            <div
              key={hunk.id}
              className="flex shrink-0 items-center gap-1 rounded border px-1.5 py-1 text-[10px]"
            >
              <span>#{index + 1}</span>
              <Button
                size="sm"
                className="h-5 px-1"
                onClick={() => apply(hunk.id, "left")}
              >
                {t("acceptLocal")}
              </Button>
              <Button
                size="sm"
                className="h-5 px-1"
                onClick={() => apply(hunk.id, "right")}
              >
                {t("acceptRemote")}
              </Button>
            </div>
          ))}
        </div>
      )}

      <SplitView direction="horizontal" className="min-h-0 flex-1">
        <SplitPane defaultSize={34} minSize={15}>
          <CodeEditor
            documentId={`merge:${mergeIdentity}:ours`}
            value={ours}
            appearance={appearance}
            capabilities={{ readOnly: true }}
            languageExtension={languageExtension}
            preserveState={false}
          />
        </SplitPane>
        <SplitHandle />
        <SplitPane defaultSize={32} minSize={15}>
          <CodeEditor
            documentId={`merge:${mergeIdentity}:result`}
            value={result}
            appearance={appearance}
            onChange={handleResultChange}
            languageExtension={languageExtension}
            preserveState={false}
          />
        </SplitPane>
        <SplitHandle />
        <SplitPane defaultSize={34} minSize={15}>
          <CodeEditor
            documentId={`merge:${mergeIdentity}:theirs`}
            value={theirs}
            appearance={appearance}
            capabilities={{ readOnly: true }}
            languageExtension={languageExtension}
            preserveState={false}
          />
        </SplitPane>
      </SplitView>
    </div>
  )
}
