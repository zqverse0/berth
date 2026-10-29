import type { WorkspaceTabPlacement } from "@/lib/workspace/workspace-tab-placement"

export const WORKSPACE_TAB_PLACEMENT_STATE_KEY =
  "berth:workspace-tab-placement:v1"

export const GLOBAL_WORKSPACE_PLACEMENT_SCOPE = "global"

export type WorkspaceTabPlacementByScope = Record<string, WorkspaceTabPlacement>

interface PersistedWorkspaceTabPlacementState {
  version: 1
  scopes: WorkspaceTabPlacementByScope
}

export function workspacePlacementScope(folderId: number | null): string {
  return folderId == null
    ? GLOBAL_WORKSPACE_PLACEMENT_SCOPE
    : `folder:${folderId}`
}

export function parseWorkspaceTabPlacementState(
  raw: string | null
): WorkspaceTabPlacementByScope {
  if (!raw) return {}

  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return {}
    }

    const scopes = (parsed as { scopes?: unknown }).scopes
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
      return {}
    }

    const next: WorkspaceTabPlacementByScope = {}
    for (const [scope, placement] of Object.entries(scopes)) {
      if (
        !placement ||
        typeof placement !== "object" ||
        Array.isArray(placement)
      ) {
        continue
      }
      const validPlacement: WorkspaceTabPlacement = {}
      for (const [key, pane] of Object.entries(placement)) {
        if (
          (key.startsWith("primary:") || key.startsWith("file:")) &&
          (pane === "conversation" ||
            pane === "files" ||
            pane === "files-split")
        ) {
          validPlacement[key] = pane
        }
      }
      if (Object.keys(validPlacement).length > 0) next[scope] = validPlacement
    }
    return next
  } catch {
    return {}
  }
}

export function serializeWorkspaceTabPlacementState(
  scopes: Readonly<WorkspaceTabPlacementByScope>
): string {
  const state: PersistedWorkspaceTabPlacementState = {
    version: 1,
    scopes: { ...scopes },
  }
  return JSON.stringify(state)
}

export function loadWorkspaceTabPlacementState(): WorkspaceTabPlacementByScope {
  if (typeof window === "undefined") return {}
  try {
    return parseWorkspaceTabPlacementState(
      window.localStorage.getItem(WORKSPACE_TAB_PLACEMENT_STATE_KEY)
    )
  } catch {
    return {}
  }
}
