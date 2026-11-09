import { useCallback, useEffect, useRef, type PointerEvent } from "react"

/** 放下目标：工作区标题，值为工作区 id。 */
export const WORKSPACE_DROP_ATTR = "data-workspace-drop"
const DROP_ACTIVE_ATTR = "data-drop-active"
const THRESHOLD_PX = 5

/**
 * 侧栏里的拖动（项目拖到工作区、工作区调整顺序）。用 pointer 事件按坐标找目标，
 * 不依赖 DOM drop——桌面端 WebKit 收不到它（同 tab 拖动）。移动不到阈值算点击，照常触发 click。
 */
export function useSidebarDrag<T>(onDrop: (item: T, groupId: string) => void) {
  const onDropRef = useRef(onDrop)
  useEffect(() => {
    onDropRef.current = onDrop
  })
  return useCallback((item: T, event: PointerEvent) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const startY = event.clientY
    let dragging = false
    let lit: Element | null = null
    const light = (next: Element | null) => {
      if (next === lit) return
      lit?.removeAttribute(DROP_ACTIVE_ATTR)
      next?.setAttribute(DROP_ACTIVE_ATTR, "")
      lit = next
    }
    const move = (e: globalThis.PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD_PX
      )
        return
      dragging = true
      document.body.style.cursor = "grabbing"
      light(
        document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest(`[${WORKSPACE_DROP_ATTR}]`) ?? null
      )
    }
    const stopClick = (e: MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
    }
    const end = (e: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      if (!dragging) return
      document.body.style.cursor = ""
      const groupId = lit?.getAttribute(WORKSPACE_DROP_ATTR)
      light(null)
      // 拖完松手不算点击
      window.addEventListener("click", stopClick, { capture: true })
      window.setTimeout(
        () => window.removeEventListener("click", stopClick, { capture: true }),
        0
      )
      if (e.type === "pointerup" && groupId) onDropRef.current(item, groupId)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
  }, [])
}
