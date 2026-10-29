"use client"

import { memo, useCallback, useEffect, useState } from "react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import {
  requestAgentLaunch,
  useAgentLaunchStore,
} from "@/stores/agent-launch-store"
import { SessionViewSurface } from "@/sessions/components/session-view-surface"
import { isConversationTab } from "@/lib/workspace/primary-tabs"
import { useConversationRuntimeActions } from "@/stores/conversation-runtime-store"
import { useConversationDetail } from "@/hooks/use-conversation-detail"
import type { AgentType } from "@/lib/types"

interface SessionTabViewProps {
  tabId: string
  conversationId: number | null
  agentType: AgentType
  workingDir?: string
  isActive: boolean
}

function buildVirtualConversationId(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return -(Math.abs(hash) + 1)
}

/**
 * 会话记录阅读器的 tab 生命周期边界。工作区只负责放置这个 surface；
 * 会话详情加载、草稿跳转和只读消息渲染都归本 feature 管理。
 */
export const SessionTabView = memo(function SessionTabView({
  tabId,
  conversationId,
  agentType,
  workingDir,
  isActive,
}: SessionTabViewProps) {
  const ownTab = useTabStore(
    (state) =>
      state.tabs.filter(isConversationTab).find((tab) => tab.id === tabId) ??
      null
  )
  const ownFolderId = ownTab?.folderId ?? null
  const folder = useAppWorkspaceStore((state) =>
    ownFolderId != null
      ? (state.allFolders.find((item) => item.id === ownFolderId) ?? null)
      : null
  )
  const { activateFolderWorkspace, closeTab, setTabRuntimeConversationId } =
    useTabActions()
  const { refetchDetail } = useConversationRuntimeActions()
  const [effectiveConversationId] = useState(
    () => conversationId ?? buildVirtualConversationId(`draft-${tabId}`)
  )
  const hasPersistedConversation = conversationId != null
  const launchRequest = useAgentLaunchStore((state) => state.request)
  const isLaunchDraft = conversationId == null && launchRequest != null
  const isActiveLaunchDraft = isActive && isLaunchDraft

  useEffect(() => {
    if (!isActive || !isActiveLaunchDraft || !folder) return
    activateFolderWorkspace(folder.id)
    closeTab(tabId)
  }, [
    closeTab,
    activateFolderWorkspace,
    folder,
    isActive,
    isActiveLaunchDraft,
    tabId,
  ])

  useEffect(() => {
    if (effectiveConversationId !== conversationId) {
      setTabRuntimeConversationId(tabId, effectiveConversationId)
    }
  }, [
    conversationId,
    effectiveConversationId,
    setTabRuntimeConversationId,
    tabId,
  ])

  const {
    detail,
    loading: detailLoading,
    error: detailError,
  } = useConversationDetail(effectiveConversationId, { enabled: isActive })
  const workingDirForLaunch =
    workingDir || launchRequest?.workingDirectory || folder?.path
  const canShowDetailErrorActions =
    hasPersistedConversation && conversationId != null && !!folder

  const handleReloadDetail = useCallback(() => {
    if (conversationId == null) return
    refetchDetail(conversationId)
  }, [conversationId, refetchDetail])

  const handleOpenNewSession = useCallback(() => {
    if (!folder) return
    requestAgentLaunch({
      folderId: folder.id,
      workingDirectory: workingDirForLaunch ?? folder.path,
      preferredAgentType: agentType,
    })
    closeTab(tabId)
  }, [agentType, closeTab, folder, tabId, workingDirForLaunch])

  return (
    <SessionViewSurface
      conversationId={effectiveConversationId}
      detail={detail}
      isActive={isActive}
      detailLoading={detailLoading}
      detailError={detailError}
      hasPersistedConversation={hasPersistedConversation}
      onReload={canShowDetailErrorActions ? handleReloadDetail : undefined}
      onNewSession={
        canShowDetailErrorActions ? handleOpenNewSession : undefined
      }
    />
  )
})
