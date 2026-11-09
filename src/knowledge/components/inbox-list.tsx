"use client"

import { useTranslations } from "next-intl"
import type { KnowledgeInboxItem } from "@/knowledge/model/types"

const RESULT_KEY = {
  已完成: "done",
  已放弃: "abandoned",
  已放下: "dropped",
} as const

/** 待入库清单：任务、想法归档后进来，等用户说要维护时再处理。空时不占位。 */
export function InboxList({
  items,
  onOpen,
}: {
  items: KnowledgeInboxItem[]
  onOpen: (item: KnowledgeInboxItem) => void
}) {
  const t = useTranslations("Knowledge.inbox")
  if (items.length === 0) return null
  return (
    <details className="mb-1 border-b pb-1">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-muted-foreground">
        {t("title")}
        <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] tabular-nums">
          {items.length}
        </span>
      </summary>
      <ul className="space-y-px">
        {items.map((item) => {
          const result = RESULT_KEY[item.result as keyof typeof RESULT_KEY]
          return (
            <li key={item.path}>
              <button
                type="button"
                title={item.path}
                className="flex w-full min-w-0 items-baseline gap-1.5 rounded px-2.5 py-1 text-left text-xs hover:bg-accent/60"
                onClick={() => onOpen(item)}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {result ? t(`result.${result}`) : item.result}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
