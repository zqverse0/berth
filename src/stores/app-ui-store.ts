import { create } from "zustand"
import type { FixActionKind } from "@/lib/types"
import type { PersistedPanelState } from "@/lib/workspace/panel-state-storage"

/** `info`：操作结果等普通提示，不把告警按钮标红。 */
export type AlertLevel = "error" | "warning" | "info"

/** 可序列化的修复动作（来自后端），或前端提示自带的回调。 */
export type AlertAction =
  | { label: string; kind: FixActionKind; payload: string }
  | { label: string; run: () => void }

export interface Alert {
  id: string
  level: AlertLevel
  message: string
  detail?: string
  actions?: AlertAction[]
  timestamp: number
}

export type TaskStatus = "pending" | "running" | "completed" | "failed"

export interface Task {
  id: string
  label: string
  description?: string
  status: TaskStatus
  progress?: number
  error?: string
}

export const APP_UI_DEFAULTS = {
  sidebarWidth: 240,
  sidebarMinWidth: 180,
  sidebarMaxWidth: 900,
  sidebarOpen: true,
  auxPanelWidth: 480,
  auxPanelMinWidth: 360,
  auxPanelMaxWidth: 900,
  auxPanelOpen: true,
} as const

const MAX_ALERTS = 50
let alertSequence = 0

function clampWidth(width: number, minWidth: number) {
  return Math.max(minWidth, Math.min(APP_UI_DEFAULTS.auxPanelMaxWidth, width))
}

function clampSidebarWidth(width: number) {
  return Math.max(
    APP_UI_DEFAULTS.sidebarMinWidth,
    Math.min(APP_UI_DEFAULTS.sidebarMaxWidth, width)
  )
}

export type AuxView = "group" | "terminals"

export interface AppUiStore {
  alerts: Alert[]
  tasks: Task[]
  focusRequest: number

  sidebarOpen: boolean
  sidebarRestored: boolean
  sidebarWidth: number
  sidebarMinWidth: number
  sidebarMaxWidth: number

  auxPanelOpen: boolean
  auxPanelRestored: boolean
  /** 辅助面板显示当前项目的群组，还是终端 tab 组。 */
  auxView: AuxView
  auxPanelWidth: number
  auxPanelMinWidth: number
  auxPanelMaxWidth: number
  pendingRevealPath: string | null

  pushAlert: (
    level: AlertLevel,
    message: string,
    detail?: string,
    actions?: AlertAction[]
  ) => string
  dismissAlert: (id: string) => void
  clearAlerts: () => void

  addTask: (id: string, label: string, description?: string) => void
  updateTask: (
    id: string,
    update: Partial<Pick<Task, "status" | "progress" | "error">>
  ) => void
  removeTask: (id: string) => void
  clearCompletedTasks: () => void

  requestSearchFocus: () => void
  focusProjectFileSearch: (query: string) => void
  consumeProjectFileSearch: () => void

  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  hydrateSidebar: (
    persisted: PersistedPanelState | null,
    isMobile: boolean
  ) => void

  toggleAuxPanel: () => void
  setAuxPanelOpen: (open: boolean) => void
  /** 切换辅助面板视图并展开面板。 */
  showAuxView: (view: AuxView) => void
  setAuxPanelWidth: (width: number) => void
  setAuxPanelMinWidth: (minWidth: number) => void
  hydrateAuxPanel: (
    persisted: PersistedPanelState | null,
    isMobile: boolean
  ) => void
  revealInFileTree: (path: string) => void
  consumePendingRevealPath: () => void
  resetPendingReveal: () => void

  resetAppUi: () => void

  projectFileSearchQuery: string | null
  projectFileSearchRequest: number
  /** 叫出项目首页时中间组激活的 tab（无 tab 为 ""）；激活 tab 一变首页就让位。null = 未叫出。 */
  projectHomeOver: string | null
}

const INITIAL_STATE = {
  alerts: [],
  tasks: [],
  focusRequest: 0,
  projectFileSearchQuery: null,
  projectFileSearchRequest: 0,
  projectHomeOver: null,
  sidebarOpen: APP_UI_DEFAULTS.sidebarOpen,
  sidebarRestored: false,
  sidebarWidth: APP_UI_DEFAULTS.sidebarWidth,
  sidebarMinWidth: APP_UI_DEFAULTS.sidebarMinWidth,
  sidebarMaxWidth: APP_UI_DEFAULTS.sidebarMaxWidth,
  auxPanelOpen: APP_UI_DEFAULTS.auxPanelOpen,
  auxPanelRestored: false,
  auxView: "group" as AuxView,
  auxPanelWidth: APP_UI_DEFAULTS.auxPanelWidth,
  auxPanelMinWidth: APP_UI_DEFAULTS.auxPanelMinWidth,
  auxPanelMaxWidth: APP_UI_DEFAULTS.auxPanelMaxWidth,
  pendingRevealPath: null,
} satisfies Omit<
  AppUiStore,
  | "pushAlert"
  | "dismissAlert"
  | "clearAlerts"
  | "addTask"
  | "updateTask"
  | "removeTask"
  | "clearCompletedTasks"
  | "requestSearchFocus"
  | "toggleSidebar"
  | "setSidebarWidth"
  | "hydrateSidebar"
  | "toggleAuxPanel"
  | "setAuxPanelOpen"
  | "showAuxView"
  | "setAuxPanelWidth"
  | "setAuxPanelMinWidth"
  | "hydrateAuxPanel"
  | "revealInFileTree"
  | "consumePendingRevealPath"
  | "resetPendingReveal"
  | "resetAppUi"
  | "focusProjectFileSearch"
  | "consumeProjectFileSearch"
>

export const useAppUiStore = create<AppUiStore>((set) => ({
  ...INITIAL_STATE,

  pushAlert: (level, message, detail, actions) => {
    const now = Date.now()
    const alert: Alert = {
      id: `alert-${++alertSequence}-${now}`,
      level,
      message,
      detail,
      actions,
      timestamp: now,
    }
    set((state) => ({
      alerts: [...state.alerts, alert].slice(-MAX_ALERTS),
    }))
    return alert.id
  },
  dismissAlert: (id) =>
    set((state) => ({
      alerts: state.alerts.filter((alert) => alert.id !== id),
    })),
  clearAlerts: () => set({ alerts: [] }),

  addTask: (id, label, description) =>
    set((state) => ({
      tasks: [
        ...state.tasks,
        { id, label, description, status: "pending" as const },
      ],
    })),
  updateTask: (id, update) => {
    if (update.status === "completed" || update.status === "failed") {
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }))
      return
    }
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id ? { ...task, ...update } : task
      ),
    }))
  },
  removeTask: (id) =>
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) })),
  clearCompletedTasks: () =>
    set((state) => ({
      tasks: state.tasks.filter(
        (task) => task.status !== "completed" && task.status !== "failed"
      ),
    })),

  requestSearchFocus: () =>
    set((state) => ({ focusRequest: state.focusRequest + 1 })),
  focusProjectFileSearch: (query: string) =>
    set((state) => ({
      sidebarOpen: true,
      projectFileSearchQuery: query,
      projectFileSearchRequest: state.projectFileSearchRequest + 1,
    })),
  consumeProjectFileSearch: () =>
    set({
      projectFileSearchQuery: null,
    }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  hydrateSidebar: (persisted, isMobile) =>
    set({
      sidebarOpen: isMobile
        ? false
        : (persisted?.isOpen ?? APP_UI_DEFAULTS.sidebarOpen),
      sidebarWidth: clampSidebarWidth(
        persisted?.width ?? APP_UI_DEFAULTS.sidebarWidth
      ),
      sidebarRestored: true,
    }),

  toggleAuxPanel: () =>
    set((state) => ({
      auxPanelOpen: !state.auxPanelOpen,
    })),
  setAuxPanelOpen: (open) =>
    set({
      auxPanelOpen: open,
    }),
  showAuxView: (view) => set({ auxView: view, auxPanelOpen: true }),
  setAuxPanelWidth: (width) =>
    set((state) => ({
      auxPanelWidth: clampWidth(width, state.auxPanelMinWidth),
    })),
  setAuxPanelMinWidth: (minWidth) =>
    set((state) => ({
      auxPanelMinWidth: minWidth,
      auxPanelWidth: clampWidth(state.auxPanelWidth, minWidth),
    })),
  hydrateAuxPanel: (persisted, isMobile) =>
    set((state) => ({
      auxPanelOpen: isMobile
        ? false
        : (persisted?.isOpen ?? APP_UI_DEFAULTS.auxPanelOpen),
      auxPanelWidth: clampWidth(
        persisted?.width ?? APP_UI_DEFAULTS.auxPanelWidth,
        state.auxPanelMinWidth
      ),
      auxPanelRestored: true,
    })),
  // The sidebar switches to the files view while a reveal is pending.
  revealInFileTree: (path) =>
    set({ pendingRevealPath: path, sidebarOpen: true }),
  consumePendingRevealPath: () => set({ pendingRevealPath: null }),
  resetPendingReveal: () => set({ pendingRevealPath: null }),

  resetAppUi: () => set({ ...INITIAL_STATE }),
}))
