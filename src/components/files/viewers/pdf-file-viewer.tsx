"use client"

import { useCallback, useMemo } from "react"
import dynamic from "next/dynamic"
import { useDocumentContext } from "@/contexts/document-context"
import { splitAbsPath, normalizeAbsPath } from "@/lib/files/file-open-target"
import type { ResourceFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { PreviewSelectionLayer } from "@/components/content-reference/preview-selection-layer"
import { useFileReveal } from "./use-file-reveal"
import { ViewerLoading } from "./viewer-states"

const PdfPreview = dynamic(
  () =>
    import("@/components/files/pdf-preview").then(
      (module) => module.PdfPreview
    ),
  { ssr: false }
)

/** PDF：选区上报、页码定位与给 Agent 的全文都在这里接线。 */
export function PdfFileViewer({
  tab,
  visible,
  active,
}: {
  tab: ResourceFileWorkspaceTab
  visible: boolean
  active: boolean
}) {
  const { registerDocument } = useDocumentContext()
  const pendingPage = useWorkspaceFileStore((state) => {
    const reveal = state.pendingFileReveal
    return reveal &&
      normalizeAbsPath(reveal.path) === normalizeAbsPath(tab.path)
      ? reveal.page
      : null
  })
  useFileReveal({ tab, visible, textBuffer: false, revealLine: null })
  const io = useMemo(() => splitAbsPath(tab.path), [tab.path])
  const revision = tab.preview.revision

  const handleTextContent = useCallback(
    (content: string) => {
      registerDocument({
        id: `file:${tab.path}`,
        kind: "pdf",
        title: tab.title,
        path: tab.path,
        displayPath: tab.path,
        mime: "application/pdf",
        content,
        revision: String(revision),
      })
    },
    [registerDocument, revision, tab.path, tab.title]
  )

  if (!io || tab.preview.kind !== "pdf") {
    return tab.loading ? <ViewerLoading /> : null
  }
  return (
    <PreviewSelectionLayer
      className="h-full min-h-0 w-full"
      absolutePath={tab.path}
      fileName={tab.title}
      documentKind="pdf"
    >
      <PdfPreview
        key={tab.id}
        file={{ rootPath: io.rootPath, path: io.ioPath }}
        sourceRevision={revision}
        onTextContent={visible && active ? handleTextContent : undefined}
        initialPage={pendingPage}
      />
    </PreviewSelectionLayer>
  )
}
