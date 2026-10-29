"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Bot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NoteTree, type NoteTreeGroup } from "@/knowledge/components/note-tree"
import {
  buildLinkTable,
  groupByType,
  mapOutline,
  outlineNoteIds,
  type OutlineGroup,
  type VaultHealth,
} from "@/knowledge/lib/vault"
import type { KnowledgeDocument } from "@/knowledge/model/types"

export const HOME_NOTE_PATH = ".berth/knowledge/地图/首页.md"

function toTreeGroup(group: OutlineGroup): NoteTreeGroup {
  return {
    label: group.label,
    notes: group.notes,
    groups: group.groups.map(toTreeGroup),
  }
}

type PendingKey = "drafts" | "stale" | "unreadSources" | "broken" | "orphans"
const PENDING: PendingKey[] = [
  "drafts",
  "stale",
  "unreadSources",
  "broken",
  "orphans",
]

/**
 * 侧栏整棵树，分组默认折叠：
 * - 首页 + 按 `地图/首页.md` 结构生成的阅读目录；首页没链接到的笔记按类型归入「其他笔记」
 *   （首页缺失时整库按类型分组）；
 * - 「待维护」：需要人或 agent 处理的笔记，按问题分组；
 * - 「引用当前文件」：主区打开代码文件时，`code` 覆盖它的笔记（展开）。
 */
export function VaultTree({
  documents,
  homeContent,
  health,
  mentions,
  activePath,
  onOpen,
}: {
  documents: KnowledgeDocument[]
  /** 首页 markdown；null 表示首页不存在 */
  homeContent: string | null
  health: VaultHealth
  mentions: KnowledgeDocument[]
  activePath: string | null
  onOpen: (document: KnowledgeDocument) => void
}) {
  const t = useTranslations("Knowledge")
  const root = useMemo<NoteTreeGroup>(() => {
    const byType = (notes: KnowledgeDocument[]) =>
      groupByType(notes).map((group) => ({
        label: group.type,
        notes: group.notes,
        groups: [],
        suffix: group.notes.length,
      }))
    const home = documents.find((d) => d.path === HOME_NOTE_PATH)
    const outline =
      home && homeContent !== null
        ? mapOutline(homeContent, buildLinkTable(documents))
        : null
    const listed = outline ? outlineNoteIds(outline) : new Set<string>()
    const rest = documents.filter(
      (d) => !listed.has(d.id) && d.path !== HOME_NOTE_PATH
    )
    const pending = PENDING.filter((key) => health[key].length > 0).map(
      (key) => ({
        label: t(`maintenance.${key}`),
        notes: health[key],
        groups: [],
        suffix: health[key].length,
      })
    )
    const pendingCount = new Set(
      pending.flatMap((group) => group.notes.map((d) => d.id))
    ).size
    const groups: NoteTreeGroup[] = [
      ...(outline ? outline.groups.map(toTreeGroup) : []),
      ...(!outline
        ? byType(documents)
        : rest.length
          ? [
              {
                label: t("outline.others"),
                notes: [],
                groups: byType(rest),
                suffix: rest.length,
              },
            ]
          : []),
      ...(pending.length
        ? [
            {
              label: t("maintenance.title"),
              notes: [],
              groups: pending,
              suffix: pendingCount,
            },
          ]
        : []),
      ...(mentions.length
        ? [
            {
              label: t("current.mentions"),
              notes: mentions,
              groups: [],
              suffix: mentions.length,
              open: true,
            },
          ]
        : []),
    ]
    return {
      label: "",
      notes:
        home && outline
          ? [home, ...outline.notes.filter((d) => d.id !== home.id)]
          : [],
      groups,
    }
  }, [documents, health, homeContent, mentions, t])

  return (
    <NoteTree
      // 结构变化（首页改了分组、待维护出现/清空）时重建展开状态
      key={root.groups.map((g) => g.label).join("|")}
      root={root}
      activePath={activePath}
      onOpen={onOpen}
    />
  )
}

/** 已启用但还没有笔记：交给 Agent 写第一批（笔记都由 Agent 维护）。 */
export function VaultEmpty({
  busy,
  onAskAgent,
}: {
  busy: boolean
  onAskAgent: () => void
}) {
  const t = useTranslations("Knowledge")
  return (
    <div className="space-y-2 px-2.5 py-6 text-center">
      <p className="text-sm font-medium">{t("empty.title")}</p>
      <p className="text-xs text-muted-foreground">{t("empty.hint")}</p>
      <Button size="sm" disabled={busy} onClick={onAskAgent}>
        <Bot className="size-3.5" />
        {t("empty.askAgent")}
      </Button>
    </div>
  )
}
