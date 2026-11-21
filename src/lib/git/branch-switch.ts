import { mainFolderId } from "@/lib/workspace/projects"
import type { FolderDetail, WorktreeResolution } from "@/lib/types"

/**
 * Outcome of deciding what selecting branch B should do, given where B is
 * checked out (`WorktreeResolution`) relative to the active folder.
 *
 * - `noop` — B is already checked out in the active folder.
 * - `navigateRegistered` — B is checked out at a path owned by an already-
 *   registered folder (a sibling worktree, or the root/main working tree);
 *   switch the working directory there, no checkout.
 * - `checkoutInRoot` — B isn't checked out anywhere; switch to the root folder
 *   (if not already there) and `git checkout` B in the main working tree.
 */
export type BranchSwitchPlan =
  | { kind: "noop" }
  | { kind: "navigateRegistered"; folderId: number }
  | { kind: "checkoutInRoot"; rootFolder: FolderDetail }

/** `activeFolder` 所属项目的主成员；主成员不在 `allFolders` 里时退回 `activeFolder`。 */
export function resolveRootFolder(
  activeFolder: FolderDetail,
  allFolders: readonly FolderDetail[]
): FolderDetail {
  const main = mainFolderId(activeFolder)
  return allFolders.find((f) => f.id === main) ?? activeFolder
}

export function planBranchSwitch(args: {
  activeFolder: FolderDetail
  /** `null` for a remote selection (not resolved against local worktrees). */
  resolution: WorktreeResolution | null
  allFolders: readonly FolderDetail[]
  /** Remote selections always check out (track) in the root working tree —
   * never navigate to a same-short-name local worktree. */
  isRemote: boolean
}): BranchSwitchPlan {
  const { activeFolder, resolution, allFolders, isRemote } = args
  const root = resolveRootFolder(activeFolder, allFolders)

  // Remote selection, or a branch not checked out in any worktree → check it
  // out in the root working tree.
  if (isRemote || resolution == null || resolution.path == null) {
    return { kind: "checkoutInRoot", rootFolder: root }
  }

  // Already checked out somewhere.
  if (resolution.folder_id === activeFolder.id) {
    // …at the active folder itself — nothing to switch.
    return { kind: "noop" }
  }
  // worktree 由后端解析时自动登记（成员发现），检出在项目里就一定有 folder。
  if (resolution.folder_id != null) {
    return { kind: "navigateRegistered", folderId: resolution.folder_id }
  }
  // 检出在项目之外：照常在主成员里检出，由 git 报「已在别处检出」。
  return { kind: "checkoutInRoot", rootFolder: root }
}
