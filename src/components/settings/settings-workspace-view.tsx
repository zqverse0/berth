"use client"

import { X } from "lucide-react"
import { useTranslations } from "next-intl"
import { useIsMobile } from "@/hooks/use-mobile"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import { Button } from "@/components/ui/button"
import { WorkbenchPage } from "@/components/workbench/workbench-page"
import { WorkbenchPanelBody } from "@/components/workbench/workbench-panel-body"

function CloseSettingsButton() {
  const tTabs = useTranslations("Folder.tabs")
  const { closeSettings } = useSettingsWorkspace()

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="ml-1 h-8 w-8 shrink-0"
      aria-label={tTabs("close")}
      title={tTabs("close")}
      onClick={closeSettings}
    >
      <X className="h-4 w-4" />
    </Button>
  )
}

/** Settings content surface hosted by the global workspace tab. */
export function SettingsWorkspaceView() {
  const isMobile = useIsMobile()

  return (
    <WorkbenchPage
      pageId="settings"
      closeButton={isMobile ? <CloseSettingsButton /> : undefined}
      // 桌面端由侧栏设置视图的顶栏 tab 切换页面。
      hideTabs={!isMobile}
      renderPanel={(panelId) => <WorkbenchPanelBody panelId={panelId} />}
    />
  )
}
