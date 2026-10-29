"use client"

import { LazyPage } from "@/components/workbench/lazy-page"
import { SETTINGS_PAGE_LOADERS } from "@/components/settings/pages"
import { isSettingsPageId } from "@/lib/workspace/settings-tab"
import type { WorkbenchPanelId } from "@/lib/workbench"

/** 设置页在 workbench 面板宿主里的统一渲染入口。 */
export function BootOrSettingsPanel({
  panelId,
}: {
  panelId: WorkbenchPanelId
}) {
  if (!isSettingsPageId(panelId)) return null
  const load = SETTINGS_PAGE_LOADERS[panelId]
  return (
    <LazyPage key={panelId} load={load}>
      {(Page) => <Page />}
    </LazyPage>
  )
}

export function WorkbenchPanelBody({ panelId }: { panelId: WorkbenchPanelId }) {
  return <BootOrSettingsPanel panelId={panelId} />
}
