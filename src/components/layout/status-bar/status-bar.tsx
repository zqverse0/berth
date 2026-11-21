"use client"

import { memo } from "react"
import { StatusBarTasks } from "@/components/layout/status-bar/status-bar-tasks"
import { StatusBarUpdate } from "@/components/layout/status-bar/status-bar-update"
import { StatusBarUsage } from "@/components/layout/status-bar/status-bar-usage"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useIsMobile } from "@/hooks/use-mobile"
import { StatusBarAlerts } from "@/components/layout/status-bar/status-bar-alerts"
import { StatusBarContext } from "@/components/layout/status-bar/status-bar-context"
import { StatusBarProject } from "@/components/layout/status-bar/status-bar-project"
import { StatusBarResources } from "@/components/layout/status-bar/status-bar-resources"
import { cn } from "@/lib/utils"

/**
 * 窗口通栏状态栏，各段对齐上方各栏：视图栏下方为告警，侧栏段显示项目与分支（兼作下方面板的开关）、设备，
 * 工作区段显示当前文件位置、本机资源、更新与后台任务，辅助段只读显示 Agent 用量；
 * Agent 启动入口在视图栏，启动表单显示在侧栏。
 * 手机上三栏是互斥的整屏抽屉，只显示当前看得见那一栏的段：侧栏（告警、项目）、阅读区、辅助面板（用量）。
 */
export const StatusBar = memo(function StatusBar({
  className,
}: {
  className?: string
}) {
  const setUsageStates = useStatusBarLaunchStore((s) => s.setUsageStates)
  const isMobile = useIsMobile()
  const mobileSurface = useAppUiStore((s) =>
    s.sidebarRestored && s.sidebarOpen
      ? "sidebar"
      : s.auxPanelRestored && s.auxPanelOpen
        ? "aux"
        : "main"
  )
  // 只用 CSS 藏：用量段卸载会停掉启动栏依赖的用量同步。
  const hiddenOnMobile = (surface: typeof mobileSurface) =>
    isMobile && mobileSurface !== surface && "hidden"

  return (
    <div className={cn("relative shrink-0", className)}>
      {/* Segment widths track the sidebar / aux panes via CSS variables the
          shell writes (--status-left / --status-right); a collapsed pane
          falls back to content width so its segment never disappears. */}
      <div
        data-slot="status-bar"
        className="flex h-8 items-stretch border-t border-border ws-chrome-border ws-surface-muted text-xs text-muted-foreground overflow-hidden select-none"
      >
        {/* Under the ActivityBar (same w-12): alerts sit at the junction. */}
        <div
          data-status-segment="alerts"
          className={cn(
            "flex w-12 shrink-0 items-center justify-center border-r max-md:w-10 border-border/50 ws-chrome-border",
            hiddenOnMobile("sidebar")
          )}
        >
          <StatusBarAlerts />
        </div>
        <div
          data-status-segment="project"
          className={cn(
            "flex min-w-0 shrink-0 items-center justify-center overflow-hidden border-r border-border/50 ws-chrome-border px-2 max-md:flex-1 max-md:border-r-0",
            hiddenOnMobile("sidebar")
          )}
          style={{ width: "var(--status-left, auto)" }}
        >
          <StatusBarProject />
        </div>
        <div
          data-status-segment="workspace"
          className={cn(
            "flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden px-3 max-md:px-1",
            hiddenOnMobile("main")
          )}
        >
          <div className="min-w-0 flex-1 overflow-hidden">
            <StatusBarContext part="path" />
          </div>
          <StatusBarResources />
          <StatusBarUpdate />
          <StatusBarTasks />
        </div>
        <div
          data-status-segment="agents"
          className={cn(
            "flex min-w-0 shrink-0 items-center justify-center overflow-hidden border-l border-border/50 ws-chrome-border px-2 max-md:flex-1 max-md:border-l-0",
            hiddenOnMobile("aux")
          )}
          style={{ width: "var(--status-right, auto)" }}
        >
          <StatusBarUsage onStatesChange={setUsageStates} />
        </div>
      </div>
    </div>
  )
})
