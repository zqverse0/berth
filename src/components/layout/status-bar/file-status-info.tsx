"use client"

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { editorDocumentRegistry } from "@/lib/editor/document-registry"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"

const subscribe = (listener: () => void) =>
  editorDocumentRegistry.subscribe(listener)

/** 光标摘要编成字符串，快照稳定，只有位置真变了才重渲染。 */
function cursorSnapshot(documentId: string): string {
  const state = editorDocumentRegistry.get(documentId)?.state
  if (!state) return ""
  const { head, from, to } = state.selection.main
  const line = state.doc.lineAt(head)
  return `${line.number}:${head - line.from + 1}:${to - from}`
}

const LINE_ENDING_LABEL = { lf: "LF", crlf: "CRLF", mixed: "Mixed" } as const

/** 文本文件 tab 的状态：保存状态 / 只读、光标位置、语言与换行符。 */
export function FileStatusInfo({ tab }: { tab: TextFileWorkspaceTab }) {
  const t = useTranslations("Folder.statusBar.file")
  // documentId 与 text-file-viewer 传给 CodeEditor 的一致
  const documentId = `file-tab:${tab.id}`
  const cursor = useSyncExternalStore(
    subscribe,
    () => cursorSnapshot(documentId),
    () => ""
  )
  const [line, col, selected] = cursor.split(":").map(Number)

  const saveLabel =
    tab.saveState === "error"
      ? t("saveFailed")
      : tab.saveState === "saving"
        ? t("saving")
        : tab.isDirty
          ? t("unsaved")
          : tab.readonly
            ? t("readonly")
            : null

  return (
    <div className="flex shrink-0 items-center gap-3 font-mono text-[11px] text-muted-foreground">
      {saveLabel ? (
        <span
          className={cn(
            tab.saveState === "error" && "text-destructive",
            tab.isDirty && tab.saveState !== "error" && "text-amber-500"
          )}
          title={tab.saveError ?? undefined}
        >
          {saveLabel}
        </span>
      ) : null}
      {cursor ? (
        <span>
          {t("cursor", { line, col })}
          {selected > 0 ? ` ${t("selected", { count: selected })}` : ""}
        </span>
      ) : null}
      <span>{tab.language}</span>
      {tab.lineEnding !== "none" ? (
        <span className={cn(tab.lineEnding !== "lf" && "text-amber-500")}>
          {LINE_ENDING_LABEL[tab.lineEnding]}
        </span>
      ) : null}
    </div>
  )
}
