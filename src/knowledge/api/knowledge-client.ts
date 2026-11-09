import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import type { KnowledgeSnapshot, NoteStatus } from "@/knowledge/model/types"

async function call<T>(
  folderId: number | undefined,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const response = await runtimeBridgeOperation<T>({ method, folderId, params })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

export function getKnowledgeSnapshot(folderId: number) {
  return call<KnowledgeSnapshot>(folderId, "knowledge.snapshot")
}

export function searchKnowledge(folderId: number, query: string, limit = 50) {
  return call<{ query: string; documents: KnowledgeSnapshot["documents"] }>(
    folderId,
    "knowledge.search",
    { query, limit }
  )
}

/** 可能过期的笔记路径（项目相对）；会跑 git，按需调用。 */
export async function getStaleKnowledgePaths(folderId: number) {
  return (await call<{ paths: string[] }>(folderId, "knowledge.stale")).paths
}

export function setKnowledgeNoteStatus(
  folderId: number,
  path: string,
  status: NoteStatus
) {
  return call<{ path: string; status: NoteStatus }>(
    folderId,
    "knowledge.setStatus",
    { path, status }
  )
}
