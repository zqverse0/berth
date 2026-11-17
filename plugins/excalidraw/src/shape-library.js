// 素材用 Excalidraw 原生 library 数据；插入走原生拖放，绑定、分组、ID 和撤销由它处理。
import { MIME_TYPES, serializeLibraryAsJSON } from "@excalidraw/excalidraw"

export const SHAPE_LIBRARY_KEY = "shape-library"

export function selectedLibraryElements(api) {
  const elements = api.getSceneElements()
  const ids = new Set(
    Object.keys(api.getAppState().selectedElementIds).filter(
      (id) => api.getAppState().selectedElementIds[id]
    )
  )
  // 框内文字和 frame 子元素随容器一起收藏；不带走没有选中的外部元素。
  let size
  do {
    size = ids.size
    for (const element of elements) {
      if (element.frameId && ids.has(element.frameId)) ids.add(element.id)
      if (ids.has(element.id)) {
        for (const bound of element.boundElements ?? [])
          if (bound.type === "text") ids.add(bound.id)
      }
    }
  } while (ids.size !== size)
  return elements.filter((element) => ids.has(element.id) && !element.isDeleted)
}

/** 批量操作先完整验证，未知或重复 ID 不做部分插入 / 删除。 */
export function pickLibraryItems(items, ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== "string")
  )
    throw new Error("Select library items first")
  const selected = items.filter((item) => ids.includes(item.id))
  if (selected.length !== ids.length)
    throw new Error("Library selection changed")
  return selected
}

export function insertLibraryItems(api, items) {
  const canvas = document.querySelector(".excalidraw-container")
  if (!canvas) throw new Error("Editor is not ready")
  const transfer = new DataTransfer()
  transfer.setData(MIME_TYPES.excalidrawlib, serializeLibraryAsJSON(items))
  const bounds = canvas.getBoundingClientRect()
  const previous = new Set(api.getSceneElements().map((element) => element.id))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error("Insert timed out"))
    }, 5000)
    const off = api.onChange((elements, state) => {
      const inserted = elements.some(
        (element) => !element.isDeleted && !previous.has(element.id)
      )
      if (!inserted && !state.errorMessage) return
      clearTimeout(timer)
      off()
      if (inserted) resolve(null)
      else reject(new Error(state.errorMessage))
    })
    try {
      canvas.focus()
      canvas.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
        })
      )
    } catch (error) {
      clearTimeout(timer)
      off()
      reject(error)
    }
  })
}
