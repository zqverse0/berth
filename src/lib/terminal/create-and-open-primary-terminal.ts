import { toast } from "@/lib/notify"
import {
  createTerminalSession,
  getRuntimeCapabilities,
  getSystemTerminalSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { TerminalTab } from "@/lib/workspace/primary-tabs"
import { readableTerminalTitle } from "@/lib/terminal/readable-terminal-title"
import type { AgentType, JsonValue, TerminalDescriptor } from "@/lib/types"
import { useTabStore } from "@/stores/tab-store"
import { refreshTerminalInventory } from "@/lib/terminal/terminal-inventory-query"

export type CreateAndOpenPrimaryTerminalInput = {
  cwd: string
  title?: string
  shell?: string | null
  folderId?: number | null
  /** Marks the terminal as an Agent CLI session. */
  agentType?: AgentType | null
  initialCommand?: string | null
  /** Structured managed command. Prefer this over initialCommand for presets. */
  executable?: string | null
  args?: string[]
  env?: Record<string, string>
  /** 文件定义 Agent 的 id；后端会在启动前重新读取契约。 */
  agentContractId?: string | null
  /** 根据启动前重新读取的 Agent 契约解析的模式 id。 */
  agentModeId?: string | null
  /** Berth 偏好持有的临时结构化 argv，不写回契约文件。 */
  agentExtraArgs?: string[]
  /** Typed values for normalized runtime capabilities. */
  agentCapabilityValues?: Record<string, JsonValue>
  /** 启动栏选择值；有 launch.js 时原样传给启动脚本。 */
  agentLaunchInputs?: Record<string, JsonValue>
  providerId?: number | null
  modelId?: string | null
  launchSource?:
    | { kind: "shell" }
    | { kind: "managed-command"; commandId: number }
  /** Default true — switch the primary workspace to the new terminal tab. */
  activate?: boolean
  rows?: number
  cols?: number
  /**
   * When true (default), refuse create if the runtime lacks personal-terminal
   * capabilities. Pass false only for tests that mock create directly.
   */
  requireCapabilities?: boolean
}

export type CreateAndOpenPrimaryTerminalResult = {
  terminalId: string | null
  /** Set when create was blocked because the backend lacks personal terminal. */
  capabilityBlocked?: boolean
  /** Set when PTY was created but opening/saving its primary tab failed. */
  tabOpenFailed?: boolean
}

/**
 * Build a personal-console primary TerminalTab from a session descriptor.
 * Id format is stable: `terminal:${terminalId}`.
 */
export function tabFromDescriptor(
  desc: TerminalDescriptor,
  overrides?: Partial<
    Pick<
      TerminalTab,
      | "title"
      | "isPinned"
      | "folderId"
      | "detachedFolderLabel"
      | "detachedFolderPath"
      | "agentType"
    >
  >
): TerminalTab {
  const folderId =
    overrides?.folderId !== undefined ? overrides.folderId : desc.folderId
  const title = readableTerminalTitle({
    title: overrides?.title?.trim() || desc.title,
    shell: desc.shell,
    initialCwd: desc.initialCwd,
    terminalId: desc.terminalId,
  })
  return {
    kind: "terminal",
    id: `terminal:${desc.terminalId}`,
    terminalId: desc.terminalId,
    backendInstanceId: desc.backendInstanceId,
    folderId,
    launchSource: { kind: "shell" },
    agentType: overrides?.agentType ?? null,
    title,
    initialCwd: desc.initialCwd,
    shell: desc.shell,
    detachedFolderLabel: overrides?.detachedFolderLabel ?? null,
    detachedFolderPath:
      overrides?.detachedFolderPath ??
      (folderId == null ? desc.initialCwd || null : null),
    isPinned: overrides?.isPinned ?? false,
  }
}

/** 切到这个终端的 tab；还没有 tab 就打开一个。 */
export function focusTerminalTab(desc: TerminalDescriptor): void {
  const tabs = useTabStore.getState()
  const tabId = `terminal:${desc.terminalId}`
  if (tabs.rawTabs.some((item) => item.id === tabId)) tabs.switchTab(tabId)
  else tabs.openTerminalTab(tabFromDescriptor(desc), true)
}

/**
 * 将 daemon descriptor 映射为 Tab；调用方可显式传入 UI display scope。
 *
 * cwd 和当前项目只是显示上下文，不能建立 daemon 归属；无归属 CLI 终端即使
 * cwd 位于某个项目目录下，也必须继续保持无归属。
 */
export function detachedTerminalScopeFolderId(
  _cwd: string | null | undefined,
  folders: ReadonlyMap<number, { path: string }>,
  ownFolderId: number | null,
  _activeFolderId: number | null
): number | null {
  void _cwd
  void _activeFolderId
  // daemon 的 folderId 只有仍存在于当前项目列表时才可作为 UI scope。
  // 已删除项目不回落到 cwd/当前项目，否则会伪造项目归属；调用方会把它
  // 作为 detached terminal 显示并保持可操作。
  return ownFolderId != null && folders.has(ownFolderId) ? ownFolderId : null
}

/** True when both primary-tabs v2 and personal-terminal v2 are advertised. */
export function isPersonalTerminalCapable(caps: {
  primaryTabsV2: boolean
  personalTerminalV2: boolean
}): boolean {
  return caps.primaryTabsV2 && caps.personalTerminalV2
}

export async function ensurePersonalTerminalCapable(): Promise<boolean> {
  try {
    const caps = await getRuntimeCapabilities()
    return isPersonalTerminalCapable(caps)
  } catch {
    // Local desktop always returns both capabilities from compiled code; a
    // failure here is almost always a remote/web health probe problem.
    return false
  }
}

/**
 * Create an authoritative personal-console PTY, then open its primary tab.
 * The primary surface always uses the shared attach runtime.
 *
 * Order is intentional: PTY first, tab second. If tab CAS later fails elsewhere,
 * the session remains discoverable under the project session manager.
 */
export async function createAndOpenPrimaryTerminal(
  input: CreateAndOpenPrimaryTerminalInput
): Promise<string | null> {
  const result = await createAndOpenPrimaryTerminalDetailed(input)
  return result.terminalId
}

export async function createAndOpenPrimaryTerminalDetailed(
  input: CreateAndOpenPrimaryTerminalInput
): Promise<CreateAndOpenPrimaryTerminalResult> {
  const cwd = input.cwd?.trim()
  if (!cwd) return { terminalId: null }

  if (input.requireCapabilities !== false) {
    const ok = await ensurePersonalTerminalCapable()
    if (!ok) {
      return { terminalId: null, capabilityBlocked: true }
    }
  }

  let shell = input.shell ?? null
  if (shell == null || shell === "") {
    try {
      const settings = await getSystemTerminalSettings()
      shell = settings.default_shell
    } catch {
      shell = null
    }
  }

  // rows/cols: optional caller override, else a minimal API placeholder.
  // TerminalView FitAddon + resize aligns the PTY to the
  // conversation pane — same adaptive model as the agent area. Do not treat
  // 24×80 as a product default the user configures.
  const desc = await createTerminalSession({
    cwd,
    shell,
    initialCommand: input.initialCommand ?? null,
    executable: input.executable ?? null,
    args: input.args ?? [],
    env: input.env ?? {},
    ...(input.agentContractId
      ? {
          agentId: input.agentContractId,
          agentModeId: input.agentModeId ?? null,
          agentExtraArgs: input.agentExtraArgs ?? [],
          agentCapabilityValues: input.agentCapabilityValues ?? {},
          agentLaunchInputs: input.agentLaunchInputs ?? null,
          providerId: input.providerId ?? null,
          modelId: input.modelId ?? null,
        }
      : {}),
    folderId: input.folderId ?? null,
    rows: input.rows ?? 24,
    cols: input.cols ?? 80,
  })

  const tab = tabFromDescriptor(desc, {
    title: input.title?.trim() || desc.title || "Terminal",
    agentType: input.agentType ?? null,
  })
  tab.launchSource = input.launchSource ?? { kind: "shell" }
  tab.lastKnownCwd = desc.initialCwd || cwd
  // Prefer descriptor folderId; fall back to the request when the backend omits it.
  if (tab.folderId == null && input.folderId != null) {
    tab.folderId = input.folderId
  }
  if (tab.folderId == null && !tab.detachedFolderPath) {
    // 无项目终端必须能在任意当前项目下继续显示；路径只是显示上下文，
    // 不是新的项目归属。
    tab.detachedFolderPath = tab.initialCwd || cwd
  }
  if (!tab.initialCwd) {
    tab.initialCwd = cwd
  }
  if (!tab.shell && shell) {
    tab.shell = shell
  }

  try {
    useTabStore.getState().openTerminalTab(tab, input.activate !== false)
    void refreshTerminalInventory().catch(() => {
      // The newly-created tab remains usable; the shared fallback poll retries
      // inventory convergence if terminald becomes transiently unavailable.
    })
  } catch {
    return {
      terminalId: desc.terminalId,
      tabOpenFailed: true,
    }
  }

  return { terminalId: desc.terminalId }
}

/** 项目入口直接建终端并打开 tab，不经过项目管理页。 */
export async function createAndOpenFolderTerminal(
  input: { cwd: string; folderId: number },
  t: (key: "createFailed" | "upgradeRequired" | "casConflictHint") => string
): Promise<void> {
  try {
    const result = await createAndOpenPrimaryTerminalDetailed({
      cwd: input.cwd,
      folderId: input.folderId,
      activate: true,
    })
    if (result.capabilityBlocked) {
      toast.error(t("upgradeRequired"))
      return
    }
    if (!result.terminalId) {
      toast.error(t("createFailed"))
      return
    }
    if (result.tabOpenFailed) toast.message(t("casConflictHint"))
  } catch (error) {
    toast.error(t("createFailed"), { description: toErrorMessage(error) })
  }
}

/** Workspace deep-link path for a terminal; credentials stay out of the URL. */
export function terminalSharePath(terminalId: string): string {
  const id = encodeURIComponent(terminalId)
  return `/workspace?terminalId=${id}`
}
