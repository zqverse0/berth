import { useEffect } from "react"
import { getWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"
import { VAULT_PREFIX } from "@/knowledge/lib/vault"
import { IDEAS_DIR, type KnowledgeSnapshot } from "@/knowledge/model/types"

/**
 * 要监听的目录（绝对路径）。监听不存在的目录会启动失败，所以 vault 里还没有笔记和想法时
 * 视作 vault 不存在，改看 `.berth/`（已启用必有）：vault 一建出来就触发刷新。
 * ponytail: vault 已存在但完全为空时，其下新建的类型目录看不到；遇到再让后端报告 vault 是否存在。
 */
export function knowledgeWatchDirs(
  snapshot: KnowledgeSnapshot | null | undefined,
  hasIdeas: boolean
): string[] {
  if (!snapshot) return []
  const root = snapshot.root.replace(/[\\/]+$/, "")
  const vault = `${root}/${VAULT_PREFIX.slice(0, -1)}`
  if (snapshot.documents.length === 0 && !hasIdeas) {
    return [vault.replace(/\/[^/]+$/, "")]
  }
  return [
    ...new Set([
      vault,
      ...(hasIdeas ? [`${vault}/${IDEAS_DIR}`] : []),
      ...snapshot.documents.map(
        (document) => `${root}/${document.path.replace(/\/[^/]*$/, "")}`
      ),
    ]),
  ]
}

/**
 * vault 目录有变化就刷新。只看路径的监听不递归（与文件标签一样每个目录各一个），
 * 所以按目录登记：vault 根（新建类型目录）+ 每个有笔记的类型目录。
 */
export function useKnowledgePathRefresh({
  dirs,
  active,
  onRefresh,
  debounceMs = 350,
}: {
  /** 绝对路径 */
  dirs: readonly string[]
  active: boolean
  onRefresh: () => void | Promise<void>
  debounceMs?: number
}) {
  const key = JSON.stringify([...dirs].sort())
  useEffect(() => {
    const targets = JSON.parse(key) as string[]
    if (!active || targets.length === 0) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const subscriptions = targets.map((dir) => {
      const store = getWorkspaceStateStore(dir)
      const token = store.acquire("paths")
      const unsubscribe = store.subscribeEnvelopes(({ changed_paths }) => {
        if (changed_paths.length === 0) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void onRefresh(), debounceMs)
      })
      return () => {
        unsubscribe()
        store.release(token)
      }
    })
    return () => {
      if (timer) clearTimeout(timer)
      for (const dispose of subscriptions) dispose()
    }
  }, [active, debounceMs, key, onRefresh])
}
