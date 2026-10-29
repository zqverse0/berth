"use client"

import { CircleAlert, Info, X, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useAppUiStore,
  type AlertLevel,
  type AlertAction,
} from "@/stores/app-ui-store"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { openUrl } from "@/lib/platform"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { requestAgentLaunch } from "@/stores/agent-launch-store"
import { AGENT_LABELS, type AgentType } from "@/lib/types"
import { useAttentionCount } from "@/lib/terminal/agent-panes"
import { StatusBarAttention } from "@/components/layout/status-bar/status-bar-attention"

const KNOWN_AGENT_TYPES = new Set<AgentType>(
  Object.keys(AGENT_LABELS) as AgentType[]
)

function parseAgentType(value: unknown): AgentType | null {
  if (typeof value !== "string") return null
  return KNOWN_AGENT_TYPES.has(value as AgentType) ? (value as AgentType) : null
}

function parseOpenAgentsSettingsPayload(payload: string): {
  agentType: AgentType | null
} {
  const normalized = payload.trim()
  if (!normalized || normalized === "agents") {
    return { agentType: null }
  }

  try {
    const parsed = JSON.parse(normalized)
    if (!parsed || typeof parsed !== "object") {
      return { agentType: null }
    }
    return {
      agentType: parseAgentType(
        (parsed as { agentType?: unknown }).agentType ?? null
      ),
    }
  } catch {
    return { agentType: null }
  }
}

function AlertLevelIcon({ level }: { level: AlertLevel }) {
  if (level === "info") {
    return <Info className="h-3 w-3 shrink-0 text-muted-foreground" />
  }
  if (level === "error") {
    return <CircleAlert className="h-3 w-3 shrink-0 text-red-500" />
  }
  return <CircleAlert className="h-3 w-3 shrink-0 text-yellow-500" />
}

function AlertActionButton({ action }: { action: AlertAction }) {
  const { activeFolder } = useActiveFolder()

  const handleClick = async () => {
    if ("run" in action) {
      action.run()
      return
    }
    switch (action.kind) {
      case "open_url":
        await openUrl(action.payload)
        break
      case "open_agents_settings": {
        // 智能体管理入口：新建会话菜单，而不是设置窗
        if (!activeFolder) break
        const agentType = parseOpenAgentsSettingsPayload(
          action.payload
        ).agentType
        requestAgentLaunch({
          folderId: activeFolder.id,
          workingDirectory: activeFolder.path,
          preferredAgentType: agentType,
        })
        break
      }
    }
  }

  return (
    <button
      onClick={handleClick}
      className="text-[10px] px-1.5 py-0.5 rounded bg-accent hover:bg-accent/80 text-accent-foreground transition-colors"
    >
      {action.label}
    </button>
  )
}

export function StatusBarAlerts() {
  const t = useTranslations("Folder.statusBar.alerts")
  const alerts = useAppUiStore((state) => state.alerts)
  const hasAlerts = alerts.length > 0
  // 只有错误 / 警告标红；Agent 需要关注标琥珀；普通提示只显示条数。
  const hasProblems = alerts.some((alert) => alert.level !== "info")
  const attention = useAttentionCount()
  const dismissAlert = useAppUiStore((state) => state.dismissAlert)
  const clearAll = useAppUiStore((state) => state.clearAlerts)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex h-full items-center gap-1.5 shrink-0 transition-colors",
            hasProblems
              ? "text-red-500 hover:text-red-600"
              : attention > 0
                ? "text-amber-600 dark:text-amber-400"
                : hasAlerts
                  ? "text-sidebar-foreground"
                  : "text-muted-foreground hover:text-foreground"
          )}
          title={t("title")}
          aria-label={t("title")}
        >
          <CircleAlert className="size-4 shrink-0" />
          {hasAlerts || attention > 0 ? (
            <span className="font-mono text-[11px] font-semibold">
              {alerts.length + attention}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-berth-status-alerts-content
        side="top"
        align="start"
        className="w-96 p-3"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium">{t("title")}</span>
          {hasAlerts && (
            <button
              onClick={clearAll}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
        {attention > 0 ? (
          <div className="mb-2 text-xs">
            <StatusBarAttention />
          </div>
        ) : null}
        {!hasAlerts ? (
          <div className="text-xs text-muted-foreground py-2">{t("empty")}</div>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-start gap-2 text-xs group"
              >
                <AlertLevelIcon level={alert.level} />
                <div className="flex-1 min-w-0">
                  <div className="break-words">{alert.message}</div>
                  {alert.detail && (
                    <div className="text-xs text-foreground/80 mt-0.5 break-all whitespace-pre-wrap font-mono">
                      {alert.detail}
                    </div>
                  )}
                  {alert.actions && alert.actions.length > 0 && (
                    <div className="flex items-center gap-1 mt-1">
                      {alert.actions.map((action, i) => (
                        <AlertActionButton key={i} action={action} />
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => dismissAlert(alert.id)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
