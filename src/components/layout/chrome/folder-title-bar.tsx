"use client"

import { useCallback } from "react"
import { Menu, PanelRight, Settings } from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { usePlatform } from "@/hooks/use-platform"
import { Button } from "@/components/ui/button"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import {
  MAC_TRAFFIC_LIGHT_INSET,
  hasNativeWindowChrome,
} from "@/lib/window-chrome"
import { cn } from "@/lib/utils"
import { WindowControls } from "@/components/layout/chrome/window-controls"
import { TerminalCommandsMenu } from "@/components/layout/aux-panel/terminal-commands"

/**
 * Mobile-only workspace title bar (`h-10`, matching the desktop column strip).
 *
 * On desktop the full-width title bar was removed: its buttons were relocated
 * into the `ActivityBar` and the fixed `RightEdgeChrome` overlay and its
 * global shortcut control moved to `WorkspaceCommandController`. This bar is
 * mounted only on the mobile path (`FolderLayoutShell`), where the sidebar / aux
 * are `Sheet` overlays that need a compact bar to summon them.
 *
 * It mirrors the desktop chrome directly (rather than via `AppTitleBar`): the
 * left holds the sidebar toggle and settings.
 * The right holds shortcut commands and the aux toggle. The empty middle is a
 * full-height `data-tauri-drag-region` filler so the window drags by it — plus a macOS
 * traffic-light inset and the Windows/Linux caption buttons (`WindowControls`
 * self-nulls elsewhere), exactly like the desktop edges.
 */
export function FolderTitleBar() {
  const tTitleBar = useTranslations("Folder.folderTitleBar")
  const sidebarOpen = useAppUiStore((state) => state.sidebarOpen)
  const toggle = useAppUiStore((state) => state.toggleSidebar)
  const auxPanelOpen = useAppUiStore((state) => state.auxPanelOpen)
  const toggleAuxPanel = useAppUiStore((state) => state.toggleAuxPanel)
  const { openSettings } = useSettingsWorkspace()
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const { isMac } = usePlatform()
  const showMacInset = isMac && hasNativeWindowChrome()
  const handleOpenSettings = useCallback(() => {
    openSettings()
  }, [openSettings])

  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border ws-chrome-border bg-muted/70 select-none">
      {/* macOS traffic-light inset — a window-drag region so the left cluster
        clears the OS-drawn lights. */}
      {showMacInset && (
        <div
          data-tauri-drag-region
          className="h-full shrink-0"
          style={{ width: MAC_TRAFFIC_LIGHT_INSET }}
        />
      )}
      {/* Settings stays beside the sidebar toggle on mobile, mirroring the
        desktop ActivityBar controls (which no longer carry a folder entry). */}
      <div className="flex shrink-0 items-center gap-1 pl-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={toggle}
          title={tTitleBar(sidebarOpen ? "hideSidebar" : "showSidebar")}
          aria-label={tTitleBar(sidebarOpen ? "hideSidebar" : "showSidebar")}
        >
          <Menu className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 hover:bg-foreground/10 hover:text-foreground/80 dark:hover:bg-foreground/10"
          onClick={handleOpenSettings}
          title={tTitleBar("openSettings")}
          aria-label={tTitleBar("openSettings")}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
      {/* Empty middle is a full-height window-drag region. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      {/* Right cluster: aux panel toggle. Terminal creation is a
        primary-resource action in the resource menu above, never a legacy
        panel toggle. */}
      <div className="flex shrink-0 items-center gap-1 pr-2">
        {auxPanelOpen && <TerminalCommandsMenu className="h-8 w-8 shrink-0" />}
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 shrink-0", auxPanelOpen && "bg-accent")}
          onClick={toggleAuxPanel}
          disabled={!activeFolder && !isChatMode}
          title={tTitleBar("toggleAuxPanel")}
          aria-label={tTitleBar("toggleAuxPanel")}
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      </div>
      {/* Windows/Linux caption buttons; self-nulls on macOS / web. */}
      <WindowControls />
    </div>
  )
}
