"use client"

import { useCallback, useMemo } from "react"
import {
  SETTINGS_GLOBAL_TAB_ID,
  type SettingsPageId,
} from "@/lib/workspace/settings-tab"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { useOpenWorkbenchPanel } from "@/hooks/workspace/use-open-workbench-panel"

export interface SettingsWorkspaceContextValue {
  isOpen: boolean
  isActive: boolean
  openSettings: (page?: SettingsPageId | null) => void
  closeSettings: () => void
  selectSettings: () => void
}

export function useSettingsWorkspace(): SettingsWorkspaceContextValue {
  const { isOpen, isActive } = useWorkspaceLayoutProjection(
    ({ activeTabByPane, globalTabs }) => ({
      isOpen: globalTabs.some((tab) => tab.id === SETTINGS_GLOBAL_TAB_ID),
      isActive:
        (activeTabByPane.files?.kind === "global" &&
          activeTabByPane.files.id === SETTINGS_GLOBAL_TAB_ID) ||
        (activeTabByPane.conversation?.kind === "global" &&
          activeTabByPane.conversation.id === SETTINGS_GLOBAL_TAB_ID),
    })
  )
  const closeGlobalTab = useWorkspaceLayoutStore(
    (state) => state.closeGlobalTab
  )
  const selectWorkspaceTab = useWorkspaceLayoutStore(
    (state) => state.selectWorkspaceTab
  )
  const { openSettings } = useOpenWorkbenchPanel()

  const closeSettings = useCallback(() => {
    closeGlobalTab(SETTINGS_GLOBAL_TAB_ID)
  }, [closeGlobalTab])

  const selectSettings = useCallback(() => {
    if (!isOpen) return
    selectWorkspaceTab({
      kind: "global",
      id: SETTINGS_GLOBAL_TAB_ID,
    })
  }, [isOpen, selectWorkspaceTab])

  return useMemo<SettingsWorkspaceContextValue>(
    () => ({
      isOpen,
      isActive,
      openSettings,
      closeSettings,
      selectSettings,
    }),
    [closeSettings, isActive, isOpen, openSettings, selectSettings]
  )
}
