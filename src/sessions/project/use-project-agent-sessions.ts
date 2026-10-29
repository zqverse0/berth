"use client"

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { resolveProjectAgentSession } from "@/lib/api"
import {
  getProjectSessionSnapshot,
  loadProjectSessionPage,
  subscribeProjectSessionSnapshot,
  updateProjectSessionRow,
  type ProjectSessionQueryScope,
  type ProjectSessionSnapshot,
} from "./cache"
import { retainProjectSessionLiveSync } from "./live-sync"
import type {
  AgentType,
  DbConversationSummary,
  ProjectAgentSessionSummary,
} from "@/lib/types"

interface UseProjectAgentSessionsOptions {
  folderId: number
  agentType: AgentType | null
  query: string
  enabled: boolean
}

const EMPTY_SNAPSHOT: ProjectSessionSnapshot = {
  items: [],
  nextCursor: null,
  scanComplete: true,
  sourceWarning: null,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
}

export function useProjectAgentSessions({
  folderId,
  agentType,
  query,
  enabled,
}: UseProjectAgentSessionsOptions) {
  const scope = useMemo<ProjectSessionQueryScope | null>(
    () => (agentType ? { folderId, agentType, query } : null),
    [agentType, folderId, query]
  )
  const subscribeSnapshot = useCallback(
    (listener: () => void) =>
      scope ? subscribeProjectSessionSnapshot(scope, listener) : () => {},
    [scope]
  )
  const getSnapshot = useCallback(
    () => (scope ? getProjectSessionSnapshot(scope) : EMPTY_SNAPSHOT),
    [scope]
  )
  const snapshot = useSyncExternalStore(
    subscribeSnapshot,
    getSnapshot,
    getSnapshot
  )

  const hasScope = scope != null
  useEffect(() => {
    if (!hasScope) return
    return retainProjectSessionLiveSync()
  }, [hasScope])

  useEffect(() => {
    if (!enabled || !scope) return
    const timer = window.setTimeout(() => {
      void loadProjectSessionPage(scope)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [enabled, scope])

  const loadMore = useCallback(() => {
    if (!scope || snapshot.loading || snapshot.loadingMore) return
    void loadProjectSessionPage(scope, { append: true })
  }, [scope, snapshot.loading, snapshot.loadingMore])

  const refresh = useCallback(() => {
    if (!scope) return
    void loadProjectSessionPage(scope, { force: true })
  }, [scope])

  const resolve = useCallback(
    async (
      row: ProjectAgentSessionSummary
    ): Promise<DbConversationSummary | null> => {
      if (!scope || !row.externalId) return row.conversation
      const result = await resolveProjectAgentSession({
        folderId,
        agentType: row.agentType,
        externalId: row.externalId,
      })
      if (result.deleted) {
        updateProjectSessionRow(scope, null, row)
        return null
      }
      if (!result.sourceAvailable || !result.conversation) {
        updateProjectSessionRow(scope, { ...row, sourceAvailable: false }, row)
        return null
      }
      const conversation = result.conversation
      updateProjectSessionRow(
        scope,
        {
          ...row,
          conversationId: conversation.id,
          conversation,
          source: "both",
          sourceAvailable: true,
        },
        row
      )
      return conversation
    },
    [folderId, scope]
  )

  return {
    items: snapshot.items,
    loading: snapshot.loading,
    loadingMore: snapshot.loadingMore,
    error: snapshot.error,
    sourceWarning: snapshot.sourceWarning,
    scanComplete: snapshot.scanComplete,
    hasMore: snapshot.nextCursor != null,
    loadMore,
    refresh,
    resolve,
  }
}
