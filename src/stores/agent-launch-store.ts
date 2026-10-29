"use client"

import { create } from "zustand"
import type { AgentType, PromptDraft } from "@/lib/types"
import type { UsageState } from "@/lib/transport/usage"
import { useAppUiStore } from "@/stores/app-ui-store"

export type AgentLaunchRequestSeed = {
  folderId: number
  workingDirectory: string
  preferredAgentType?: AgentType | null
  /** 透传给 openNewConversationTab：从当前 active tab 继承 agent。 */
  inheritFromActive?: boolean
  /** Launch-bar first prompt, consumed once by the normal conversation draft. */
  initialDraft?: PromptDraft | null
}

export interface AgentLaunchStore {
  request: AgentLaunchRequestSeed | null
  /** 写入当前项目的终端启动请求。 */
  requestLaunch: (request: AgentLaunchRequestSeed) => void
  /** 只对齐项目请求，不改变已有草稿的其他状态。 */
  ensureRequest: (request: AgentLaunchRequestSeed) => void
  consumeInitialDraft: () => PromptDraft | null
  dismiss: () => void
}

export function createAgentLaunchController() {
  return create<AgentLaunchStore>((set) => ({
    request: null,
    requestLaunch: (request) => set({ request }),
    ensureRequest: (request) =>
      set((state) => {
        const previous = state.request
        if (
          previous &&
          previous.folderId === request.folderId &&
          previous.workingDirectory === request.workingDirectory
        ) {
          if (previous.preferredAgentType === request.preferredAgentType) {
            return state
          }
          return {
            request: {
              ...previous,
              preferredAgentType: request.preferredAgentType,
              initialDraft: request.initialDraft ?? previous.initialDraft,
            },
          }
        }
        return { request }
      }),
    consumeInitialDraft: () => {
      let draft: PromptDraft | null = null
      set((state) => {
        draft = state.request?.initialDraft ?? null
        if (!state.request?.initialDraft) return state
        return { request: { ...state.request, initialDraft: null } }
      })
      return draft
    },
    dismiss: () => set({ request: null }),
  }))
}

/** 默认控制器供会话草稿和项目管理入口共享。 */
export const useAgentLaunchStore = createAgentLaunchController()

/** 打开启动栏时预选的内容（群里「添加专家 / 再开一个终端」）：专家，以及在哪个项目目录启动（缺省当前项目）。 */
export interface LaunchPreset {
  expert?: string | null
  folderId?: number
  workingDirectory?: string
}

export const useStatusBarLaunchStore = create<{
  /** 群组 tab 栏右侧的启动弹层是否打开。 */
  launchOpen: boolean
  /** 弹层里选中的 Agent；为 null 时弹层显示 Agent 列表。 */
  activeLaunchAgentId: string | null
  /** 本次打开的预选；关闭时清掉。 */
  launchPreset: LaunchPreset | null
  /** Latest account usage, published by the status bar for the launch view. */
  usageStates: UsageState[] | null
  setUsageStates: (states: UsageState[] | null) => void
  /** 在弹层里选 / 退回 Agent，保留预选（群里「添加专家」只带专家时先选 Agent）。 */
  setActiveLaunchAgentId: (agentId: string | null) => void
  /** 打开启动弹层（并展开右侧面板）；给了 Agent 就直接到它的启动表单。 */
  openLaunchShelf: (agentId?: string | null, preset?: LaunchPreset) => void
  closeLaunchShelf: () => void
}>()((set) => ({
  launchOpen: false,
  activeLaunchAgentId: null,
  launchPreset: null,
  usageStates: null,
  setUsageStates: (usageStates) => set({ usageStates }),
  setActiveLaunchAgentId: (agentId) => set({ activeLaunchAgentId: agentId }),
  openLaunchShelf: (agentId, preset) => {
    useAppUiStore.getState().setAuxPanelOpen(true)
    set({
      launchOpen: true,
      activeLaunchAgentId: agentId ?? null,
      launchPreset: preset ?? null,
    })
  },
  closeLaunchShelf: () =>
    set({ launchOpen: false, activeLaunchAgentId: null, launchPreset: null }),
}))

/** User-facing new-session entry point: opens the launch popover. */
export function requestAgentLaunch(request: AgentLaunchRequestSeed): void {
  useAgentLaunchStore.getState().requestLaunch(request)
  const agent = request.preferredAgentType ?? "claude"
  useStatusBarLaunchStore.getState().openLaunchShelf(agent)
}
