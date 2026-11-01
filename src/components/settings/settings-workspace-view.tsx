"use client"

import { WorkbenchPage } from "@/components/workbench/workbench-page"
import { WorkbenchPanelBody } from "@/components/workbench/workbench-panel-body"

/**
 * Settings content surface hosted by the global workspace tab. 页面由侧栏图标列底部的设置图标切换、
 * 齿轮或当前页图标退出（桌面与手机一致），这里不再有 tab 条与关闭按钮。
 */
export function SettingsWorkspaceView() {
  return (
    <WorkbenchPage
      pageId="settings"
      hideTabs
      renderPanel={(panelId) => <WorkbenchPanelBody panelId={panelId} />}
    />
  )
}
