"use client"

import { memo, useCallback } from "react"
import { Bot } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { AgentIcon } from "@/components/agent-icon"
import { ColorTerminalIcon } from "@/components/layout/status-bar/status-bar-terminal"
import { agentTypeForTool } from "@/hooks/use-agent-profiles"
import { paneDot, useAgentPaneStore } from "@/lib/terminal/agent-panes"
import { pickStatusDot } from "@/components/ui/status-dot"
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { isConversationTab, isTerminalTab } from "@/lib/workspace/primary-tabs"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import { terminateTerminalSession } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { copyTextToClipboard } from "@/lib/utils"
import { fetchTerminalHandle } from "@/lib/terminal/terminal-handle"
import { WorkspaceTabShell } from "@/components/tabs/workspace-tab-shell"
import type { WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"

interface TabItemProps {
  tab: TabItemData
  isActive: boolean
  adjacentActive?: "before" | "after"
  folderName: string | null
  folderBranch: string | null
  onSwitch: (ref: WorkspaceTabRef) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (ref: WorkspaceTabRef) => void
  hasTabsToRight?: boolean
  onPin: (tabId: string) => void
  /** Layout ref: drag across tab groups, and the argument of every callback. */
  dragRef: WorkspaceTabRef
  /** Tab-group move offered in the menu: split right, or back to the left group. */
  groupMove?: "files-split" | "files"
  onMoveToGroup: (ref: WorkspaceTabRef, pane: "files-split" | "files") => void
}

export const TabItem = memo(function TabItem({
  tab,
  isActive,
  adjacentActive,
  folderName,
  folderBranch,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseToRight,
  hasTabsToRight = false,
  onPin,
  dragRef,
  groupMove,
  onMoveToGroup,
}: TabItemProps) {
  const t = useTranslations("Folder.tabs")
  const tTerminal = useTranslations("Folder.terminal")
  const resolvedFolderName =
    folderName ??
    (tab.folderId != null
      ? String(tab.folderId)
      : isTerminalTab(tab)
        ? (tab.detachedFolderLabel ?? tab.initialCwd)
        : "")
  const tooltip = folderBranch
    ? `${resolvedFolderName} · ${folderBranch}  —  ${tab.title}`
    : resolvedFolderName
      ? `${resolvedFolderName}  —  ${tab.title}`
      : tab.title
  const closeAriaLabel = isTerminalTab(tab)
    ? t("closeTerminalTab")
    : t("closeConversationTab")
  // 终端 tab 以 termd 实时识别的 Agent 为准：手动启动的也有图标，退出后回到终端
  // 图标；清单还没有这一行（undefined）时才用 tab 记下的 agentType。
  const liveAgentId = useAgentPaneStore((state) =>
    isTerminalTab(tab)
      ? state.rows.find((row) => row.descriptor.terminalId === tab.terminalId)
          ?.descriptor.agentId
      : undefined
  )
  // 与侧栏会话图标同一来源：琥珀 = 未读的需要关注，绿色闪烁 = 工作中。
  const paneStatus = useAgentPaneStore((state) => {
    if (!isTerminalTab(tab)) return null
    const row = state.rows.find(
      (candidate) => candidate.descriptor.terminalId === tab.terminalId
    )
    return row?.descriptor.agentId ? paneDot(row, state.seen) : null
  })
  const resolvedAgentType =
    liveAgentId !== undefined
      ? agentTypeForTool(liveAgentId)
      : ("agentType" in tab && tab.agentType) || null
  const isAgentTab = isConversationTab(tab) || Boolean(resolvedAgentType)
  const isIconOnlyTab = isAgentTab || isTerminalTab(tab)

  const handleClose = useCallback(() => {
    if (isTerminalTab(tab)) {
      void terminateTerminalSession(tab.terminalId).catch((err) => {
        toast.error(toErrorMessage(err) || tTerminal("actionFailed"))
      })
    }
    onClose(tab.id)
  }, [onClose, tab, tTerminal])

  // 复制 `项目:编号`，给 Agent 用 `berth terminal -t` 精准定位这个终端
  const handleCopyHandle = useCallback(async () => {
    if (!isTerminalTab(tab)) return
    try {
      const handle = await fetchTerminalHandle(tab.terminalId)
      if (handle && (await copyTextToClipboard(handle))) {
        toast.success(tTerminal("handleCopied", { handle }))
        return
      }
    } catch (err) {
      toast.error(toErrorMessage(err) || tTerminal("actionFailed"))
      return
    }
    toast.error(tTerminal("actionFailed"))
  }, [tab, tTerminal])

  const icon = resolvedAgentType ? (
    <AgentIcon agentType={resolvedAgentType} className="size-5 shrink-0" />
  ) : isTerminalTab(tab) ? (
    <ColorTerminalIcon className="size-5 shrink-0" size={20} />
  ) : (
    <Bot className="size-5 shrink-0 text-muted-foreground" aria-hidden />
  )

  return (
    <WorkspaceTabShell
      dragRef={dragRef}
      dataAttributes={{ "data-tab-id": tab.id }}
      active={isActive}
      adjacentActive={adjacentActive}
      compact={isIconOnlyTab}
      status={pickStatusDot(paneStatus, tab.isPinned && "pinned")}
      icon={icon}
      label={tab.title}
      title={tooltip}
      ariaLabel={tab.title}
      closeLabel={closeAriaLabel}
      onSelect={() => onSwitch(dragRef)}
      onClose={handleClose}
      // Double-click toggles pin: pin = global (visible in every project scope).
      onDoubleClick={() => onPin(tab.id)}
      menu={
        <>
          <ContextMenuItem onSelect={handleClose}>
            {isTerminalTab(tab) ? tTerminal("closeTabDetach") : t("close")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCloseOthers(tab.id)}>
            {t("closeOthers")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onCloseToRight(dragRef)}
            disabled={!hasTabsToRight}
          >
            {t("closeToRight")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {isTerminalTab(tab) && (
            <ContextMenuItem onSelect={() => void handleCopyHandle()}>
              {tTerminal("copyHandle")}
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => onPin(tab.id)}>
            {tab.isPinned ? t("unpinGlobal") : t("pinGlobal")}
          </ContextMenuItem>
          {groupMove && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => onMoveToGroup(dragRef, groupMove)}
              >
                {groupMove === "files-split"
                  ? t("splitRight")
                  : t("moveToLeftGroup")}
              </ContextMenuItem>
            </>
          )}
        </>
      }
    />
  )
})
