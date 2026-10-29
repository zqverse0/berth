export type FolderWorkspacePane = "conversation" | "file"

export type FolderWorkspaceResume = {
  primaryTabId: string
  pane: FolderWorkspacePane
}

export type FolderWorkspaceActivation = {
  tabId: string | null
  pane: FolderWorkspacePane
}

export type FolderWorkspaceCloseActivation = {
  activeTabId: string | null
}

type ResumeTab = {
  id: string
  folderId: number | null
  kind: string
}

/**
 * 进入一个项目时选哪张 tab：优先上次停留的 tab，其次当前激活 tab，
 * 再退到该项目的第一张；项目没有 tab 时返回 null。
 */
export function resolveFolderWorkspaceActivation(input: {
  folderId: number
  resume: FolderWorkspaceResume | null
  rawTabs: readonly ResumeTab[]
  activeTabId?: string | null
}): FolderWorkspaceActivation {
  const pane = input.resume?.pane ?? "conversation"
  const scope = input.rawTabs.filter((tab) => tab.folderId === input.folderId)

  if (input.resume) {
    const hit = scope.find((tab) => tab.id === input.resume!.primaryTabId)
    if (hit) {
      return { tabId: hit.id, pane }
    }
  }

  if (
    input.activeTabId != null &&
    scope.some((tab) => tab.id === input.activeTabId)
  ) {
    return {
      tabId: input.activeTabId,
      pane,
    }
  }

  if (scope.length === 0) {
    return {
      tabId: null,
      pane: "conversation",
    }
  }

  return {
    tabId: scope[0]?.id ?? null,
    pane,
  }
}

/**
 * 关掉一张 tab 后，只在同一项目里选下一张。
 * `closingIndexInFolder` 是关闭前该项目 tab 列表里的下标。
 */
export function resolveCloseTabActivation(input: {
  remainingInFolder: readonly ResumeTab[]
  closingIndexInFolder: number
}): FolderWorkspaceCloseActivation {
  const remaining = input.remainingInFolder
  if (remaining.length === 0) {
    return { activeTabId: null }
  }
  const index = Math.min(
    Math.max(input.closingIndexInFolder, 0),
    remaining.length - 1
  )
  return {
    activeTabId: remaining[index]?.id ?? remaining[0]?.id ?? null,
  }
}

/**
 * 当前项目里选一张可见 tab。preferred 不属于该项目时直接丢掉，
 * 绝不跨项目回退。
 */
export function pickTabInFolder(
  tabs: readonly ResumeTab[],
  folderId: number | null,
  preferredId?: string | null
): string | null {
  const scope =
    folderId == null ? tabs : tabs.filter((tab) => tab.folderId === folderId)
  if (preferredId != null && scope.some((tab) => tab.id === preferredId)) {
    return preferredId
  }
  return scope[0]?.id ?? null
}
