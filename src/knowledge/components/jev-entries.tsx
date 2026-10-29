"use client"

import { useTranslations } from "next-intl"
import { FileText, Undo2 } from "lucide-react"
import type { JevEntry } from "@/knowledge/api/knowledge-client"
import { cn } from "@/lib/utils"

/** `2026-10-14T13:26:00+00:00` → 本地 `10-14 21:26` */
export function entryTime(at: string) {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Jev 写入的条目，新的在前：类别、分数、来源、写到的文件、原文。
 * 给了 `onUndo` / `onMove`（改类，选项来自 `categories`）就能干预；已撤销的灰显。
 */
export function JevEntries({
  entries,
  categories,
  onOpen,
  onUndo,
  onMove,
}: {
  entries: JevEntry[]
  categories?: { id: string; name: string }[]
  onOpen?: (entry: JevEntry) => void
  onUndo?: (entry: JevEntry) => void
  onMove?: (entry: JevEntry, category: string) => void
}) {
  const t = useTranslations("Knowledge.jev")
  return (
    <ul className="space-y-1.5 text-xs">
      {entries.map((entry) => (
        <li
          key={`${entry.id}-${entry.at}`}
          className={cn(
            "rounded border border-border/60 p-2",
            entry.undone && "opacity-50"
          )}
        >
          <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
            <span className="font-medium text-foreground">{entry.name}</span>
            <span>{entry.score.toFixed(2)}</span>
            <span>{entryTime(entry.at)}</span>
            <span className="truncate">{entry.expert}</span>
            <span className="ml-auto shrink-0">
              {t("turn", { turn: entry.turn })}
            </span>
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap">{entry.text}</p>
          <div className="mt-1 flex items-center gap-1 text-muted-foreground">
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded px-1 hover:bg-primary/8 hover:text-foreground disabled:pointer-events-none"
              disabled={!onOpen || entry.undone}
              title={entry.file}
              onClick={() => onOpen?.(entry)}
            >
              <FileText className="size-3 shrink-0" />
              <span className="truncate">
                {entry.undone
                  ? t("undone")
                  : entry.file.split("/").slice(-2).join("/")}
              </span>
            </button>
            {!entry.undone && onMove && categories ? (
              <select
                aria-label={t("move")}
                title={t("move")}
                className="ml-auto h-6 rounded border border-border bg-background px-1"
                value={entry.category}
                onChange={(event) => onMove(entry, event.target.value)}
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            ) : null}
            {!entry.undone && onUndo ? (
              <button
                type="button"
                aria-label={t("undo")}
                title={t("undo")}
                className={cn(
                  "rounded p-1 hover:bg-primary/8 hover:text-foreground",
                  !onMove && "ml-auto"
                )}
                onClick={() => onUndo(entry)}
              >
                <Undo2 className="size-3" />
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
