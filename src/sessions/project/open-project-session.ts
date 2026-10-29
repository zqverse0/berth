"use client"

import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { useWorkspaceRuntimeDependencies } from "@/hooks/workspace/use-workspace-runtime"
import { openWorktreeFolder, resolveProjectAgentSession } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { workspaceRuntime } from "@/lib/workspace/workspace-runtime"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"

export const trimSlash = (path: string) => path.replace(/[\\/]+$/, "")

/** 目录对应的项目 id；还没打开过的 worktree 按当前项目的仓库家族打开。 */
export async function folderIdFor(path: string, sourceFolderId: number) {
  const folder = useAppWorkspaceStore
    .getState()
    .allFolders.find((item) => trimSlash(item.path) === trimSlash(path))
  if (folder) return folder.id
  return (await openWorktreeFolder(path, sourceFolderId)).id
}

/** 按工具 id + 会话 id 打开项目里的 Agent 会话（tab 放在会话目录所属的项目里）；失败时弹提示。 */
export function useOpenProjectSession(sourceFolderId: number) {
  const t = useTranslations("Folder.sessionsView")
  const { agents } = useAgentProfiles()
  const workspaceDeps = useWorkspaceRuntimeDependencies()
  return async (session: {
    agent: string
    sessionId: string
    cwd: string
    title?: string | null
  }) => {
    const projectType = agents.find((a) => a.id === session.agent)?.projectType
    if (!projectType) {
      toast(t("cannotOpenAgent"))
      return
    }
    try {
      const result = await resolveProjectAgentSession({
        folderId: await folderIdFor(session.cwd, sourceFolderId),
        agentType: projectType,
        externalId: session.sessionId,
      })
      const conversation = result.conversation
      if (result.deleted || !result.sourceAvailable || !conversation) {
        toast.error(t("sourceUnavailable"))
        return
      }
      // 会话 tab 按项目归属显示：会话在别的群目录时先切到那个项目，再在它的范围里打开。
      const target = conversation.folder_id
      if (target !== useAppWorkspaceStore.getState().activeFolderId)
        useTabStore.getState().activateFolderWorkspace(target)
      workspaceRuntime.openTranscriptTab(
        {
          folderId: target,
          conversationId: conversation.id,
          agentType: conversation.agent_type,
          title: conversation.title ?? session.title ?? session.sessionId,
        },
        {
          ...workspaceDeps,
          scope: target,
          folders: useAppWorkspaceStore.getState().allFolders,
        }
      )
    } catch (error) {
      toast.error(t("openFailed", { error: toErrorMessage(error) }))
    }
  }
}
