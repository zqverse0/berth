"use client"

import { useEffect } from "react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  loadPersistedPanelState,
  savePersistedPanelState,
} from "@/lib/workspace/panel-state-storage"
import { isDesktop } from "@/lib/platform"
import { detectPlatform, type PlatformType } from "@/hooks/use-platform"
import { MOBILE_BREAKPOINT } from "@/hooks/use-mobile"
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
  // 手机上面板开关只是临时抽屉，存的始终是桌面的开关。
  const mobileLayout = useAppUiStore((state) => state.mobileLayout)
  const desktopPanels = useAppUiStore((state) => state.desktopPanels)
  const savedSidebarOpen = mobileLayout
    ? desktopPanels.sidebarOpen
    : sidebarOpen
  const savedAuxOpen = mobileLayout ? desktopPanels.auxPanelOpen : auxPanelOpen

  // 「是不是手机」的唯一来源；须先于面板恢复，恢复时按它决定开关。
  useEffect(() => {
    const mql = window.matchMedia?.(MOBILE_BREAKPOINT)
    if (!mql) return
    const sync = () => useAppUiStore.getState().setMobileLayout(mql.matches)
    sync()
    mql.addEventListener("change", sync)
    return () => mql.removeEventListener("change", sync)
  }, [])

  useEffect(() => {
    hydrateSidebar(loadPersistedPanelState(SIDEBAR_STORAGE_KEY))
    setAuxPanelMinWidth(resolveAuxMinWidth(detectPlatform(), isDesktop()))
    hydrateAuxPanel(loadPersistedPanelState(AUX_PANEL_STORAGE_KEY))
  }, [hydrateAuxPanel, hydrateSidebar, setAuxPanelMinWidth])

  useEffect(() => {
    if (!sidebarRestored) return
    savePersistedPanelState(SIDEBAR_STORAGE_KEY, {
      isOpen: savedSidebarOpen,
      width: sidebarWidth,
    })
  }, [savedSidebarOpen, sidebarRestored, sidebarWidth])

  useEffect(() => {
    if (!auxPanelRestored) return
    savePersistedPanelState(AUX_PANEL_STORAGE_KEY, {
      isOpen: savedAuxOpen,
      width: auxPanelWidth,
    })
  }, [savedAuxOpen, auxPanelRestored, auxPanelWidth])

  useEffect(() => {
    resetPendingReveal()
  }, [activeFolderId, resetPendingReveal])

  return null
}
