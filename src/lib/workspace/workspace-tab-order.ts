import {
  workspaceTabDefinition,
  type WorkspaceTabSection,
} from "@/lib/workspace/workspace-tab-registry"
import {
  workspaceTabKey,
  type WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"

export const WORKSPACE_TAB_ORDER_STATE_KEY = "berth:workspace-tab-order:v1"

export type WorkspaceTabOrderByScope = Record<string, string[]>

export interface OrderedWorkspaceTab {
  ref: WorkspaceTabRef
  key: string
  section: WorkspaceTabSection
}

export function orderedWorkspaceTab(ref: WorkspaceTabRef): OrderedWorkspaceTab {
  const type =
    ref.type ??
    (ref.kind === "primary"
      ? "terminal"
      : ref.kind === "file"
        ? "file"
        : "global")
  const definition = workspaceTabDefinition(type)
  if (definition.collection !== ref.kind) {
    throw new Error(
      `Workspace tab type ${type} cannot use ${ref.kind} collection`
    )
  }
  return {
    ref,
    key: workspaceTabKey(ref),
    section: definition.section,
  }
}

/**
 * Reconcile persisted order with the currently open tabs in O(n). Global tabs
 * stay ahead of regular tabs; existing relative order survives restoration and
 * newly opened tabs append to their section.
 */
export function reconcileWorkspaceTabOrder(
  previousKeys: readonly string[],
  openRefs: readonly WorkspaceTabRef[]
): OrderedWorkspaceTab[] {
  const openByKey = new Map(
    openRefs.map((ref) => {
      const entry = orderedWorkspaceTab(ref)
      return [entry.key, entry] as const
    })
  )
  const seen = new Set<string>()
  const restored: OrderedWorkspaceTab[] = []

  for (const key of previousKeys) {
    const entry = openByKey.get(key)
    if (!entry || seen.has(key)) continue
    seen.add(key)
    restored.push(entry)
  }
  for (const ref of openRefs) {
    const entry = orderedWorkspaceTab(ref)
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    restored.push(entry)
  }

  const global: OrderedWorkspaceTab[] = []
  const regular: OrderedWorkspaceTab[] = []
  for (const entry of restored) {
    if (entry.section === "global") global.push(entry)
    else regular.push(entry)
  }
  return [...global, ...regular]
}

export function mergeWorkspacePaneOrder(
  allRefs: readonly WorkspaceTabRef[],
  paneRefs: readonly WorkspaceTabRef[],
  reorderedPaneRefs: readonly WorkspaceTabRef[]
): WorkspaceTabRef[] {
  const paneKeys = new Set(paneRefs.map(workspaceTabKey))
  const reorderedKeys = new Set(reorderedPaneRefs.map(workspaceTabKey))
  if (
    paneKeys.size !== paneRefs.length ||
    reorderedKeys.size !== reorderedPaneRefs.length ||
    paneKeys.size !== reorderedKeys.size ||
    [...paneKeys].some((key) => !reorderedKeys.has(key))
  ) {
    return [...allRefs]
  }

  let index = 0
  return allRefs.map((ref) =>
    paneKeys.has(workspaceTabKey(ref))
      ? (reorderedPaneRefs[index++] ?? ref)
      : ref
  )
}

export function parseWorkspaceTabOrderState(
  raw: string | null
): WorkspaceTabOrderByScope {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const result: WorkspaceTabOrderByScope = {}
    for (const [scope, keys] of Object.entries(value)) {
      if (!Array.isArray(keys)) continue
      const validKeys = keys.filter(
        (key): key is string => typeof key === "string"
      )
      if (validKeys.length > 0) result[scope] = [...new Set(validKeys)]
    }
    return result
  } catch {
    return {}
  }
}

export function loadWorkspaceTabOrderState(): WorkspaceTabOrderByScope {
  if (typeof window === "undefined") return {}
  return parseWorkspaceTabOrderState(
    window.localStorage.getItem(WORKSPACE_TAB_ORDER_STATE_KEY)
  )
}
