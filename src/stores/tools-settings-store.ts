import { create } from "zustand"
import {
  checkToolUpdate,
  getPreviewToolStatus,
  installPreviewTool,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getTransport } from "@/lib/transport"
import type {
  PreviewInstallEvent,
  PreviewToolInfo,
  ToolUpdateCheck,
} from "@/lib/types"

/** 一次运行内的“最新版本”查询结果；null = 插件没声明 latest。 */
export type UpdateCheckEntry = ToolUpdateCheck | null | { error: string }

/** 插件声明的程序检测结果；null = 插件没声明 org.berth.install。 */
export type ProgramEntry = PreviewToolInfo | null | { error: string }

/** 进行中或刚失败的安装 / 更新。 */
export interface InstallRun {
  running: boolean
  /** 安装脚本最近一行输出。 */
  log: string | null
  error: string | null
}

const IDLE_RUN: InstallRun = { running: false, log: null, error: null }

/**
 * 设置 → 工具 页当前选中的插件，以及各插件程序的检测 / 更新缓存。放在页面外：
 * 命令（如“Git 与 GitHub 账号”）能先选中再打开页面；列表、详情、启动栏共用一份结果。
 */
export const useToolsSettingsStore = create<{
  selectedToolId: string | null
  selectTool: (id: string | null) => void
  programs: Record<string, ProgramEntry>
  setProgram: (id: string, entry: ProgramEntry) => void
  /** 本地检测（跑一次 `--version`），刷新时重跑。 */
  loadProgram: (id: string) => Promise<void>
  /** 按插件缓存，避免每次切换都联网；更新后清掉对应项重查。 */
  updateChecks: Record<string, UpdateCheckEntry>
  setUpdateCheck: (id: string, entry: UpdateCheckEntry | undefined) => void
  checkUpdate: (id: string) => Promise<void>
  installs: Record<string, InstallRun>
  /** 安装（运行包内脚本）或更新（程序自带命令，没有时退回脚本）；完成后重查最新版本。 */
  runInstall: (id: string, update: boolean) => Promise<void>
}>((set, get) => ({
  selectedToolId: null,
  selectTool: (id) => set({ selectedToolId: id }),
  programs: {},
  setProgram: (id, entry) =>
    set((state) => ({ programs: { ...state.programs, [id]: entry } })),
  loadProgram: async (id) => {
    let entry: ProgramEntry
    try {
      entry = await getPreviewToolStatus(id)
    } catch (cause) {
      entry = { error: toErrorMessage(cause) }
    }
    get().setProgram(id, entry)
  },
  updateChecks: {},
  setUpdateCheck: (id, entry) =>
    set((state) => {
      const updateChecks = { ...state.updateChecks }
      if (entry === undefined) delete updateChecks[id]
      else updateChecks[id] = entry
      return { updateChecks }
    }),
  checkUpdate: async (id) => {
    let entry: UpdateCheckEntry
    try {
      entry = await checkToolUpdate(id)
    } catch (cause) {
      entry = { error: toErrorMessage(cause) }
    }
    get().setUpdateCheck(id, entry)
  },
  installs: {},
  runInstall: async (id, update) => {
    if (get().installs[id]?.running) return
    const patch = (run: Partial<InstallRun>) =>
      set((state) => ({
        installs: {
          ...state.installs,
          [id]: { ...(state.installs[id] ?? IDLE_RUN), ...run },
        },
      }))
    const taskId = crypto.randomUUID()
    patch({ running: true, log: null, error: null })
    const unsubscribe = await getTransport()
      .subscribe<PreviewInstallEvent>("app://preview-tool-install", (event) => {
        if (event.task_id === taskId && event.payload)
          patch({ log: event.payload })
      })
      .catch(() => null)
    try {
      get().setProgram(id, await installPreviewTool(taskId, "", id, update))
      get().setUpdateCheck(id, undefined)
      patch({ running: false, log: null })
    } catch (cause) {
      patch({ running: false, error: toErrorMessage(cause) })
    } finally {
      unsubscribe?.()
    }
  },
}))

/** 程序已装且能跑。 */
export function programReady(entry: ProgramEntry | undefined): boolean {
  return (
    !!entry && !("error" in entry) && entry.installed && !entry.runtimeError
  )
}

/**
 * Git 程序检测与 GitHub / Git 服务器账号显示在这个插件的详情里。账号是 Berth
 * 自己的（git 凭据助手、发现页），gh 不读；停用或删掉该插件后这里就没有入口了。
 */
// ponytail: 写死一个插件 id；第二个插件也要挂宿主设置时，改成插件声明的接入点。
export const GIT_ACCOUNTS_TOOL_ID = "gh"
