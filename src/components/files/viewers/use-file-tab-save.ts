"use client"

import { useEffect, useRef } from "react"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"

const AUTO_SAVE_DELAY_MS = 5000

/**
 * 文本 buffer 类 tab 的落盘入口：停笔自动保存、窗口失焦 / 隐藏保存、Ctrl+S。
 * 文本编辑器与 Excalidraw 画板共用；`isComposing` 为 true（IME 组字中）时暂停自动保存。
 */
export function useFileTabSave(
  tab: TextFileWorkspaceTab,
  { active, isComposing = false }: { active: boolean; isComposing?: boolean }
) {
  const { saveFileTab } = useWorkspaceRuntimeActions()
  const scope = tab.id
  const content = tab.content
  const fileSaveState = tab.saveState
  const fileIsDirty = tab.isDirty
  // 保存只看文件可写：切回阅读时未保存的改动照常落盘
  const canEdit = !tab.readonly

  const autoSaveGuardRef = useRef({ canEdit, fileIsDirty, fileSaveState })
  useEffect(() => {
    autoSaveGuardRef.current = { canEdit, fileIsDirty, fileSaveState }
  }, [canEdit, fileIsDirty, fileSaveState])

  useEffect(() => {
    if (!canEdit || !fileIsDirty || fileSaveState !== "idle" || isComposing) {
      return
    }
    const timer = setTimeout(() => {
      const guard = autoSaveGuardRef.current
      if (
        !guard.canEdit ||
        !guard.fileIsDirty ||
        guard.fileSaveState !== "idle"
      ) {
        return
      }
      void saveFileTab(scope)
    }, AUTO_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [
    canEdit,
    fileIsDirty,
    fileSaveState,
    isComposing,
    scope,
    saveFileTab,
    content,
  ])

  useEffect(() => {
    const saveOnDeactivation = () => {
      const guard = autoSaveGuardRef.current
      if (
        !guard.canEdit ||
        !guard.fileIsDirty ||
        guard.fileSaveState === "saving"
      ) {
        return
      }
      void saveFileTab(scope)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") saveOnDeactivation()
    }
    window.addEventListener("blur", saveOnDeactivation)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("blur", saveOnDeactivation)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [scope, saveFileTab])

  // 捕获阶段：Excalidraw 自己处理 Ctrl+S（导出文件）并阻止冒泡，必须先于它接住
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return
      event.preventDefault()
      event.stopPropagation()
      if (canEdit) void saveFileTab(scope)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [active, scope, canEdit, saveFileTab])
}
