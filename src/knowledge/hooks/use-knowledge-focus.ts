import { create } from "zustand"

/**
 * 知识库的选中笔记与筛选词：侧栏「记忆」和首页星图共用，一边选中 / 搜索，另一边跟着高亮。
 * 笔记 id 是 vault 相对路径，换项目后对不上的 id 自然不显示。
 */
export const useKnowledgeFocus = create<{
  selected: string | null
  query: string
  select: (id: string | null) => void
  setQuery: (query: string) => void
}>((set) => ({
  selected: null,
  query: "",
  select: (selected) => set({ selected }),
  setQuery: (query) => set({ query }),
}))
