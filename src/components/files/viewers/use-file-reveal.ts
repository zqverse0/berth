import { useCallback, useEffect } from "react"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { normalizeAbsPath } from "@/lib/files/file-open-target"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

/**
 * 完成「打开文件并定位」请求（pendingFileReveal）。每个 Viewer 声明自己能否定位到行：
 * - `revealLine` 为 null：带行号的请求直接失败；
 * - `waitForLine`：暂时不能定位（如 HTML 处于预览态），保留请求不消费；
 * - `textBuffer` 为 false 的资源 Viewer 只完成带回调的请求（页码由 Viewer 自己读）。
 * 返回的回调供编辑器就绪时再触发一次。
 */
export function useFileReveal({
  tab,
  visible,
  textBuffer,
  revealLine,
  waitForLine = false,
}: {
  tab: FileWorkspaceTab
  visible: boolean
  textBuffer: boolean
  revealLine: ((line: number) => number | null) | null
  waitForLine?: boolean
}): () => void {
  const pendingFileReveal = useWorkspaceFileStore(
    (state) => state.pendingFileReveal
  )
  const consumePendingFileReveal = useWorkspaceFileStore(
    (state) => state.consumePendingFileReveal
  )

  const completeFileReveal = useCallback(() => {
    if (!visible || !pendingFileReveal || pendingFileReveal.ready === false)
      return
    // 已取消或被下一请求替换的 effect 不得再次移动光标。
    if (
      useWorkspaceFileStore.getState().pendingFileReveal !== pendingFileReveal
    )
      return
    if (tab.kind !== "file" || tab.loading) return
    if (!textBuffer && !pendingFileReveal.onComplete) return
    if (normalizeAbsPath(tab.path) !== normalizeAbsPath(pendingFileReveal.path))
      return

    let line: number | null = null
    if (pendingFileReveal.line != null) {
      if (!revealLine) {
        consumePendingFileReveal(pendingFileReveal.requestId, {
          state: "failed",
          message: "line reveal is unavailable for this viewer",
        })
        return
      }
      if (waitForLine) return
      line = revealLine(pendingFileReveal.line)
      if (line === null) return
    }
    consumePendingFileReveal(pendingFileReveal.requestId, {
      state: "opened",
      path: tab.path,
      line,
    })
  }, [
    consumePendingFileReveal,
    pendingFileReveal,
    revealLine,
    tab,
    textBuffer,
    visible,
    waitForLine,
  ])

  useEffect(completeFileReveal, [completeFileReveal])
  return completeFileReveal
}
