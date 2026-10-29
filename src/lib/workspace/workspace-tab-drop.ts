import {
  workspaceTabKey,
  type WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"

/** A strip tab's horizontal extent in scroll-content coordinates. */
export interface TabSlot {
  left: number
  width: number
}

/**
 * Where a dragged tab lands among a strip's other tabs: before the first tab
 * whose midpoint is right of `x`. Slots are measured with the dragged tab
 * removed, so the result never depends on where the gap currently is (no
 * flip-flopping while tabs animate aside).
 */
export function insertionIndex(slots: readonly TabSlot[], x: number): number {
  let index = 0
  for (const slot of slots) {
    if (x > slot.left + slot.width / 2) index += 1
  }
  return index
}

/**
 * The target pane's regular tabs after dropping `dragged` at `index`
 * (`null` = append). `paneTabs` is the pane's current order and may already
 * contain `dragged`.
 */
export function orderAfterDrop(
  paneTabs: readonly WorkspaceTabRef[],
  dragged: WorkspaceTabRef,
  index: number | null
): WorkspaceTabRef[] {
  const key = workspaceTabKey(dragged)
  const others = paneTabs.filter((tab) => workspaceTabKey(tab) !== key)
  const at = index === null ? others.length : Math.min(index, others.length)
  return [...others.slice(0, at), dragged, ...others.slice(at)]
}
