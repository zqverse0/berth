"use client"

import { memo } from "react"
import { StatusBarTasks } from "@/components/layout/status-bar/status-bar-tasks"
import { StatusBarUpdate } from "@/components/layout/status-bar/status-bar-update"
import { StatusBarUsage } from "@/components/layout/status-bar/status-bar-usage"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import { StatusBarAlerts } from "@/components/layout/status-bar/status-bar-alerts"
import { StatusBarContext } from "@/components/layout/status-bar/status-bar-context"
import { cn } from "@/lib/utils"

/**
 * 窗口通栏状态栏，各段对齐上方各栏：视图栏下方为告警，侧栏段显示项目与分支，
 * 工作区段显示当前文件位置、更新与后台任务，辅助段只读显示 Agent 用量；
 * Agent 启动入口在视图栏，启动表单显示在侧栏。
 */
export const StatusBar = memo(function StatusBar({
  className,
}: {
  className?: string
}) {
  const setUsageStates = useStatusBarLaunchStore((s) => s.setUsageStates)

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
          className="flex w-12 shrink-0 items-center justify-center border-r max-md:w-10 border-border/50 ws-chrome-border"
        >
          <StatusBarAlerts />
        </div>
        <div
          data-status-segment="project"
          className="flex min-w-0 shrink-0 items-center justify-center overflow-hidden border-r border-border/50 ws-chrome-border px-2 max-md:max-w-[45%] max-md:shrink"
          style={{ width: "var(--status-left, auto)" }}
        >
          <StatusBarContext part="project" />
        </div>
        <div
          data-status-segment="workspace"
          className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden px-3 max-md:px-1"
        >
          {/* 手机上标题与 tab 条已表明当前文件，路径挤不下 */}
          <div className="min-w-0 flex-1 overflow-hidden max-md:hidden">
            <StatusBarContext part="path" />
          </div>
          <StatusBarUpdate />
          <StatusBarTasks />
        </div>
        <div
          data-status-segment="agents"
          className="flex min-w-0 shrink-0 items-center justify-center overflow-hidden border-l border-border/50 ws-chrome-border px-2"
          style={{ width: "var(--status-right, auto)" }}
        >
          <StatusBarUsage onStatesChange={setUsageStates} />
        </div>
      </div>
    </div>
  )
})
