import {
  workspaceTabKey,
  type WorkspacePane,
  type WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"

export const WORKSPACE_PANES: readonly WorkspacePane[] = [
  "files",
  "files-split",
  "conversation",
]

export function workspaceTabRefEqual(
  left: WorkspaceTabRef | null,
  right: WorkspaceTabRef | null
): boolean {
  return left?.kind === right?.kind && left?.id === right?.id
}

export function reconcilePaneActiveTab(
  remembered: WorkspaceTabRef | null,
  tabs: readonly WorkspaceTabRef[]
): WorkspaceTabRef | null {
  if (
    remembered &&
    tabs.some((tab) => workspaceTabKey(tab) === workspaceTabKey(remembered))
  ) {
    return remembered
  }
  return tabs[0] ?? null
}
