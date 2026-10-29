"use client"

import { BellRing } from "lucide-react"
import { useTranslations } from "next-intl"
import { useSidebarViewStore } from "@/components/layout/sidebar/views"
import { useAttentionCount } from "@/lib/terminal/agent-panes"
import { useAppUiStore } from "@/stores/app-ui-store"

/** 全部项目未读「需要关注」的 Agent 数；点击打开项目视图（行上有状态点），为 0 时不渲染。 */
export function StatusBarAttention() {
  const t = useTranslations("BerthTasks.panes")
  const count = useAttentionCount()
  if (count === 0) return null
  const label = t("attentionCount", { count })
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-1 text-amber-600 transition-colors hover:text-foreground dark:text-amber-400"
      title={label}
      aria-label={label}
      onClick={() => {
        useSidebarViewStore.getState().setView("projects")
        const ui = useAppUiStore.getState()
        if (!ui.sidebarOpen) ui.toggleSidebar()
      }}
    >
      <BellRing className="h-3 w-3" />
      <span className="tabular-nums">{count}</span>
    </button>
  )
}
