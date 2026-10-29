"use client"

import { useCallback } from "react"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { useWorkbenchLayout } from "@/hooks/workspace/use-workbench-layout"
import {
  SETTINGS_GLOBAL_TAB_ID,
  type SettingsPageId,
} from "@/lib/workspace/settings-tab"
import { pageOfPanel, type WorkbenchPanelId } from "@/lib/workbench"

export function useOpenWorkbenchPanel() {
  const { selectPanel } = useWorkbenchLayout()
  const openGlobalTab = useWorkspaceLayoutStore((state) => state.openGlobalTab)

  const openWorkbenchPanel = useCallback(
    (panelId: WorkbenchPanelId) => {
      const pageId = pageOfPanel(panelId)
      selectPanel(pageId, panelId)
      if (pageId === "settings") openGlobalTab(SETTINGS_GLOBAL_TAB_ID)
    },
    [openGlobalTab, selectPanel]
  )

  const openSettings = useCallback(
    (page?: SettingsPageId | null) => {
      if (page == null) {
        openGlobalTab(SETTINGS_GLOBAL_TAB_ID)
        return
      }
      openWorkbenchPanel(page)
    },
    [openGlobalTab, openWorkbenchPanel]
  )

  return { openSettings, openWorkbenchPanel }
}
