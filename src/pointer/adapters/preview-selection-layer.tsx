"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { findOwningFolder } from "@/lib/files/file-open-target"
import {
  parseDocumentFrameContextMessage,
  type DocumentFrameContextMessage,
} from "@/lib/document-context/frame-bridge"
import { isHttpDocumentUrl } from "@/lib/web-document"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useDocumentContext } from "@/contexts/document-context"
import type { DocumentContextDocument } from "@/contexts/document-context"

import { bindPdfReadingSelection } from "./pdf-reading-selection"
import { findPdfPageNumber, readDomExcerpt } from "../capture"
import { useOptionalPointer } from "../provider"
import type { SourceIdentity, SourceRef, SourceSpan } from "../types"

/** 合并 frame 上报的源码行标注（"12" 或 "12-30"）为一个行范围。 */
export function sourceLinesSpan(
  anchors: readonly string[] | null | undefined
): SourceSpan | undefined {
  let start = Infinity
  let end = -Infinity
  for (const anchor of anchors ?? []) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(anchor)
    if (!match) continue
    start = Math.min(start, Number(match[1]))
    end = Math.max(end, Number(match[2] ?? match[1]))
  }
  return start >= 1 && end >= start ? { unit: "lines", start, end } : undefined
}

/**
 * DOM / iframe 预览的选区适配：向 pointer 报告出处，并向 document-context
 * 登记当前文档快照（给 get_current_document 用，不投递会话）。
 */
export function PreviewSelectionLayer({
  absolutePath,
  sourceContent,
  fileName,
  documentKind,
  documentId,
  documentUrl,
  enabled = true,
  useRegisteredDocument,
  sourceLines = false,
  children,
  className,
}: {
  absolutePath?: string
  sourceContent?: string | null
  fileName?: string
  documentKind?: string
  documentId?: string | null
  documentUrl?: string | null
  enabled?: boolean
  useRegisteredDocument?: boolean
  /** frame 上报的路径是源码行标注（HTML 预览），出处取行范围。 */
  sourceLines?: boolean
  children: ReactNode
  className?: string
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const { registerDocument } = useDocumentContext()
  const pointer = useOptionalPointer()
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const frameGenerationRef = useRef<string | null>(null)
  const frameContentRef = useRef<string | null>(sourceContent ?? null)

  const documentDescriptor = useCallback(
    (message?: DocumentFrameContextMessage): DocumentContextDocument => {
      const path = absolutePath ?? null
      const messageUrl =
        message && /^https?:\/\//i.test(message.url) ? message.url : null
      const url = documentUrl ?? (path ? null : messageUrl)
      const owning = path ? findOwningFolder(path, allFolders) : null
      return {
        id:
          documentId ??
          (path ? "file:" + path : url ? "url:" + url : undefined),
        kind: documentKind ?? "document",
        title: message?.title ?? fileName ?? path,
        path,
        url,
        displayPath: owning?.relPath ?? path ?? url,
        content: message?.content ?? frameContentRef.current ?? sourceContent,
      }
    },
    [
      absolutePath,
      allFolders,
      documentId,
      documentKind,
      documentUrl,
      fileName,
      sourceContent,
    ]
  )

  const identityFor = useCallback(
    (message?: DocumentFrameContextMessage): SourceIdentity | null => {
      const path = absolutePath?.trim()
      if (path) return { type: "file", path }
      const url = (documentUrl ?? message?.url ?? "").trim()
      if (url && isHttpDocumentUrl(url)) {
        return {
          type: "url",
          url,
          title: message?.title ?? fileName ?? undefined,
        }
      }
      return null
    },
    [absolutePath, documentUrl, fileName]
  )

  // isOwnedFrame 的职责已并入 onMessage：找出与 event.source 匹配的具体
  // iframe（坐标换算需要那一帧的 rect，而不只是「属于本容器」的布尔值）。

  const sourceFor = useCallback(
    (
      text: string,
      message?: DocumentFrameContextMessage,
      page?: number | null
    ): SourceRef | null => {
      const identity = identityFor(message)
      if (!identity) return null
      const span: SourceSpan | undefined =
        page && page > 0
          ? { unit: "page", page }
          : sourceLines
            ? sourceLinesSpan(message?.dataPaths)
            : documentKind === "office" && message?.dataPaths?.length
              ? { unit: "office", paths: message.dataPaths }
              : undefined
      return { identity, span, excerpt: text }
    },
    [documentKind, identityFor, sourceLines]
  )

  const report = useCallback(
    (
      text: string,
      message?: DocumentFrameContextMessage,
      page?: number | null
    ) => {
      if (!enabled || !text.trim()) {
        pointer?.reportSelection(null)
        return
      }
      pointer?.reportSelection({
        excerpt: text,
        editable: false,
        source: sourceFor(text, message, page),
      })
    },
    [enabled, pointer, sourceFor]
  )

  // 只在文档身份变化时作废 generation。不能依赖 `pointer`：它的 value
  // 随菜单开合重建，依赖它会在每次开合后丢掉 iframe 的全部后续选区。
  const reportSelection = pointer?.reportSelection
  useEffect(() => {
    if (!enabled) return
    frameGenerationRef.current = null
    frameContentRef.current = sourceContent ?? null
    reportSelection?.(null)
  }, [
    absolutePath,
    documentId,
    documentUrl,
    enabled,
    reportSelection,
    sourceContent,
  ])

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!enabled) return
      // 只认本容器内 iframe 的消息；坐标换算要用发出消息的那一个。
      const sourceFrame = Array.from(
        container?.querySelectorAll("iframe") ?? []
      ).find((iframe) => iframe.contentWindow === event.source)
      if (!sourceFrame) return
      const message = parseDocumentFrameContextMessage(event.data)
      if (!message) return
      if (message.event === "document") {
        frameGenerationRef.current = message.generation ?? null
        frameContentRef.current = message.content ?? sourceContent ?? null
        pointer?.reportSelection(null)
        registerDocument(documentDescriptor(message))
        return
      }
      if (
        !message.generation ||
        frameGenerationRef.current !== message.generation
      ) {
        return
      }
      const text = message.text?.trim()
      if (!text) return
      if (message.event === "contextmenu") {
        // 沙箱内右键：把 frame 内坐标换算成父页视口坐标，胶囊锚在选区
        // 旁（与 Markdown/PDF 同一 DOM 层），不钉宿主顶边、不强制朝向。
        const rect = sourceFrame.getBoundingClientRect()
        const x =
          message.clientX != null ? rect.left + message.clientX : rect.left
        const y =
          message.clientY != null ? rect.top + message.clientY : rect.top
        report(text, message)
        pointer?.showMenu(
          {
            excerpt: text,
            editable: false,
            source: sourceFor(text, message),
          },
          { x, y }
        )
        return
      }
      report(text, message)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [
    container,
    documentDescriptor,
    enabled,
    pointer,
    registerDocument,
    report,
    sourceContent,
    sourceFor,
  ])

  const syncFromSelection = useCallback(() => {
    if (!enabled) return
    const text = readDomExcerpt(container)
    if (!text.trim()) {
      pointer?.reportSelection(null)
      return
    }
    const domSel = typeof window !== "undefined" ? window.getSelection() : null
    const range = domSel && domSel.rangeCount > 0 ? domSel.getRangeAt(0) : null
    const page =
      typeof window !== "undefined"
        ? findPdfPageNumber(domSel?.anchorNode ?? null, range)
        : null
    report(text, undefined, page)
  }, [container, enabled, pointer, report])

  useEffect(() => {
    if (!enabled) return
    // 拖选时 selectionchange 每帧多次，合并到一帧读一次选区文本。
    let frame = 0
    const onSelectionChange = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(syncFromSelection)
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [enabled, syncFromSelection])

  useEffect(() => {
    if (!enabled || !container) return
    return bindPdfReadingSelection(container)
  }, [container, enabled])

  useEffect(() => {
    if (!enabled) return
    registerDocument(documentDescriptor())
  }, [documentDescriptor, enabled, registerDocument, useRegisteredDocument])

  return (
    <div
      ref={setContainer}
      data-pointer-surface=""
      className={className ?? "relative h-full min-h-0"}
      onMouseUp={
        enabled
          ? () => window.requestAnimationFrame(syncFromSelection)
          : undefined
      }
    >
      {children}
    </div>
  )
}
