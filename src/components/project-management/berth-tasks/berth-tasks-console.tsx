"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCw } from "lucide-react"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
} from "@/components/layout/sidebar/sidebar-header"
import type { AgentType } from "@/lib/types"
import { getBerthStatus } from "@/lib/agent/berth-project"
import { listBerthTasks, type BerthTaskList } from "@/lib/agent/berth-tasks"
import type { RuntimeBridgeError } from "@/lib/runtime-bridge"
import { cn } from "@/lib/utils"
import { EnableBerthNotice } from "../enable-berth-notice"
import { BerthTasksPanel } from "./berth-tasks-panel"

interface BerthTasksConsoleProps {
  folderId: number
  selectedAgent?: AgentType
  className?: string
  /** Launch section is selected and the project surface is visible. */
  surfaceActive?: boolean
}

const TASK_REFRESH_MS = 2_000

type LoadState =
  | { status: "idle" | "loading" }
  | {
      status: "ready"
      enabled: boolean
      tasks: BerthTaskList
    }
  | { status: "error"; error: RuntimeBridgeError }

export function BerthTasksConsole({
  folderId,
  className,
  surfaceActive = true,
}: BerthTasksConsoleProps) {
  const t = useTranslations("BerthTasks")
  const [state, setState] = useState<LoadState>({ status: "idle" })

  const load = useCallback(
    async (showLoading = true) => {
      if (showLoading) setState({ status: "loading" })
      const status = await getBerthStatus(folderId)
      if (!status.ok) {
        setState({ status: "error", error: status.error })
        return
      }
      if (!status.result.enabled) {
        setState({
          status: "ready",
          enabled: false,
          tasks: { tasks: [], diagnostics: [], truncated: false },
        })
        return
      }
      const tasks = await listBerthTasks(folderId)
      if (!tasks.ok) {
        setState({ status: "error", error: tasks.error })
        return
      }
      setState({
        status: "ready",
        enabled: true,
        tasks: tasks.result,
      })
    },
    [folderId]
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(false), 0)
    return () => window.clearTimeout(timeout)
  }, [load])

  useEffect(() => {
    if (!surfaceActive) return
    const tick = () => {
      if (document.visibilityState === "visible") void load(false)
    }
    const interval = window.setInterval(tick, TASK_REFRESH_MS)
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [load, surfaceActive])

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col border-t border-border/60 bg-muted/20",
        className
      )}
    >
      <SidebarHeaderActions>
        <SidebarHeaderButton
          icon={RefreshCw}
          label={t("refresh")}
          onClick={() => void load()}
          disabled={state.status === "loading"}
        />
      </SidebarHeaderActions>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-2 py-3">
        {state.status === "loading" || state.status === "idle" ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : null}

        {state.status === "error" ? (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">{t("errorTitle")}</p>
            <p className="break-all font-mono text-xs">{state.error.message}</p>
            <p className="text-xs text-muted-foreground">
              {t("agentBootstrapHint")}
            </p>
          </div>
        ) : null}

        {state.status === "ready" ? (
          <div className="flex min-h-0 flex-col gap-4">
            {/* 未启用时群组和任务都读不到，只给启用入口，不让面板报「未启用」错误。 */}
            {state.enabled ? (
              <BerthTasksPanel folderId={folderId} data={state.tasks} />
            ) : (
              <EnableBerthNotice
                folderId={folderId}
                onEnabled={() => void load()}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export { BerthTasksConsole as BerthTasks }
