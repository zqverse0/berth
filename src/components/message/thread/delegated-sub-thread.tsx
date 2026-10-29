"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { AGENT_LABELS, type AgentType } from "@/lib/types"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import {
  resolveDelegationCardModel,
  type DelegationCardModel,
} from "@/lib/agent/delegation-card"
import { StatusBadge } from "@/components/message/cards/delegation-status-badge"

interface Props {
  parentToolUseId: string
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
  meta?: Record<string, unknown> | null
}

/**
 * Render the persisted delegation record without creating a live child view.
 * The old ACP child connection and permission controls no longer exist; a
 * transcript must remain a passive, readable projection.
 */
export function DelegatedSubThread({
  parentToolUseId,
  input,
  output,
  errorText,
  state,
  meta,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  const model = useMemo<DelegationCardModel>(
    () => resolveDelegationCardModel({ input, output, errorText, state, meta }),
    [errorText, input, meta, output, state]
  )

  // Keep the prop in the component contract because the adapter uses the tool
  // call id as the stable render identity, even though no live lookup remains.
  void parentToolUseId

  if (!model.hasModel) return null

  return (
    <div
      data-testid="delegated-sub-thread"
      className="@container/delegcard rounded-lg border border-border bg-card ws-msg-card"
    >
      <div className="flex w-full items-stretch rounded-lg overflow-hidden">
        <div className="flex flex-1 min-w-0 items-center gap-3 px-3 py-2.5 text-left">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground">
            {model.agentType ? (
              <AgentIcon
                agentType={model.agentType as AgentType}
                className="h-5 w-5"
              />
            ) : (
              <span className="h-2.5 w-2.5 rounded-sm bg-muted-foreground/60" />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">
                {model.agentType
                  ? AGENT_LABELS[model.agentType]
                  : t("unknownAgent")}
              </span>
              {model.taskId && (
                <span
                  className="shrink-0 font-mono text-xs text-muted-foreground"
                  title={model.taskId}
                >
                  #{model.taskId.slice(0, 8)}
                </span>
              )}
              <StatusBadge
                status={model.status}
                errorCode={model.errorCode ?? undefined}
              />
            </div>
            {model.task && (
              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-1">
                {model.task}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
