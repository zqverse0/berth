/**
 * 侧栏工作区：按用途给项目分组（runtime bridge `workspaceGroups.*`，后端 `src-tauri/src/workspace_groups.rs`）。
 *
 * 工作区是本机客户端的分组：归属按（设备, root 项目路径）记在数据目录的 `workspace-groups.json`，
 * 不进项目数据、不同步。worktree 跟着 root，不单独记；没登记的项目算「默认」工作区。
 * 代码里「workspace」已被布局占用，标识符一律用 `workspaceGroups`，界面文案仍叫「工作区」。
 */
import { create } from "zustand"
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"

export interface WorkspaceGroup {
  id: string
  name: string
  emoji: string | null
  /** 「默认」工作区：可改名、不可删除，是没登记项目的兜底。 */
  isDefault: boolean
}

/** 一个 root 项目的归属：`device` 本机为 0，其他为设备 id。 */
export interface WorkspaceMember {
  device: number
  path: string
  groupId: string
}

export interface WorkspaceGroupsState {
  version: 1
  /** 顺序即显示顺序 */
  groups: WorkspaceGroup[]
  members: WorkspaceMember[]
}

export type WorkspaceNameError = "empty" | "duplicate"

const DEFAULT_ID = "default"

/**
 * 读到的文件 → 可用状态。没有文件（或坏文件，后端已改名留存）时建「默认」工作区，
 * 全部项目因没登记而落在其中（首次升级迁移）；始终保证恰有一个「默认」，指向不存在工作区的成员丢掉。
 */
export function normalizeWorkspaceGroups(
  raw: WorkspaceGroupsState | null,
  defaultName: string
): WorkspaceGroupsState {
  const groups = (raw?.groups ?? []).map((group) => ({ ...group }))
  const defaults = groups.filter((group) => group.isDefault)
  if (defaults.length === 0) {
    groups.unshift({
      id: DEFAULT_ID,
      name: defaultName,
      emoji: null,
      isDefault: true,
    })
  }
  for (const extra of defaults.slice(1)) extra.isDefault = false
  const ids = new Set(groups.map((group) => group.id))
  const members = (raw?.members ?? []).filter((member) =>
    ids.has(member.groupId)
  )
  return { version: 1, groups, members }
}

export function defaultGroupId(state: WorkspaceGroupsState): string {
  return state.groups.find((group) => group.isDefault)!.id
}

/** 名称去掉首尾空白后不能为空、不能与其他工作区重名。 */
export function checkWorkspaceName(
  state: WorkspaceGroupsState,
  name: string,
  exceptId?: string
): WorkspaceNameError | null {
  const trimmed = name.trim()
  if (!trimmed) return "empty"
  const taken = state.groups.some(
    (group) => group.id !== exceptId && group.name === trimmed
  )
  return taken ? "duplicate" : null
}

export function createWorkspaceGroup(
  state: WorkspaceGroupsState,
  id: string,
  name: string,
  emoji: string | null
): WorkspaceGroupsState {
  return {
    ...state,
    groups: [
      ...state.groups,
      { id, name: name.trim(), emoji, isDefault: false },
    ],
  }
}

export function renameWorkspaceGroup(
  state: WorkspaceGroupsState,
  id: string,
  name: string,
  emoji: string | null
): WorkspaceGroupsState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === id ? { ...group, name: name.trim(), emoji } : group
    ),
  }
}

/** 删除工作区：其中项目回到「默认」（去掉登记即可），不移除项目。「默认」不可删。 */
export function removeWorkspaceGroup(
  state: WorkspaceGroupsState,
  id: string
): WorkspaceGroupsState {
  if (state.groups.find((group) => group.id === id)?.isDefault !== false)
    return state
  return {
    ...state,
    groups: state.groups.filter((group) => group.id !== id),
    members: state.members.filter((member) => member.groupId !== id),
  }
}

export function moveWorkspaceGroup(
  state: WorkspaceGroupsState,
  id: string,
  toIndex: number
): WorkspaceGroupsState {
  const from = state.groups.findIndex((group) => group.id === id)
  if (from < 0) return state
  const groups = [...state.groups]
  const [moved] = groups.splice(from, 1)
  groups.splice(Math.max(0, Math.min(toIndex, groups.length)), 0, moved)
  return { ...state, groups }
}

/** 把 root 项目移到工作区（移到「默认」即去掉登记）。worktree 不单独登记，跟着 root 走。 */
export function assignWorkspaceGroup(
  state: WorkspaceGroupsState,
  device: number,
  path: string,
  groupId: string
): WorkspaceGroupsState {
  const members = state.members.filter(
    (member) => member.device !== device || member.path !== path
  )
  if (groupId !== defaultGroupId(state)) members.push({ device, path, groupId })
  return { ...state, members }
}

export function workspaceGroupOf(
  state: WorkspaceGroupsState,
  device: number,
  path: string
): string {
  return (
    state.members.find(
      (member) => member.device === device && member.path === path
    )?.groupId ?? defaultGroupId(state)
  )
}

/**
 * 丢掉失效的登记：本机项目已从 Berth 移除（不在本机项目列表里）、设备已移除。
 * 设备项目只按设备是否还在判断——设备离线时拿不到它的项目列表，不能据此删登记。
 * 没有变化时返回原对象，调用方据此跳过写入。
 */
export function pruneWorkspaceMembers(
  state: WorkspaceGroupsState,
  localPaths: ReadonlySet<string>,
  deviceIds: ReadonlySet<number>
): WorkspaceGroupsState {
  const members = state.members.filter((member) =>
    member.device === 0
      ? localPaths.has(member.path)
      : deviceIds.has(member.device)
  )
  return members.length === state.members.length ? state : { ...state, members }
}

async function call<T>(method: string, params?: Record<string, unknown>) {
  const response = await runtimeBridgeOperation<T>({ method, params })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

export const getWorkspaceGroups = () =>
  call<WorkspaceGroupsState | null>("workspaceGroups.get")
export const setWorkspaceGroups = (state: WorkspaceGroupsState) =>
  call<null>("workspaceGroups.set", { state })

/** 工作区分组的唯一主人：读一次，之后每次改动整份写回。 */
export const useWorkspaceGroupsStore = create<{
  state: WorkspaceGroupsState | null
  /** `defaultName` 是首次迁移时「默认」工作区的名字（按界面语言）。 */
  load: (defaultName: string) => Promise<void>
  /** 改动并写回；写失败时回到改动前并抛出，由界面提示。 */
  update: (
    change: (state: WorkspaceGroupsState) => WorkspaceGroupsState
  ) => Promise<void>
}>((set, get) => ({
  state: null,
  load: async (defaultName) => {
    const raw = await getWorkspaceGroups()
    const state = normalizeWorkspaceGroups(raw, defaultName)
    set({ state })
    // 首次迁移（或修复了坏文件）时把「默认」写下来，名字从此不随界面语言变
    if (raw == null) await setWorkspaceGroups(state)
  },
  update: async (change) => {
    const before = get().state
    if (!before) return
    const after = change(before)
    if (after === before) return
    set({ state: after })
    try {
      await setWorkspaceGroups(after)
    } catch (error) {
      set({ state: before })
      throw error
    }
  },
}))
