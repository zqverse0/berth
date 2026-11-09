import {
  paneDot,
  paneFolderId,
  type AgentPaneRow,
  type SeenAttention,
} from "@/lib/terminal/agent-panes"
import { parseDeviceFolderId } from "@/lib/transport/device"
import type { TerminalDescriptor } from "@/lib/types"
import type { SectionSession } from "./workspace-sections"

/** 侧栏一行会话：已打开的 tab，或 termd 里运行中、还没 tab 的终端。 */
export interface SidebarSession extends SectionSession {
  title: string
  /** Agent 图标；普通终端为 null。 */
  agentType: string | null
  tabId: string | null
  /** 没有 tab 的终端：点击时据此打开。 */
  descriptor: TerminalDescriptor | null
  /** 需关注时 Agent 的最近一条通知（悬停显示）。 */
  notification: string | null
}

/** tab 条目里会话用到的字段（对话与终端 tab）。 */
export interface SessionTab {
  id: string
  kind: string
  folderId: number | null
  title?: string
  agentType?: string | null
  terminalId?: string
}

function lastSegment(path: string | null | undefined): string {
  return path?.replace(/\/+$/, "").split("/").pop() ?? ""
}

/**
 * 会话标题：终端标题（Agent 会把会话主题写进去）→ tab 标题（自动起的「Agent · 项目」）→ 前台命令 → 所在目录末段。
 * ponytail: Agent 原生会话标题 / 第一条用户消息要终端 → 会话的绑定，目前只有群成员有，补上只读查询后接在最前。
 */
export function sessionTitle(
  tabTitle: string | null | undefined,
  descriptor: TerminalDescriptor | null
): string {
  const shell = lastSegment(descriptor?.shell)
  const command = descriptor?.foregroundCommand?.trim()
  return (
    descriptor?.title?.trim() ||
    tabTitle?.trim() ||
    (command && command !== shell ? command : "") ||
    lastSegment(descriptor?.cwd || descriptor?.initialCwd) ||
    "Terminal"
  )
}

/** 项目所在设备：对方项目的 id 是负数（`transport/device.ts`），本机为 0。 */
function deviceOf(folderId: number | null): number {
  return folderId == null ? 0 : (parseDeviceFolderId(folderId)?.deviceId ?? 0)
}

/**
 * 全部会话，一行一个：终端以 termd 清单为准，按所在目录挂到最深的项目 / worktree；
 * 清单里还没有的 tab（首轮未到、对话 tab）按 tab 显示。项目已不在列表里的终端 `folderId` 为 null（未归属）。
 * `detachedDevice` 给出未归属终端所在的设备（从设备开的 SSH 终端等），默认本机 0。
 */
export function buildSidebarSessions(input: {
  tabs: readonly SessionTab[]
  /** termd 清单（agent panes 优先，带状态） */
  panes: readonly AgentPaneRow[]
  inventory: readonly TerminalDescriptor[]
  folders: readonly { id: number; path: string }[]
  seen: SeenAttention
  detachedDevice: (descriptor: TerminalDescriptor) => number
}): SidebarSession[] {
  const { tabs, panes, inventory, folders, seen, detachedDevice } = input
  const known = new Set(folders.map((folder) => folder.id))
  const rows = new Map<string, AgentPaneRow | null>()
  for (const row of panes) rows.set(row.descriptor.terminalId, row)
  for (const descriptor of inventory)
    if (!rows.has(descriptor.terminalId)) rows.set(descriptor.terminalId, null)
  const descriptors = new Map<string, TerminalDescriptor>()
  for (const row of panes)
    descriptors.set(row.descriptor.terminalId, row.descriptor)
  for (const descriptor of inventory)
    if (!descriptors.has(descriptor.terminalId))
      descriptors.set(descriptor.terminalId, descriptor)

  const sessions: SidebarSession[] = []
  const listed = new Set<string>()
  for (const [terminalId, descriptor] of descriptors) {
    if (descriptor.status !== "running") continue
    listed.add(terminalId)
    const tab = tabs.find(
      (item) => item.kind === "terminal" && item.terminalId === terminalId
    )
    // 自己的项目已不在列表里：未归属，不按 cwd 另找项目
    const folderId =
      descriptor.folderId != null && known.has(descriptor.folderId)
        ? paneFolderId(descriptor, folders)
        : null
    const row = rows.get(terminalId)
    const notification =
      row?.state === "attention"
        ? (descriptor.agentSignal?.notification ?? null)
        : null
    sessions.push({
      id: tab?.id ?? `terminal:${terminalId}`,
      device:
        folderId == null ? detachedDevice(descriptor) : deviceOf(folderId),
      folderId,
      dot: row && descriptor.agentId ? paneDot(row, seen) : null,
      title: sessionTitle(tab?.title, descriptor),
      agentType: descriptor.agentId ?? tab?.agentType ?? null,
      tabId: tab?.id ?? null,
      descriptor: tab ? null : descriptor,
      notification,
    })
  }
  for (const tab of tabs) {
    if (tab.kind !== "conversation" && tab.kind !== "terminal") continue
    if (tab.kind === "terminal" && listed.has(tab.terminalId ?? "")) continue
    const folderId =
      tab.folderId != null && known.has(tab.folderId) ? tab.folderId : null
    sessions.push({
      id: tab.id,
      device: deviceOf(folderId),
      folderId,
      dot: null,
      title:
        tab.title?.trim() ||
        (tab.kind === "terminal" ? "Terminal" : "Conversation"),
      agentType: tab.agentType || null,
      tabId: tab.id,
      descriptor: null,
      notification: null,
    })
  }
  return sessions
}

/**
 * 会话切换器的顺序：最近用过的在前（当前这个排在最后——要的是「上一个」），其后为需关注 / 工作中的，
 * 再后为其余的。`recent` 为最近激活的 tab id，新的在前。
 */
export function switcherOrder<
  S extends { tabId: string | null; dot: SectionSession["dot"] },
>(
  sessions: readonly S[],
  recent: readonly string[],
  activeTabId: string | null
): S[] {
  const rank = (session: S) => {
    if (session.tabId != null && session.tabId === activeTabId)
      return Number.MAX_SAFE_INTEGER
    const at = session.tabId == null ? -1 : recent.indexOf(session.tabId)
    if (at >= 0) return at
    return recent.length + (session.dot ? 0 : 1)
  }
  return [...sessions].sort((a, b) => rank(a) - rank(b))
}
