import {
  resizeSplitLayout,
  sameSplitSizes,
  type SplitDirection,
  type SplitLayoutResult,
} from "@/lib/workspace/split-view"
import { getSplitSeparatorKeyboardDelta } from "./split-view-separator-behavior"
import type { RegisteredHandle } from "./split-view-types"

interface SplitViewKeyboardControllerOptions {
  direction: SplitDirection
  result: SplitLayoutResult
  handleIndex: number | undefined
  handle: RegisteredHandle | undefined
  event: KeyboardEvent
  restoreSizeById: Map<string, number>
  onResize: (sizes: readonly number[]) => void
}

/** 处理 separator 的键盘步进、边界和折叠恢复，不负责提交布局。 */
export function handleSplitViewKeyboardResize({
  direction,
  result,
  handleIndex,
  handle,
  event,
  restoreSizeById,
  onResize,
}: SplitViewKeyboardControllerOptions): void {
  if (
    handleIndex === undefined ||
    handleIndex >= result.tracks.length - 1 ||
    handle?.disabled
  ) {
    return
  }

  const delta = getSplitSeparatorKeyboardDelta({
    direction,
    result,
    handleIndex,
    key: event.key,
    restoreSizeById,
  })
  if (delta === null) return
  // 已识别的 separator 键即使处于边界也必须消费，避免方向键或 Home/End
  // 继续滚动外层页面。
  event.preventDefault()
  const nextSizes = resizeSplitLayout(
    result.sizes,
    result.tracks,
    handleIndex,
    delta
  )
  if (sameSplitSizes(nextSizes, result.sizes)) return
  onResize(nextSizes)
}
