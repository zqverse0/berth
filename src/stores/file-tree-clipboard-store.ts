import { create } from "zustand"

/** 文件树「复制」的条目。只在 Berth 内部，切换项目后还在，可粘贴多次。 */
export interface FileTreeClipboardEntry {
  /** 绝对路径；对方设备上的条目是 `berth-device://` 路径。 */
  absPath: string
  name: string
  kind: "file" | "dir"
}

export const useFileTreeClipboardStore = create<{
  entry: FileTreeClipboardEntry | null
  copy: (entry: FileTreeClipboardEntry) => void
}>((set) => ({
  entry: null,
  copy: (entry) => set({ entry }),
}))
