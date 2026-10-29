"use client"

import { PanelRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useZoomLevel } from "@/hooks/use-appearance"
import { rightChromeClusterWidth } from "@/lib/window-chrome"
import { commandHint } from "@/components/layout/commands/commands"
import { cn } from "@/lib/utils"
import { TerminalCommandsMenu } from "@/components/layout/aux-panel/terminal-commands"

/**
 * Contents of the window's fixed top-RIGHT chrome overlay: shortcut commands
 * and the aux-panel toggle (the terminal launcher lives in the ActivityBar).
 * `FolderLayoutShell` pins this at the window's top-right
 * corner (to the LEFT of the Windows/Linux caption buttons) so it never moves
 * — or re-mounts — when the aux panel opens or closes. A leading drag filler
 * right-aligns the cluster; the fixed width matches the right-edge column's
 * reservation (see `rightChromeReserve`).
 */
export function RightEdgeChrome() {
  const tTitleBar = useTranslations("Folder.folderTitleBar")
  const auxPanelOpen = useAppUiStore((state) => state.auxPanelOpen)
  const toggleAuxPanel = useAppUiStore((state) => state.toggleAuxPanel)
  const { zoomLevel } = useZoomLevel()

  return (
    <div
      className="flex h-full items-center"
      style={{ width: rightChromeClusterWidth(zoomLevel) }}
    >
      {/* Empty head is a window-drag region; buttons stay flush right. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      <div className="flex items-center gap-1 pr-3">
        {auxPanelOpen && (
          <TerminalCommandsMenu className="h-6 w-6 hover:bg-foreground/10 hover:text-foreground/80 dark:hover:bg-foreground/10 [&_svg]:size-3.5" />
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6 hover:bg-foreground/10 hover:text-foreground/80 dark:hover:bg-foreground/10",
            auxPanelOpen && "bg-accent"
          )}
          onClick={toggleAuxPanel}
          title={tTitleBar("withShortcut", {
            label: tTitleBar("toggleAuxPanel"),
            shortcut: commandHint("toggle_aux_panel"),
          })}
          aria-label={tTitleBar("toggleAuxPanel")}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
