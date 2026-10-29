import { getTerminalSession } from "@/lib/api"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { paneNumber } from "@/components/project-management/group/group-model"

/**
 * 终端在 CLI 里的短名 `项目:编号`（与 `berth terminal ls` 的 TERMINAL 列一致），
 * 可直接作 `berth terminal capture/send -t` 的参数；拿不到编号时回落 target_ref。
 */
export async function fetchTerminalHandle(
  terminalId: string
): Promise<string | null> {
  const descriptor = await getTerminalSession(terminalId)
  const pane = paneNumber(descriptor.targetRef)
  if (pane == null) return descriptor.targetRef ?? null
  // CLI 按项目目录名解析（不认别名），这里同样用 name
  const projectName = useAppWorkspaceStore
    .getState()
    .allFolders.find((f) => f.id === descriptor.folderId)?.name
  return projectName ? `${projectName}:${pane}` : String(pane)
}
