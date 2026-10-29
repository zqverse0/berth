"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Archive, ArchiveRestore, MessagesSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  OPEN_IDEA_STATUSES as OPEN_STATUSES,
  type Idea,
} from "@/knowledge/model/types"
import { cn } from "@/lib/utils"

/** `2026-10-11-191324` → `10-11 19:13` */
function ideaTime(id: string) {
  const match = /^\d{4}-(\d{2})-(\d{2})-(\d{2})(\d{2})/.exec(id)
  return match ? `${match[1]}-${match[2]} ${match[3]}:${match[4]}` : id
}

/**
 * 「想法」视图（参考 Memos）：顶部随手记，下面时间线（新的在前）。
 * 每条一个文件；讨论与结论由 Agent 追加进文件，这里只显示用户原话。
 */
export function IdeaStream({
  ideas,
  busy,
  onAdd,
  onOpen,
  onDiscuss,
  onDrop,
  onRestore,
}: {
  ideas: Idea[]
  busy: boolean
  /** 保存成功返回 true，输入框随之清空 */
  onAdd: (text: string) => Promise<boolean>
  onOpen: (idea: Idea) => void
  onDiscuss: (idea: Idea) => void
  onDrop: (idea: Idea) => void
  /** 已放下的想法改回待讨论 */
  onRestore: (idea: Idea) => void
}) {
  const t = useTranslations("Knowledge.ideas")
  const [draft, setDraft] = useState("")
  const [showArchived, setShowArchived] = useState(false)
  const archived = ideas.filter((idea) => !OPEN_STATUSES.has(idea.status))
  const visible = showArchived
    ? ideas
    : ideas.filter((idea) => OPEN_STATUSES.has(idea.status))

  const save = async () => {
    if (!draft.trim() || busy) return
    if (await onAdd(draft)) setDraft("")
  }

  return (
    <div className="space-y-2 px-2 py-1.5">
      <div className="rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              void save()
            }
          }}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          className="min-h-16 resize-none border-0 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="text-[11px] text-muted-foreground">
            {t("saveHint")}
          </span>
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy || !draft.trim()}
            onClick={() => void save()}
          >
            {t("save")}
          </Button>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((idea) => (
            <li
              key={idea.id}
              className={cn(
                "group rounded-md border px-2.5 py-2",
                !OPEN_STATUSES.has(idea.status) && "opacity-70"
              )}
            >
              <button
                type="button"
                className="line-clamp-6 w-full whitespace-pre-wrap break-words text-left text-sm"
                onClick={() => onOpen(idea)}
              >
                {idea.text}
              </button>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>{ideaTime(idea.id)}</span>
                <span className="rounded bg-muted px-1">
                  {t(`status.${idea.status}`)}
                </span>
                <span className="flex-1" />
                {OPEN_STATUSES.has(idea.status) ? (
                  <>
                    <button
                      type="button"
                      title={t("discuss")}
                      aria-label={t("discuss")}
                      disabled={busy}
                      className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                      onClick={() => onDiscuss(idea)}
                    >
                      <MessagesSquare className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("drop")}
                      aria-label={t("drop")}
                      disabled={busy}
                      className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                      onClick={() => onDrop(idea)}
                    >
                      <Archive className="size-3.5" />
                    </button>
                  </>
                ) : idea.status === "已放下" ? (
                  <button
                    type="button"
                    title={t("restore")}
                    aria-label={t("restore")}
                    disabled={busy}
                    className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                    onClick={() => onRestore(idea)}
                  >
                    <ArchiveRestore className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 ? (
        <button
          type="button"
          className="w-full py-1 text-center text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setShowArchived(!showArchived)}
        >
          {showArchived
            ? t("hideArchived")
            : t("showArchived", { count: archived.length })}
        </button>
      ) : null}
    </div>
  )
}
