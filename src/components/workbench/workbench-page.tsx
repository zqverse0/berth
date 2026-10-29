"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorkbenchPanelErrorBoundary } from "@/components/workbench/workbench-panel-error-boundary"
import { useWorkbenchLayout } from "@/hooks/workspace/use-workbench-layout"
import { WORKBENCH_PANELS } from "@/lib/workbench"
import type { WorkbenchPageId, WorkbenchPanelId } from "@/lib/workbench"

export interface WorkbenchPageProps {
  pageId: WorkbenchPageId
  closeButton?: ReactNode
  renderPanel?: (panelId: WorkbenchPanelId) => ReactNode
  /** 单一 body：tab 切换只改选中 id，不随 TabsContent 卸载。 */
  children?: ReactNode
  panelLabel?: (panelId: WorkbenchPanelId, fallback: string) => ReactNode
  /** 不显示 tab 条（面板由别处切换，如侧栏设置视图）。 */
  hideTabs?: boolean
}

function panelLabelKey(panelId: WorkbenchPanelId): string {
  return (
    WORKBENCH_PANELS.find((panel) => panel.id === panelId)?.labelKey ?? panelId
  )
}

export function WorkbenchPage({
  pageId,
  closeButton,
  renderPanel,
  children,
  panelLabel,
  hideTabs,
}: WorkbenchPageProps) {
  const t = useTranslations("Workbench")
  const { resolved, selected, selectPanel } = useWorkbenchLayout()
  const panelIds = resolved.pages[pageId]
  const activeId = selected[pageId] ?? panelIds[0]
  const usesSharedPanel = children !== undefined
  const sharedPanelId = `${pageId}-panel`
  const panelFallback = (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      {t("panelError")}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <Tabs
        value={activeId}
        onValueChange={(value) =>
          selectPanel(pageId, value as WorkbenchPanelId)
        }
        className="flex h-full min-h-0 flex-col gap-0"
      >
        {hideTabs ? null : (
          <div className="flex min-w-0 shrink-0 items-center overflow-hidden border-b px-2">
            <TabsList className="h-10 w-full min-w-0 flex-1 flex-nowrap justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none bg-transparent">
              {panelIds.map((panelId) => (
                <TabsTrigger
                  key={panelId}
                  value={panelId}
                  className="h-8 flex-none shrink-0 gap-1.5 px-2 text-xs"
                  {...(usesSharedPanel
                    ? {
                        id: `${pageId}-tab-${panelId}`,
                        "aria-controls": sharedPanelId,
                      }
                    : {})}
                >
                  <span className="max-w-48 truncate">
                    {panelLabel?.(
                      panelId,
                      t(
                        `panels.${panelLabelKey(panelId)}` as Parameters<
                          typeof t
                        >[0]
                      )
                    ) ??
                      t(
                        `panels.${panelLabelKey(panelId)}` as Parameters<
                          typeof t
                        >[0]
                      )}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
            {closeButton}
          </div>
        )}
        {usesSharedPanel ? (
          <div
            role="tabpanel"
            id={sharedPanelId}
            aria-labelledby={activeId ? `${pageId}-tab-${activeId}` : undefined}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <WorkbenchPanelErrorBoundary
              resetKey={activeId ?? pageId}
              fallback={panelFallback}
            >
              {children}
            </WorkbenchPanelErrorBoundary>
          </div>
        ) : (
          panelIds.map((panelId) => (
            <TabsContent
              key={panelId}
              value={panelId}
              className="min-h-0 flex-1 overflow-hidden"
            >
              <WorkbenchPanelErrorBoundary
                resetKey={panelId}
                fallback={panelFallback}
              >
                {renderPanel?.(panelId)}
              </WorkbenchPanelErrorBoundary>
            </TabsContent>
          ))
        )}
      </Tabs>
    </div>
  )
}
