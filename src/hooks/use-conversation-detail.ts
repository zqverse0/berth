"use client"

import { useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  useConversationRuntimeActions,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { DbConversationDetail } from "@/lib/types"

function isVirtualConversationId(conversationId: number): boolean {
  return !Number.isFinite(conversationId) || conversationId <= 0
}

export function useConversationDetail(
  conversationId: number,
  options?: {
    /**
     * Gate the built-in auto-fetch. Defaults to `true`. Pass `false` when the
     * caller drives fetching itself and must prevent a fetch from landing at
     * the wrong moment — e.g. the sub-agent session dialog, which must not load
     * the child's persisted detail while it is mid-stream (the parser surfaces
     * the in-progress turn as a normal turn, which would then duplicate the
     * live stream).
     */
    enabled?: boolean
  }
): {
  detail: DbConversationDetail | null
  loading: boolean
  error: string | null
} {
  const enabled = options?.enabled ?? true
  const { detail, detailLoading, detailError, hasSession } =
    useConversationRuntimeStore(
      useShallow((s) => {
        const session = s.byConversationId.get(conversationId)
        return {
          detail: session?.detail ?? null,
          detailLoading: session?.detailLoading ?? false,
          detailError: session?.detailError ?? null,
          hasSession: session != null,
        }
      })
    )
  const { fetchDetail } = useConversationRuntimeActions()
  const isVirtual = isVirtualConversationId(conversationId)

  useEffect(() => {
    if (!enabled) return
    if (isVirtual) return
    if (detail || detailLoading) return
    fetchDetail(conversationId)
  }, [enabled, conversationId, isVirtual, detail, detailLoading, fetchDetail])

  return {
    detail,
    loading: hasSession ? detailLoading : !isVirtual,
    error: detailError,
  }
}
