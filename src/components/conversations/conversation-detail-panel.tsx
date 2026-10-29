"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { cn } from "@/lib/utils"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import { sortFolderTabs, tabsForFolderScope } from "@/lib/workspace/tab-scope"
import { TerminalView } from "@/components/terminal/terminal-view"
import { createAndOpenPrimaryTerminalDetailed } from "@/lib/terminal/create-and-open-primary-terminal"
import { handleTerminalExit } from "@/lib/terminal/terminal-exit-cleanup"
import { removeTerminalRecordIdempotent } from "@/lib/terminal/terminal-record-cleanup"
import { SessionTabView } from "@/sessions/components/session-tab-view"
import { workspaceTabRefEqual } from "@/lib/workspace/workspace-pane-model"
import type {
  WorkspacePane,
  WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"

/**
 * Renders primary tabs (terminals, conversations). With `pane`, only the tabs
 * placed in that tab group; without it (mobile), every pane's tabs.
 */
export function ConversationDetailPanel({
  pane: hostPane,
}: { pane?: WorkspacePane } = {}) {
  const tTerminal = useTranslations("Folder.terminal")
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const allTabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  const { activeWorkspaceTab, activeTabByPane, paneForTab } =
    useWorkspaceLayoutProjection()
  // Moving a tab to another group remounts its view there; terminals repaint
  // from the runtime snapshot, so nothing is lost.
  const tabs = useMemo(
    () =>
      hostPane
        ? allTabs.filter(
            (tab) =>
              paneForTab({ kind: "primary", id: tab.id, type: tab.kind }) ===
              hostPane
          )
        : allTabs,
    [allTabs, hostPane, paneForTab]
  )
  const visibleTabs = useMemo(
    () => sortFolderTabs(tabsForFolderScope(tabs, activeFolderId)),
    [tabs, activeFolderId]
  )
  const selectWorkspaceTab = useWorkspaceLayoutStore(
    (state) => state.selectWorkspaceTab
  )
  const visibleTabIds = useMemo(
    () => new Set(visibleTabs.map((tab) => tab.id)),
    [visibleTabs]
  )
  // Each pane shows only its active tab; primary ones render here.
  const paneVisibleTabIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tab of Object.values(activeTabByPane)) {
      if (tab?.kind === "primary") ids.add(tab.id)
    }
    return ids
  }, [activeTabByPane])
  const { closeTab } = useTabActions()
  const [warmedTerminalIds, setWarmedTerminalIds] = useState(
    () => new Set<string>()
  )

  useEffect(() => {
    const liveIds = new Set(tabs.filter(isTerminalTab).map((t) => t.terminalId))
    const activeTabRow = tabs.find((t) => t.id === activeTabId)
    /* eslint-disable react-hooks/set-state-in-effect */
    setWarmedTerminalIds((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (liveIds.has(id)) next.add(id)
        else changed = true
      }
      if (activeTabRow && isTerminalTab(activeTabRow)) {
        if (!next.has(activeTabRow.terminalId)) {
          next.add(activeTabRow.terminalId)
          changed = true
        }
      }
      for (const tab of tabs) {
        if (
          paneVisibleTabIds.has(tab.id) &&
          isTerminalTab(tab) &&
          !next.has(tab.terminalId)
        ) {
          next.add(tab.terminalId)
          changed = true
        }
      }
      return changed ? next : prev
    })
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [tabs, activeTabId, paneVisibleTabIds])

  // Tabs of other projects still render (hidden) so warmed terminals stay
  // mounted when the active project has no tab in this pane.
  if (tabs.length === 0) return null

  const tabElements = tabs.map((tab) => {
    const inScope = visibleTabIds.has(tab.id)
    const tabRef: WorkspaceTabRef = {
      kind: "primary",
      id: tab.id,
      type: tab.kind,
    }
    const pane = paneForTab(tabRef)
    const paneVisible = inScope && paneVisibleTabIds.has(tab.id)
    const active = inScope && workspaceTabRefEqual(activeWorkspaceTab, tabRef)
    const folderPath =
      tab.folderId != null
        ? allFolders.find((f) => f.id === tab.folderId)?.path
        : undefined
    const view = isTerminalTab(tab) ? (
      active || paneVisible || warmedTerminalIds.has(tab.terminalId) ? (
        <TerminalView
          terminalId={tab.terminalId}
          isActive={active}
          isVisible={paneVisible}
          onProcessExited={(terminalId, exitCode) =>
            handleTerminalExit(
              terminalId,
              exitCode,
              (code) => tTerminal("exitedWithCode", { name: tab.title, code }),
              removeTerminalRecordIdempotent
            )
          }
          onReopen={async () => {
            const cwd = tab.lastKnownCwd || tab.initialCwd || folderPath
            // 独立终端没有项目归属，重开时仍沿用 null，不按当前项目猜归属。
            if (!cwd) return
            const result = await createAndOpenPrimaryTerminalDetailed({
              cwd,
              folderId: tab.folderId,
              title: tab.title,
              shell: tab.shell,
              launchSource: { kind: "shell" },
            })
            if (result.terminalId) closeTab(tab.id)
          }}
        />
      ) : null
    ) : paneVisible ? (
      <SessionTabView
        tabId={tab.id}
        conversationId={tab.conversationId}
        agentType={tab.agentType}
        workingDir={tab.workingDir ?? folderPath}
        isActive={active}
      />
    ) : null

    return (
      <div
        key={tab.id}
        data-workspace-primary-pane={pane}
        className={cn(
          "absolute inset-0 overflow-hidden",
          paneVisible
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        )}
        aria-hidden={!paneVisible}
        inert={!paneVisible || undefined}
        onPointerDownCapture={
          paneVisible && !active ? () => selectWorkspaceTab(tabRef) : undefined
        }
      >
        {view}
      </div>
    )
  })

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="relative h-full min-h-0">{tabElements}</div>
      </div>
    </div>
  )
}
