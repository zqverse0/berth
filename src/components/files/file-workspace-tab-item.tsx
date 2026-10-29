"use client"

import { memo, useEffect } from "react"
import { GitCompare } from "lucide-react"
import { useTranslations } from "next-intl"
import type { FileWorkspaceTab } from "@/hooks/workspace/use-workspace-runtime"
import type { WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"
import { cn } from "@/lib/utils"
import { getFileIconConfig } from "@/components/ai-elements/file-tree-icons"
import { isTextFileTab } from "@/lib/files/file-workspace-tab"
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { WorkspaceTabShell } from "@/components/tabs/workspace-tab-shell"
import { pickStatusDot } from "@/components/ui/status-dot"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

interface FileWorkspaceTabItemProps {
  tab: FileWorkspaceTab
  active: boolean
  adjacentActive?: "before" | "after"
  onSwitch: (ref: WorkspaceTabRef) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (ref: WorkspaceTabRef) => void
  hasTabsToRight?: boolean
  /** Toggle global (all-projects) status for this tab via the pin menu. */
  onPin: (tabId: string) => void
  /** Layout ref: drag across tab groups, and the argument of every callback. */
  dragRef: WorkspaceTabRef
  /** Tab-group move offered in the menu: split right, or back to the left group. */
  groupMove?: "files-split" | "files"
  onMoveToGroup: (ref: WorkspaceTabRef, pane: "files-split" | "files") => void
}

export const FileWorkspaceTabItem = memo(function FileWorkspaceTabItem({
  tab,
  active,
  adjacentActive,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseToRight,
  hasTabsToRight = false,
  onPin,
  dragRef,
  groupMove,
  onMoveToGroup,
}: FileWorkspaceTabItemProps) {
  const t = useTranslations("Folder.tabs")
  const tFile = useTranslations("Folder.fileWorkspace")
  const isDiff = tab.kind === "diff" || tab.kind === "rich-diff"
  const isDirty = isTextFileTab(tab) && tab.isDirty
  const isGlobal = tab.lifetime === "global"
  const unseen = useWorkspaceFileStore((state) =>
    state.unseenFileTabIds.has(tab.id)
  )
  // 激活一次即算看过。
  useEffect(() => {
    if (active && unseen)
      useWorkspaceFileStore.getState().setFileTabUnseen(tab.id, false)
  }, [active, unseen, tab.id])
  const fileConfig = getFileIconConfig(tab.title)
  const FileIcon = fileConfig.icon

  return (
    <WorkspaceTabShell
      dragRef={dragRef}
      dataAttributes={{ "data-file-tab-id": tab.id }}
      active={active}
      adjacentActive={adjacentActive}
      status={pickStatusDot(unseen && "new", isGlobal && "pinned")}
      icon={
        isDiff ? (
          <GitCompare className="h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-400" />
        ) : (
          <FileIcon
            className={cn("h-3.5 w-3.5 shrink-0", fileConfig.colorClass)}
          />
        )
      }
      label={`${tab.title}${isDirty ? " *" : ""}`}
      title={tab.description ?? tab.title}
      closeLabel={tFile("closeFileTab")}
      onSelect={() => onSwitch(dragRef)}
      onClose={() => onClose(tab.id)}
      onDoubleClick={() => onPin(tab.id)}
      menu={
        <>
          <ContextMenuItem onSelect={() => onClose(tab.id)}>
            {tFile("close")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCloseOthers(tab.id)}>
            {tFile("closeOthers")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onCloseToRight(dragRef)}
            disabled={!hasTabsToRight}
          >
            {t("closeToRight")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onPin(tab.id)}>
            {isGlobal ? t("unpinGlobal") : t("pinGlobal")}
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
