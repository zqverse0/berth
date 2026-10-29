import {
  type SplitDirection,
  type SplitLayoutResult,
} from "@/lib/workspace/split-view"
import type { SplitSeparatorA11y } from "./split-view-types"

export const SPLIT_LAYOUT_EPSILON = 0.01

export function getSplitSeparatorA11y(
  result: SplitLayoutResult | null,
  handleIndex: number
): SplitSeparatorA11y | null {
  if (!result) return null
  const left = result.tracks[handleIndex]
  const right = result.tracks[handleIndex + 1]
  if (!left || !right) return null
  const divisor = result.availableSize > 0 ? result.availableSize : 1
  return {
    valueNow: (left.size / divisor) * 100,
    valueMin: (left.min / divisor) * 100,
    valueMax: (left.max / divisor) * 100,
    controls: `${left.id} ${right.id}`,
  }
}

/** 将键盘 separator 操作转换为相邻 pane 的像素增量。 */
export function getSplitSeparatorKeyboardDelta(options: {
  direction: SplitDirection
  result: SplitLayoutResult
  handleIndex: number
  key: string
  restoreSizeById: Map<string, number>
}): number | null {
  const { direction, result, handleIndex, key, restoreSizeById } = options
  const left = result.tracks[handleIndex]
  const right = result.tracks[handleIndex + 1]
  if (!left || !right) return null

  const positiveKey = direction === "horizontal" ? "ArrowRight" : "ArrowDown"
  const negativeKey = direction === "horizontal" ? "ArrowLeft" : "ArrowUp"
  if (key === positiveKey) return 16
  if (key === negativeKey) return -16
  if (key === "Home") return left.min - left.size
  if (key === "End") return left.max - left.size
  if (key !== "Enter") return null

  const leftCollapsed = left.size <= left.min + SPLIT_LAYOUT_EPSILON
  const rightCollapsed = right.size <= right.min + SPLIT_LAYOUT_EPSILON
  if (left.collapsible) {
    if (!leftCollapsed) {
      restoreSizeById.set(left.id, left.size)
      return left.collapsedSize - left.size
    }
    return (restoreSizeById.get(left.id) ?? left.max) - left.size
  }
  if (right.collapsible) {
    if (!rightCollapsed) {
      restoreSizeById.set(right.id, right.size)
      return right.size - right.collapsedSize
    }
    return right.size - (restoreSizeById.get(right.id) ?? right.max)
  }
  return null
}
