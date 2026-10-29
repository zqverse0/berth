"use client"

/**
 * 主区 markdown live preview 对 vault 笔记的增强：属性栏与关系区（双链在编辑器扩展里）。
 * 只在 vault 笔记（`isVaultNotePath`）上启用，其他 markdown 不经过这里。
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { setKnowledgeNoteStatus } from "@/knowledge/api/knowledge-client"
import { groupByType, noteLinks } from "@/knowledge/lib/vault"
import type {
  KnowledgeDocument,
  KnowledgeSnapshot,
} from "@/knowledge/model/types"
import { useAppUiStore } from "@/stores/app-ui-store"
import { cn } from "@/lib/utils"

export function openCodePath(
  folderPath: string,
  code: string,
  openFilePreview: (path: string) => void
) {
  if (code.endsWith("/")) {
    useAppUiStore.getState().revealInFileTree(code.replace(/\/+$/, ""))
    return
  }
  openFilePreview(`${folderPath.replace(/[\\/]+$/, "")}/${code}`)
}

/** 笔记顶部属性栏；草稿可直接确认（改写 `status:` 后重载主区文件），不要的草稿直接删除。 */
export function VaultPropertyBar({
  folderId,
  document,
  folderPath,
  openFilePreview,
}: {
  folderId: number
  document: KnowledgeDocument
  folderPath: string
  openFilePreview: (path: string) => void
}) {
  const t = useTranslations("Knowledge")
  const { reloadActiveFile } = useWorkspaceRuntimeActions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await setKnowledgeNoteStatus(folderId, document.path, "已确认")
      await reloadActiveFile()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-b pb-2 text-xs text-muted-foreground">
      <span>{document.noteType}</span>
      <span aria-hidden>·</span>
      <span
        className={cn(document.status === "草稿" && "text-amber-600")}
        title={t("status")}
      >
        {document.status}
      </span>
      {document.verifiedAt ? (
        <span className="font-mono" title={t("current.verifiedAt")}>
          @{document.verifiedAt}
        </span>
      ) : null}
      {document.code.map((code) => (
        <button
          key={code}
          type="button"
          className="rounded bg-muted px-1.5 font-mono text-[11px] hover:bg-accent hover:text-foreground"
          onClick={() => openCodePath(folderPath, code, openFilePreview)}
        >
          {code}
        </button>
      ))}
      {document.status === "草稿" ? (
        <Button
          size="xs"
          className="ml-auto"
          disabled={busy}
          onClick={() => void confirm()}
        >
          <Check className="size-3.5" />
          {t("current.confirm")}
        </Button>
      ) : null}
      {error ? <span className="w-full text-destructive">{error}</span> : null}
    </div>
  )
}

/** 笔记底部的关系：链接到 / 被引用，按类型分组；替代图谱。 */
export function VaultRelations({
  snapshot,
  document,
  folderPath,
  openFilePreview,
}: {
  snapshot: KnowledgeSnapshot
  document: KnowledgeDocument
  folderPath: string
  openFilePreview: (path: string) => void
}) {
  const t = useTranslations("Knowledge")
  const links = useMemo(
    () => noteLinks(snapshot, document.id),
    [document.id, snapshot]
  )
  const open = (note: KnowledgeDocument) =>
    openFilePreview(`${folderPath.replace(/[\\/]+$/, "")}/${note.path}`)
  const sections = [
    {
      label: t("relations.outgoing"),
      rows: [
        ...groupByType(links.outgoing),
        ...(links.broken.length
          ? [{ type: t("relations.missing"), notes: [], missing: links.broken }]
          : []),
      ],
    },
    { label: t("relations.backlinks"), rows: groupByType(links.backlinks) },
  ].filter((section) => section.rows.length > 0)
  if (sections.length === 0) return null
  return (
    <section
      aria-label={t("relations.title")}
      className="mt-8 border-t pt-3 text-sm"
    >
      <dl className="grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1.5">
        {sections.flatMap(({ label, rows }) =>
          rows.map((row: RelationRow, index) => (
            <div key={`${label}:${row.type}`} className="contents">
              <dt className="text-xs text-muted-foreground">
                {index === 0 ? label : ""}
              </dt>
              <dt className="text-xs text-muted-foreground">{row.type}</dt>
              <dd className="flex flex-wrap gap-x-3 gap-y-0.5">
                {row.notes.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => open(note)}
                  >
                    {note.title}
                  </button>
                ))}
                {row.missing?.map((title) => (
                  <span
                    key={title}
                    title={t("missingNote", { title })}
                    className="border-b border-dashed border-muted-foreground/60 text-muted-foreground"
                  >
                    {title}
                  </span>
                ))}
              </dd>
            </div>
          ))
        )}
      </dl>
    </section>
  )
}

interface RelationRow {
  type: string
  notes: KnowledgeDocument[]
  missing?: string[]
}
