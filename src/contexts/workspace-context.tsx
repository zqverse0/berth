"use client"

import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"

/**
 * Shim that re-exports workspace actions from the new store/hook architecture.
 * The original WorkspaceProvider was deleted in de3e0a429 but some files still
 * import these hooks. This provides backward-compatible access.
 */

export function useWorkspaceActions() {
  const activateConversationPane = useWorkspaceLayoutStore(
    (s) => s.activateConversationPane
  )
  const { openBranchDiff, openFilePreview, openWorkingTreeDiff } =
    useWorkspaceRuntimeActions()

  return {
    activateConversationPane,
    openBranchDiff,
    openFilePreview,
    openWorkingTreeDiff,
  }
}
