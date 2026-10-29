import { useCallback, useEffect, useState } from "react"
import { getKnowledgeSnapshot } from "@/knowledge/api/knowledge-client"
import type { KnowledgeSnapshot } from "@/knowledge/model/types"

export function useKnowledgeSnapshot(folderId: number, active: boolean) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!active) return
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await getKnowledgeSnapshot(folderId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [active, folderId])

  useEffect(() => {
    if (!active) return
    void refresh()
  }, [active, refresh])

  return { snapshot, loading, error, refresh }
}
