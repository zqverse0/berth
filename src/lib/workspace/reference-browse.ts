import { create } from "zustand"

/**
 * 文件面板正在浏览的参考目录。只在记下它的那个成员仍是当前成员时生效：
 * 切成员、切项目就自然回到成员的文件树，不用另外清。
 */
export const useReferenceBrowseStore = create<{
  folderId: number | null
  path: string | null
  browse: (folderId: number, path: string | null) => void
}>()((set) => ({
  folderId: null,
  path: null,
  browse: (folderId, path) => set({ folderId, path }),
}))

/** 当前成员 `folderId` 下正在浏览的参考目录；没有为 null。 */
export function useBrowsedReference(folderId: number | null | undefined) {
  return useReferenceBrowseStore((state) =>
    folderId != null && state.folderId === folderId ? state.path : null
  )
}
