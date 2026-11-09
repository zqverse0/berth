"use client"

import { useMemo } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ringOfType, type OrbitRing } from "@/knowledge/lib/orbit-layout"
import type { KnowledgeDocument, KnowledgeEdge } from "@/knowledge/model/types"

/** 各层的颜色：星图节点、详情里的圆点同一套。 */
export const RING_COLOR: Record<OrbitRing, string> = {
  map: "var(--chart-1)",
  concept: "var(--chart-5)",
  module: "var(--chart-2)",
  record: "var(--chart-4)",
}

export const noteColor = (document: KnowledgeDocument) =>
  RING_COLOR[ringOfType(document.noteType)]

function NoteRow({
  document,
  onSelect,
}: {
  document: KnowledgeDocument
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(document.id)}
      className="-mx-1.5 flex w-[calc(100%+12px)] items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-foreground hover:bg-accent"
    >
      <i
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: noteColor(document) }}
      />
      <span className="truncate">{document.title}</span>
    </button>
  )
}

/** 选中笔记的详情：类型 / 状态 / 更新时间、摘要、引用的代码、链接到与被引用。 */
export function NoteDetail({
  document,
  documents,
  edges,
  onSelect,
  onOpenNote,
  onOpenCode,
}: {
  document: KnowledgeDocument
  documents: KnowledgeDocument[]
  edges: KnowledgeEdge[]
  onSelect: (id: string) => void
  /** vault 根相对路径 */
  onOpenNote: (path: string) => void
  onOpenCode: (code: string) => void
}) {
  const t = useTranslations("Knowledge")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { outgoing, backlinks } = useMemo(() => {
    const byId = new Map(documents.map((d) => [d.id, d]))
    const pick = (ids: string[]) =>
      [...new Set(ids)].flatMap((id) => {
        const other = byId.get(id)
        return other && other.id !== document.id ? [other] : []
      })
    return {
      outgoing: pick(
        edges.filter((e) => e.source === document.id).map((e) => e.target)
      ),
      backlinks: pick(
        edges.filter((e) => e.target === document.id).map((e) => e.source)
      ),
    }
  }, [document.id, documents, edges])
  const updated = document.modifiedAt
    ? format.relativeTime(new Date(document.modifiedAt * 1000), now)
    : null
  const list = (title: string, notes: KnowledgeDocument[]) =>
    notes.length > 0 && (
      <>
        <h4 className="mt-3.5 mb-1.5 text-[11px] font-medium text-muted-foreground">
          {title} {notes.length}
        </h4>
        {notes.map((other) => (
          <NoteRow key={other.id} document={other} onSelect={onSelect} />
        ))}
      </>
    )
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <i
          className="size-2 rounded-full"
          style={{ background: noteColor(document) }}
        />
        {[document.noteType, document.status, updated]
          .filter(Boolean)
          .join(" · ")}
      </div>
      <h3 className="mt-1 mb-2 text-sm font-semibold">{document.title}</h3>
      <p className="line-clamp-5 text-xs text-muted-foreground">
        {document.excerpt}
      </p>
      {document.code.length > 0 && (
        <>
          <h4 className="mt-3.5 mb-1.5 text-[11px] font-medium text-muted-foreground">
            {t("orbit.code")}
          </h4>
          {document.code.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => onOpenCode(code)}
              className="-mx-1.5 block w-[calc(100%+12px)] truncate rounded px-1.5 py-0.5 text-left font-mono text-xs text-chart-5 hover:bg-accent"
            >
              {code}
            </button>
          ))}
        </>
      )}
      {list(t("relations.outgoing"), outgoing)}
      {list(t("relations.backlinks"), backlinks)}
      <button
        type="button"
        onClick={() => onOpenNote(document.path)}
        className="mt-3.5 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
      >
        {t("orbit.open")}
      </button>
    </div>
  )
}
