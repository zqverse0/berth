"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { normalizeAbsPath } from "@/lib/files/file-open-target"
import type { AgentProfileSummary } from "@/lib/transport/launchbar"
import type { AgentType } from "@/lib/types"
import { launchbar } from "@/lib/transport/launchbar"
import {
  WORKSPACE_FILE_SAVED_EVENT,
  type WorkspaceFileSavedDetail,
} from "@/lib/workspace/workspace-file-events"

export interface UseAgentProfilesResult {
  /** 所有可投影为 Agent 的 tools 目录（按名字排序）。 */
  agents: AgentProfileSummary[]
  /** tools 根目录（项目 Agent 页「打开目录」用）。 */
  directory: string | null
  fresh: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

interface AgentProfilesStore {
  agents: AgentProfileSummary[]
  directory: string | null
  fresh: boolean
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

let latestRequestId = 0
let latestSuccessId = 0
let refCount = 0
let disposers: Array<() => void> = []

/** 全局 profile store（导出供 AgentIcon 等非 hook 场景同步读取/订阅）。 */
export const useAgentProfilesStore = create<AgentProfilesStore>((set) => ({
  agents: [],
  directory: null,
  fresh: false,
  loading: false,
  error: null,
  reload: async () => {
    const requestId = latestRequestId + 1
    latestRequestId = requestId
    set({ loading: true })
    try {
      const response = await launchbar({ type: "list_agents" })
      if (requestId <= latestSuccessId) return
      latestSuccessId = requestId
      if (response.type !== "agents") {
        throw new Error("unexpected launchbar response")
      }
      set({
        agents: response.agents,
        directory: response.directory,
        fresh: true,
        loading: false,
        error: null,
      })
    } catch (error) {
      if (requestId > latestSuccessId) {
        set({ loading: false, error: errorMessage(error) })
      }
    }
  },
}))

/**
 * 终端 Agent 的 tool id → tab / 会话用的 AgentType：与启动栏一致取 profile 的
 * `projectType`，未声明（或 profile 尚未加载）时就是 id。
 */
export function agentTypeForTool(
  agentId: string | null | undefined
): AgentType | null {
  if (!agentId) return null
  const profile = useAgentProfilesStore
    .getState()
    .agents.find((agent) => agent.id === agentId)
  return (profile?.projectType ?? agentId) as AgentType
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === "string" ? error : "Unable to read agent profiles"
}

function startSharedSubscription(): void {
  const reload = () => {
    if (refCount === 0) return
    void useAgentProfilesStore.getState().reload()
  }
  queueMicrotask(reload)
  window.addEventListener("focus", reload)
  disposers.push(() => window.removeEventListener("focus", reload))
  const handleFileSaved = (event: Event) => {
    const path = normalizeAbsPath(
      (event as CustomEvent<WorkspaceFileSavedDetail>).detail.path
    )
    // Agent 档案（tool.json）或启动栏声明（launchbar.json）保存后重读。
    if (path.endsWith("tool.json") || path.endsWith("launchbar.json")) reload()
  }
  window.addEventListener(WORKSPACE_FILE_SAVED_EVENT, handleFileSaved)
  disposers.push(() =>
    window.removeEventListener(WORKSPACE_FILE_SAVED_EVENT, handleFileSaved)
  )
}

function acquireSharedSubscription(): () => void {
  refCount += 1
  if (refCount === 1) startSharedSubscription()
  return () => {
    refCount -= 1
    if (refCount !== 0) return
    for (const dispose of disposers) dispose()
    disposers = []
    latestSuccessId = latestRequestId
    useAgentProfilesStore.setState({
      agents: [],
      directory: null,
      fresh: false,
      loading: false,
      error: null,
    })
  }
}

export function useAgentProfiles(): UseAgentProfilesResult {
  useEffect(() => acquireSharedSubscription(), [])
  const agents = useAgentProfilesStore((state) => state.agents)
  const directory = useAgentProfilesStore((state) => state.directory)
  const fresh = useAgentProfilesStore((state) => state.fresh)
  const loading = useAgentProfilesStore((state) => state.loading)
  const error = useAgentProfilesStore((state) => state.error)
  const refresh = useAgentProfilesStore((state) => state.reload)
  return { agents, directory, fresh, loading, error, refresh }
}
