import type { FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

type FolderResourceRequest = {
  folderId: number
  kind: "conversation"
  onCreateConversation: (folder: FolderDetail) => void
}

function resolveFolder(folderId: number): FolderDetail | null {
  return (
    useAppWorkspaceStore
      .getState()
      .allFolders.find((folder) => folder.id === folderId) ?? null
  )
}

/**
 * The single folder-owned creation seam. Callers provide only folder identity
 * and resource intent; workspace path resolution and conversation launch
 * metadata remain centralized here.
 */
export async function createFolderResource(
  request: FolderResourceRequest
): Promise<string | null> {
  const folder = resolveFolder(request.folderId)
  if (!folder || folder.kind === "chat") return null

  request.onCreateConversation(folder)
  return null
}
