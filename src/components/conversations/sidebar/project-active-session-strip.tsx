"use client"

import { memo, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { AgentIcon } from "@/components/agent-icon"
import { ColorTerminalIcon } from "@/components/layout/status-bar/status-bar-terminal"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  paneDot,
  paneFolderId,
  useAgentPaneStore,
  useAgentPanesWhere,
  type PaneDot,
} from "@/lib/terminal/agent-panes"
import { tabFromDescriptor } from "@/lib/terminal/create-and-open-primary-terminal"
import { getProjectActiveSessionTabs } from "@/lib/workspace/project-active-sessions"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore, type TerminalTabItemInternal } from "@/stores/tab-store"
import { cn } from "@/lib/utils"
import { StatusDot } from "@/components/ui/status-dot"

export interface ProjectActiveSessionStripProps {
  folderId: number
  /** 图标行左缩进（与项目名对齐）。 */
  indent: string
  /** 竖线所在的轴；给了就画（嵌套 worktree 行）。 */
  railAxis?: string
  className?: string
}

/** One icon-strip button: an open tab or a live terminal without a tab. */
export interface SessionStripEntry {
  /** React key; for tabs this is also the active-state comparison id. */
  id: string
  /** Human label, shown as the tooltip and the accessible name. */
  title: string
  /** Agent icon to show; `null` falls back to the generic terminal icon. */
  agentType: string | null
  /** Whether this entry is the currently active tab. */
  active: boolean
  /** Agent 状态点：琥珀 = 未读的需要关注，绿色脉动 = 工作中。 */
  dot?: PaneDot
  /** Switches to the tab, or opens the terminal in a new tab. */
  onSelect: () => void
}

/** One session icon button; shared by the block strip and the inline strip. */
function SessionIconButton({
  entry,
  className,
}: {
  entry: SessionStripEntry
  className?: string
}) {
  const icon = entry.agentType ? (
    <AgentIcon agentType={entry.agentType} className="size-3.5 shrink-0" />
  ) : (
    <ColorTerminalIcon size={14} className="size-3.5 shrink-0" />
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-active-session-tab-id={entry.id}
          // 项目头整行是拖拽手柄；点图标不应开始拖拽。
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            entry.onSelect()
            // 点的是 Agent / 终端：辅助面板显示终端，不停在项目群组页
            useAppUiStore.getState().showAuxView("terminals")
          }}
          title={entry.title}
          aria-label={entry.title}
          className={cn(
            "relative flex size-6 shrink-0 items-center justify-center rounded-md transition-all duration-150 outline-none",
            "border border-transparent text-muted-foreground hover:border-border/80 hover:bg-sidebar-accent/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            entry.active &&
              "border-primary/50 bg-primary/10 text-primary shadow-2xs ring-1 ring-primary/40 font-medium",
            className
          )}
        >
          {icon}
          {entry.dot ? (
            <StatusDot
              kind={entry.dot}
              className="-right-0.5 -top-0.5 ring-2 ring-sidebar"
            />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="max-w-[260px] whitespace-pre-line break-words text-xs font-normal"
      >
        {entry.title}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * GUI 未自行打开的运行中终端图标条——包括 CLI 启动的 Agent，以及项目 ID 已
 * 不在项目列表中的历史会话。选择条目会在 Tab 中打开终端。
 */
export const DetachedTerminalStrip = memo(function DetachedTerminalStrip({
  entries,
  className,
  ariaLabel = "Detached terminals",
}: {
  entries: readonly SessionStripEntry[]
  className?: string
  /** 由调用方注入双语无障碍名称，避免表现层猜测语言。 */
  ariaLabel?: string
}) {
  if (entries.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 overflow-x-auto py-1 pr-2 scrollbar-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
      style={{
        paddingLeft: "calc(var(--conv-rail-axis, 0.875rem) + 1.125rem)",
      }}
      role="toolbar"
      aria-label={ariaLabel}
    >
      <TooltipProvider delayDuration={200}>
        {entries.map((entry) => (
          <SessionIconButton key={entry.id} entry={entry} />
        ))}
      </TooltipProvider>
    </div>
  )
})

/**
 * 项目下方的会话图标行：这个项目（或 worktree）里的全部 Agent / 终端，不折叠，
 * 点图标直接切到对应会话。
 */
export const ProjectActiveSessionStrip = memo(
  function ProjectActiveSessionStrip({
    folderId,
    indent,
    railAxis,
    className,
  }: ProjectActiveSessionStripProps) {
    const rail = railAxis != null
    // 每个项目行只订阅自己的 tab / pane：切换项目、别处开关 tab 时，其余几十行不重渲染。
    const folders = useAppWorkspaceStore((s) => s.allFolders)
    const panes = useAgentPanesWhere(
      (row) => paneFolderId(row.descriptor, folders) === folderId
    )
    const sessionTabs = useTabStore(
      useShallow((s) => getProjectActiveSessionTabs(s.rawTabs, folderId))
    )
    const paneTabs = useTabStore(
      useShallow((s) =>
        s.rawTabs.filter(
          (tab): tab is TerminalTabItemInternal =>
            tab.kind === "terminal" &&
            panes.some((row) => row.descriptor.terminalId === tab.terminalId)
        )
      )
    )
    const activeTabId = useTabStore((s) =>
      sessionTabs.some((tab) => tab.id === s.activeTabId) ||
      paneTabs.some((tab) => tab.id === s.activeTabId)
        ? s.activeTabId
        : null
    )
    const switchTab = useTabStore((s) => s.switchTab)
    const openTerminalTab = useTabStore((s) => s.openTerminalTab)
    const seen = useAgentPaneStore((s) => s.seen)

    // 终端以 termd 清单为准，按所在目录挂到最深的项目 / worktree 行；
    // 清单里没有的终端 tab（首轮未到）仍按 tab 显示。
    const entries = useMemo<SessionStripEntry[]>(() => {
      const listed = new Set(panes.map((row) => row.descriptor.terminalId))
      const tabEntries = sessionTabs
        .filter((tab) => tab.kind !== "terminal" || !listed.has(tab.terminalId))
        .map((tab) => {
          const isTerminal = tab.kind === "terminal"
          return {
            id: tab.id,
            title:
              tab.title?.trim() || (isTerminal ? "Terminal" : "Conversation"),
            agentType: tab.agentType || null,
            active: tab.id === activeTabId,
            onSelect: () => switchTab(tab.id),
          }
        })
      const paneEntries = panes.map((row) => {
        const { descriptor } = row
        const tab = paneTabs.find(
          (item) => item.terminalId === descriptor.terminalId
        )
        const title = tab?.title?.trim() || descriptor.title || "Terminal"
        const notification =
          row.state === "attention"
            ? descriptor.agentSignal?.notification
            : null
        return {
          id: tab?.id ?? `terminal:${descriptor.terminalId}`,
          title: notification ? `${title}\n${notification}` : title,
          agentType: descriptor.agentId ?? null,
          active: tab != null && tab.id === activeTabId,
          dot: descriptor.agentId ? paneDot(row, seen) : null,
          onSelect: () =>
            tab
              ? switchTab(tab.id)
              : openTerminalTab(tabFromDescriptor(descriptor), true),
        }
      })
      return [...tabEntries, ...paneEntries]
    }, [
      activeTabId,
      openTerminalTab,
      paneTabs,
      panes,
      seen,
      sessionTabs,
      switchTab,
    ])

    if (entries.length === 0) {
      return null
    }

    return (
      <div
        className={cn(
          "relative flex flex-wrap items-center gap-0.5 pb-1 pr-2",
          className
        )}
        style={{ paddingLeft: indent }}
        role="toolbar"
        aria-label="Active sessions"
      >
        {/* 嵌套行的图标行同样画连接线，worktree 之间的竖线不断开。 */}
        {rail ? (
          <span
            aria-hidden
            className="pointer-events-none absolute z-0 bg-sidebar-border"
            style={{
              top: "-0.0625rem",
              bottom: "-0.0625rem",
              left: railAxis,
              width: "0.125rem",
              transform: "translateX(-50%)",
            }}
          />
        ) : null}
        <TooltipProvider delayDuration={200}>
          {entries.map((entry) => (
            <SessionIconButton key={entry.id} entry={entry} />
          ))}
        </TooltipProvider>
      </div>
    )
  }
)
