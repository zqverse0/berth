import type { PointerEvent as ReactPointerEvent } from "react"
import { paneAtPoint } from "@/hooks/workspace/workspace-tab-drag-hit-test"
import { readWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import {
  insertionIndex,
  type TabSlot,
} from "@/lib/workspace/workspace-tab-drop"
import {
  workspaceTabKey,
  type WorkspacePane,
  type WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"

const DRAG_THRESHOLD_PX = 4
const LONG_PRESS_MS = 400
const LONG_PRESS_SLOP_PX = 8
const SETTLE_MS = 140
const AUTOSCROLL_EDGE_PX = 40
const AUTOSCROLL_STEP_PX = 10
/** Identity attributes stripped from the ghost so DOM queries never match it. */
const GHOST_STRIPPED_ATTRIBUTES = [
  "data-workspace-tab-key",
  "data-tab-id",
  "data-file-tab-id",
  "data-global-tab-id",
  "data-tab-item",
  "role",
  "aria-selected",
  "aria-label",
]

interface DragTarget {
  pane: WorkspacePane
  /** Gap position in that pane's strip; null = its content area. */
  index: number | null
}

interface DragSession {
  tab: WorkspaceTabRef
  key: string
  element: HTMLElement
  sourcePane: WorkspacePane
  sourceIndex: number
  pointerId: number
  start: { x: number; y: number }
  last: { x: number; y: number }
  /** Pointer offset inside the tab, so the ghost is held where it was grabbed. */
  grab: { x: number; y: number }
  started: boolean
  ghost: HTMLElement | null
  /** Strip tab slots measured with the dragged tab removed. */
  slots: Map<Element, TabSlot[]>
  target: DragTarget | null
  frame: number | null
  longPress: ReturnType<typeof setTimeout> | null
}

let session: DragSession | null = null

function stripScroller(strip: Element): Element {
  return strip.querySelector("[data-workspace-tab-scroll]") ?? strip
}

/** Left edge of a strip's scroll content, in client coordinates. */
function contentOrigin(strip: Element): number {
  const scroller = stripScroller(strip)
  return scroller.getBoundingClientRect().left - scroller.scrollLeft
}

function measureSlots(strip: Element, excludeKey: string): TabSlot[] {
  const origin = contentOrigin(strip)
  const slots: TabSlot[] = []
  let removed = 0
  for (const item of strip.querySelectorAll<HTMLElement>(
    "[data-workspace-tab-key]"
  )) {
    const rect = item.getBoundingClientRect()
    if (item.dataset.workspaceTabKey === excludeKey) {
      // Tabs after the dragged one close the gap it leaves.
      removed = rect.width
      continue
    }
    slots.push({ left: rect.left - origin - removed, width: rect.width })
  }
  return slots
}

/** A split needs a tab left behind; the only left tab can't open one. */
function canDropOnContent(pane: WorkspacePane, current: DragSession): boolean {
  if (pane === current.sourcePane) return false
  if (pane !== "files-split" || current.sourcePane !== "files") return true
  const projection = readWorkspaceLayoutProjection()
  return projection.splitActive || projection.tabsByPane.files.length > 1
}

function resolveTarget(
  current: DragSession,
  x: number,
  y: number
): { target: DragTarget | null; strip: Element | null } {
  for (const strip of document.querySelectorAll<HTMLElement>(
    "[data-workspace-tab-strip]"
  )) {
    const rect = strip.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      continue
    }
    let slots = current.slots.get(strip)
    if (!slots) {
      slots = measureSlots(strip, current.key)
      current.slots.set(strip, slots)
    }
    const pane = strip.dataset.workspaceTabStrip as WorkspacePane
    return {
      target: { pane, index: insertionIndex(slots, x - contentOrigin(strip)) },
      strip,
    }
  }
  const pane = paneAtPoint(x, y)
  return {
    target:
      pane && canDropOnContent(pane, current) ? { pane, index: null } : null,
    strip: null,
  }
}

function autoScroll(strip: Element, x: number): boolean {
  const scroller = stripScroller(strip)
  const rect = scroller.getBoundingClientRect()
  const before = scroller.scrollLeft
  if (x < rect.left + AUTOSCROLL_EDGE_PX) {
    scroller.scrollLeft -= AUTOSCROLL_STEP_PX
  } else if (x > rect.right - AUTOSCROLL_EDGE_PX) {
    scroller.scrollLeft += AUTOSCROLL_STEP_PX
  }
  return scroller.scrollLeft !== before
}

function placeGhost(ghost: HTMLElement, left: number, top: number): void {
  ghost.style.transform = `translate(${left}px, ${top}px)`
}

function frame(): void {
  const current = session
  if (!current?.ghost) return
  current.frame = null
  const { x, y } = current.last
  placeGhost(current.ghost, x - current.grab.x, y - current.grab.y)
  const { target, strip } = resolveTarget(current, x, y)
  if (
    target?.pane !== current.target?.pane ||
    target?.index !== current.target?.index
  ) {
    current.target = target
    useWorkspaceLayoutStore
      .getState()
      .setWorkspaceTabDragOver(target?.pane ?? null, target?.index ?? null)
  }
  // Keep scrolling while the pointer rests near a strip edge.
  if (strip && autoScroll(strip, x)) scheduleFrame()
}

function scheduleFrame(): void {
  if (session && session.frame === null) {
    session.frame = requestAnimationFrame(frame)
  }
}

function createGhost(element: HTMLElement, rect: DOMRect): HTMLElement {
  const ghost = element.cloneNode(true) as HTMLElement
  for (const node of [ghost, ...ghost.querySelectorAll("*")]) {
    for (const name of GHOST_STRIPPED_ATTRIBUTES) node.removeAttribute(name)
  }
  ghost.setAttribute("data-tab-drag-ghost", "")
  ghost.setAttribute("aria-hidden", "true")
  ghost.setAttribute("data-active", "true")
  Object.assign(ghost.style, {
    position: "fixed",
    left: "0",
    top: "0",
    margin: "0",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    zIndex: "1000",
    pointerEvents: "none",
    opacity: "0.95",
    borderRadius: "8px 8px 0 0",
    background: "var(--background)",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
  })
  placeGhost(ghost, rect.left, rect.top)
  document.body.appendChild(ghost)
  return ghost
}

function startDrag(current: DragSession): void {
  const rect = current.element.getBoundingClientRect()
  const strip = current.element.closest("[data-workspace-tab-strip]")
  if (strip) {
    current.slots.set(strip, measureSlots(strip, current.key))
    current.sourceIndex = [
      ...strip.querySelectorAll<HTMLElement>("[data-workspace-tab-key]"),
    ].findIndex((item) => item.dataset.workspaceTabKey === current.key)
  }
  current.started = true
  current.grab = {
    x: current.start.x - rect.left,
    y: current.start.y - rect.top,
  }
  current.ghost = createGhost(current.element, rect)
  // 按下到越过阈值之间 WebKit 可能已开始拖选阅读区文本，清掉。
  window.getSelection()?.removeAllRanges()
  current.target = { pane: current.sourcePane, index: current.sourceIndex }
  const root = document.documentElement
  root.setAttribute("data-berth-tab-dragging", "true")
  // The strip's gap stands in for the tab at its real width.
  root.style.setProperty("--berth-tab-drag-width", `${rect.width}px`)
  // The strip swaps the tab for a same-size gap in place: nothing jumps.
  useWorkspaceLayoutStore
    .getState()
    .beginWorkspaceTabDrag(current.tab, current.sourcePane, current.sourceIndex)
  scheduleFrame()
}

function removeListeners(): void {
  window.removeEventListener("pointermove", onPointerMove)
  window.removeEventListener("pointerup", onPointerUp)
  window.removeEventListener("pointercancel", onCancel)
  window.removeEventListener("keydown", onKeyDown)
  window.removeEventListener("blur", onCancel)
  window.removeEventListener("selectstart", preventSelect, true)
}

/** 按住 tab 期间不让拖动扩成文本选区（tab 的 select-none 拦不住拖进可选区域）。 */
function preventSelect(event: Event): void {
  event.preventDefault()
}

function teardown(): void {
  const current = session
  if (!current) return
  removeListeners()
  if (current.longPress) clearTimeout(current.longPress)
  if (current.frame !== null) cancelAnimationFrame(current.frame)
  current.ghost?.remove()
  document.documentElement.removeAttribute("data-berth-tab-dragging")
  document.documentElement.style.removeProperty("--berth-tab-drag-width")
  if (current.started) useWorkspaceLayoutStore.getState().endWorkspaceTabDrag()
  session = null
}

/**
 * Glide the ghost into its landing gap (or back home when cancelled), then
 * commit. The gap stays rendered until commit, so the real tab appears exactly
 * where the ghost stops. Timers, not animation frames: frames pause while the
 * window is hidden or unfocused, which would leave the drag stuck.
 */
function settle(current: DragSession, target: DragTarget | null): void {
  removeListeners()
  if (current.frame !== null) cancelAnimationFrame(current.frame)
  current.frame = null
  const landing = target ?? {
    pane: current.sourcePane,
    index: current.sourceIndex,
  }
  useWorkspaceLayoutStore
    .getState()
    .setWorkspaceTabDragOver(landing.pane, landing.index)
  // Next task: the strip has rendered the landing gap by then.
  setTimeout(() => {
    const ghost = current.ghost
    const gap = document.querySelector("[data-workspace-tab-placeholder]")
    if (ghost) {
      ghost.style.transition = `transform ${SETTLE_MS}ms ease-out, opacity ${SETTLE_MS}ms ease-out`
      if (landing.index !== null && gap) {
        const rect = gap.getBoundingClientRect()
        placeGhost(ghost, rect.left, rect.top)
      } else {
        ghost.style.opacity = "0"
      }
    }
    setTimeout(() => {
      try {
        if (target) {
          useWorkspaceLayoutStore
            .getState()
            .dropWorkspaceTab(current.tab, target.pane, target.index)
        }
      } finally {
        teardown()
      }
    }, SETTLE_MS)
  }, 0)
}

/** Swallow the click that follows a drag's pointerup. */
function suppressNextClick(): void {
  const swallow = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener("click", swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener("click", swallow, true), 0)
}

function onPointerMove(event: PointerEvent): void {
  const current = session
  if (!current || event.pointerId !== current.pointerId) return
  current.last = { x: event.clientX, y: event.clientY }
  if (current.started) {
    scheduleFrame()
    return
  }
  const distance = Math.hypot(
    event.clientX - current.start.x,
    event.clientY - current.start.y
  )
  if (event.pointerType === "touch") {
    // Moving before the long press elapses is a scroll, not a drag.
    if (distance > LONG_PRESS_SLOP_PX) teardown()
  } else if (distance > DRAG_THRESHOLD_PX) {
    startDrag(current)
  }
}

function onPointerUp(event: PointerEvent): void {
  const current = session
  if (!current || event.pointerId !== current.pointerId) return
  if (!current.started) {
    teardown()
    return
  }
  current.last = { x: event.clientX, y: event.clientY }
  // Resolve against the release point, not the last rendered frame.
  const { target } = resolveTarget(current, current.last.x, current.last.y)
  suppressNextClick()
  settle(current, target)
}

function onCancel(): void {
  const current = session
  if (!current) return
  if (current.started) settle(current, null)
  else teardown()
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") onCancel()
}

/**
 * Pointer-down on a workspace tab. A drag starts after a 4px move (mouse/pen)
 * or a long press (touch); a plain click, double-click, middle-click or
 * right-click never starts one.
 */
export function startWorkspaceTabDrag(
  event: ReactPointerEvent<HTMLElement>,
  tab: WorkspaceTabRef
): void {
  if (session || event.button !== 0) return
  if ((event.target as Element).closest("button")) return
  const point = { x: event.clientX, y: event.clientY }
  const current: DragSession = {
    tab,
    key: workspaceTabKey(tab),
    element: event.currentTarget,
    sourcePane: readWorkspaceLayoutProjection().paneForTab(tab),
    sourceIndex: 0,
    pointerId: event.pointerId,
    start: point,
    last: point,
    grab: { x: 0, y: 0 },
    started: false,
    ghost: null,
    slots: new Map(),
    target: null,
    frame: null,
    longPress: null,
  }
  session = current
  if (event.pointerType === "touch") {
    current.longPress = setTimeout(() => {
      current.longPress = null
      if (session === current) startDrag(current)
    }, LONG_PRESS_MS)
  }
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("pointercancel", onCancel)
  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("blur", onCancel)
  window.addEventListener("selectstart", preventSelect, true)
}
