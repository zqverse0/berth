import type { FolderWorkspacePane } from "@/lib/workspace/folder-workspace-resume"
import type { WorkspacePane } from "@/lib/workspace/workspace-tab-placement"

export type FolderWorkspaceChrome = {
  /** `null` 表示不要改当前 pane，只恢复文件 tab。 */
  pane: WorkspacePane | null
  fileTabId: string | null
}

/**
 * 切项目时文件 tab / pane 的纯计算。和工作区 runtime 的后置激活
 * 的原逻辑一致：有 resume 的 files pane 且该项目还有文件 tab 才切过去；
 * 否则回会话 pane。没有 resume 且已有文件 tab 时不改 pane，避免把调用方
 * 刚写好的快照再覆盖掉。
 */
export function resolveFolderWorkspaceChrome(input: {
  resumePane: FolderWorkspacePane | null | undefined
  visibleFileTabIds: readonly string[]
  rememberedFileTabId: string | null | undefined
}): FolderWorkspaceChrome {
  const remembered = input.rememberedFileTabId
  const fileTabId =
    remembered != null && input.visibleFileTabIds.includes(remembered)
      ? remembered
      : (input.visibleFileTabIds[0] ?? null)

  if (input.resumePane === "file" && fileTabId != null) {
    return { pane: "files", fileTabId }
  }
  if (fileTabId == null || input.resumePane === "conversation") {
    return { pane: "conversation", fileTabId }
  }
  return { pane: null, fileTabId }
}
