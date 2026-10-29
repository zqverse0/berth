"use client"

import { useEffect } from "react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  loadPersistedPanelState,
  savePersistedPanelState,
} from "@/lib/workspace/panel-state-storage"
import { isDesktop } from "@/lib/platform"
import { detectPlatform, type PlatformType } from "@/hooks/use-platform"
import { useAppUiStore } from "@/stores/app-ui-store"

const SIDEBAR_STORAGE_KEY = "workspace:left-sidebar"
const AUX_PANEL_STORAGE_KEY = "workspace:right-sidebar"

function resolveAuxMinWidth(platform: PlatformType, desktop: boolean): number {
  if (desktop && (platform === "windows" || platform === "linux")) return 260
  return 200
}

/** Owns app-UI persistence and lifecycle cleanup without adding a Provider. */
export function AppUiRuntime() {
  const activeFolderId = useAppWorkspaceStore((state) => state.activeFolderId)
  const sidebarOpen = useAppUiStore((state) => state.sidebarOpen)
  const sidebarWidth = useAppUiStore((state) => state.sidebarWidth)
  const sidebarRestored = useAppUiStore((state) => state.sidebarRestored)
  const auxPanelOpen = useAppUiStore((state) => state.auxPanelOpen)
  const auxPanelWidth = useAppUiStore((state) => state.auxPanelWidth)
  const auxPanelRestored = useAppUiStore((state) => state.auxPanelRestored)
  const hydrateSidebar = useAppUiStore((state) => state.hydrateSidebar)
  const hydrateAuxPanel = useAppUiStore((state) => state.hydrateAuxPanel)
  const setAuxPanelMinWidth = useAppUiStore(
    (state) => state.setAuxPanelMinWidth
  )
  const resetPendingReveal = useAppUiStore((state) => state.resetPendingReveal)

  useEffect(() => {
    const isMobile = window.innerWidth < 768
    hydrateSidebar(loadPersistedPanelState(SIDEBAR_STORAGE_KEY), isMobile)
    setAuxPanelMinWidth(resolveAuxMinWidth(detectPlatform(), isDesktop()))
    hydrateAuxPanel(loadPersistedPanelState(AUX_PANEL_STORAGE_KEY), isMobile)
  }, [hydrateAuxPanel, hydrateSidebar, setAuxPanelMinWidth])

  useEffect(() => {
    if (!sidebarRestored) return
    savePersistedPanelState(SIDEBAR_STORAGE_KEY, {
      isOpen: sidebarOpen,
      width: sidebarWidth,
    })
  }, [sidebarOpen, sidebarRestored, sidebarWidth])

  useEffect(() => {
    if (!auxPanelRestored) return
    savePersistedPanelState(AUX_PANEL_STORAGE_KEY, {
      isOpen: auxPanelOpen,
      width: auxPanelWidth,
    })
  }, [auxPanelOpen, auxPanelRestored, auxPanelWidth])

  useEffect(() => {
    resetPendingReveal()
  }, [activeFolderId, resetPendingReveal])

  return null
}
