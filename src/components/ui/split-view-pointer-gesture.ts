import {
  createSplitGestureSession,
  type SplitDirection,
  type SplitPaneBounds,
} from "@/lib/workspace/split-view"

export interface SplitPointerGestureLifecycle {
  finish: (commit: boolean) => void
  cancel: () => void
}

interface SplitViewPointerGestureOptions {
  element: HTMLElement
  event: PointerEvent
  direction: SplitDirection
  initialSizes: readonly number[]
  bounds: readonly SplitPaneBounds[]
  handleIndex: number
  startPosition: number
  onPreview: (sizes: readonly number[]) => void
  onCommit: (sizes: readonly number[]) => void
  onRestore: () => void
  onCancel: () => void
  onBeforeEnd: () => void
  onEnd: (committed: boolean) => void
}

interface SplitPointerGestureOptions {
  element: HTMLElement
  event: PointerEvent
  direction: SplitDirection
  onMove: (position: number) => void
  onCommit: () => void
  onCancel: () => void
  onBeforeEnd: () => void
  onEnd: (committed: boolean) => void
}

function getPointerPosition(
  direction: SplitDirection,
  event: PointerEvent
): number {
  return direction === "horizontal" ? event.clientX : event.clientY
}

function releasePointerCapture(element: HTMLElement, pointerId: number): void {
  if (element.hasPointerCapture && !element.hasPointerCapture(pointerId)) return
  element.releasePointerCapture?.(pointerId)
}

/** 管理 divider pointer capture、窗口监听和所有终止路径；尺寸计算留给上层事务。 */
export function createSplitViewPointerGesture({
  element,
  event,
  direction,
  initialSizes,
  bounds,
  handleIndex,
  startPosition,
  onPreview,
  onCommit,
  onRestore,
  onCancel,
  onBeforeEnd,
  onEnd,
}: SplitViewPointerGestureOptions): SplitPointerGestureLifecycle {
  const session = createSplitGestureSession({
    initialSizes,
    bounds,
    handleIndex,
    startPosition,
    threshold: 1,
    onPreview,
    onCommit,
    onCancel: onRestore,
  })
  return createSplitPointerGestureLifecycle({
    element,
    event,
    direction,
    onMove: (position) => session.move(position),
    onCommit: () => session.commit(),
    onCancel: () => {
      session.cancel()
      onCancel()
    },
    onBeforeEnd,
    onEnd,
  })
}

function createSplitPointerGestureLifecycle({
  element,
  event,
  direction,
  onMove,
  onCommit,
  onCancel,
  onBeforeEnd,
  onEnd,
}: SplitPointerGestureOptions): SplitPointerGestureLifecycle {
  const pointerId = event.pointerId
  let finished = false

  const removeListeners = () => {
    window.removeEventListener("pointermove", handlePointerMove)
    window.removeEventListener("pointerup", handlePointerUp)
    window.removeEventListener("pointercancel", handlePointerCancel)
    element.removeEventListener("lostpointercapture", handleLostCapture)
    window.removeEventListener("blur", handleWindowBlur)
  }

  const finish = (commit: boolean) => {
    if (finished) return
    finished = true
    removeListeners()
    onBeforeEnd()
    try {
      if (commit) onCommit()
      else onCancel()
    } finally {
      releasePointerCapture(element, pointerId)
      onEnd(commit)
    }
  }

  const handlePointerMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return
    onMove(getPointerPosition(direction, moveEvent))
  }
  const handlePointerUp = (upEvent: PointerEvent) => {
    if (upEvent.pointerId !== pointerId) return
    finish(true)
  }
  const handlePointerCancel = (cancelEvent: PointerEvent) => {
    if (cancelEvent.pointerId !== pointerId) return
    finish(false)
  }
  const handleLostCapture = (lostEvent: PointerEvent) => {
    if (lostEvent.pointerId !== pointerId) return
    finish(false)
  }
  const handleWindowBlur = () => finish(false)

  window.addEventListener("pointermove", handlePointerMove)
  window.addEventListener("pointerup", handlePointerUp)
  window.addEventListener("pointercancel", handlePointerCancel)
  element.addEventListener("lostpointercapture", handleLostCapture)
  window.addEventListener("blur", handleWindowBlur)
  event.preventDefault()
  element.setPointerCapture?.(pointerId)

  return {
    finish,
    cancel: () => finish(false),
  }
}
