"use client"

import { useEffect, useRef, useState } from "react"
import {
  setCurrentDocumentContext,
  setCurrentWorkspaceTerminal,
} from "@/lib/api"
import { isTextFileTab } from "@/lib/files/file-workspace-tab"
import { fileViewerKindFromTab } from "@/lib/files/file-viewer-definition"
import { isDesktop } from "@/lib/platform"
import { SETTINGS_GLOBAL_TAB_ID } from "@/lib/workspace/settings-tab"
import {
  WORKSPACE_PANES,
  workspaceTabRefEqual,
} from "@/lib/workspace/workspace-pane-model"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useTabStore } from "@/stores/tab-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

// 跨工作区挂载串行化 IPC，避免旧实例的迟到清空覆盖新实例的选择。
let fileQueue: Promise<unknown> = Promise.resolve()
let terminalQueue: Promise<unknown> = Promise.resolve()

/** 文件跟随实际单文件宿主，终端只认 GUI 明确选中项，不猜 daemon active pane。 */
export function WorkspaceCurrentSelection() {
  const projection = useWorkspaceLayoutProjection()
  const isMobile = useIsMobile()
  const { isOpen: settingsOpen } = useSettingsWorkspace()
  const primaryTabs = useTabStore((state) => state.tabs)
  const activeFileTabId = useWorkspaceFileStore(
    (state) => state.activeFileTabId
  )
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden"
  )
  const [visibilityEpoch, setVisibilityEpoch] = useState(0)

  useEffect(() => {
    const updateVisibility = () => {
      setVisible(document.visibilityState !== "hidden")
      setVisibilityEpoch((epoch) => epoch + 1)
    }
    const hide = () => setVisible(false)
    document.addEventListener("visibilitychange", updateVisibility)
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", updateVisibility)
    // OS 失焦不清空；重新聚焦时可恢复托盘隐藏造成的本机清空。
    window.addEventListener("focus", updateVisibility)
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility)
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", updateVisibility)
      window.removeEventListener("focus", updateVisibility)
    }
  }, [])

  const visiblePanes = visible
    ? WORKSPACE_PANES.filter((pane) =>
        projection.mode === "conversation"
          ? pane === "conversation"
          : !isMobile || pane === projection.activePane
      )
    : []
  const selected = projection.activeWorkspaceTab
  const pane = projection.activePane
  const isCurrent =
    selected !== null &&
    visiblePanes.includes(pane) &&
    projection.paneForTab(selected) === pane &&
    workspaceTabRefEqual(selected, projection.activeTabByPane[pane]) &&
    projection.tabsByPane[pane].some((tab) =>
      workspaceTabRefEqual(tab, selected)
    )
  const isSettingsActive =
    settingsOpen &&
    projection.globalTabs.some((tab) => tab.id === SETTINGS_GLOBAL_TAB_ID) &&
    projection.activeTabByPane.files?.kind === "global" &&
    projection.activeTabByPane.files.id === SETTINGS_GLOBAL_TAB_ID
  // 桌面每个 tab 组各有一个文件宿主，只显示该组的激活 tab；移动端仍是单宿主。
  const fileTab = !visible
    ? null
    : isMobile
      ? projection.mode === "fusion" && projection.activePane === "files"
        ? (projection.fileTabsByPane.files.find(
            (tab) => tab.id === activeFileTabId
          ) ??
          projection.fileTabsByPane.conversation.find(
            (tab) => tab.id === activeFileTabId
          ) ??
          null)
        : null
      : (WORKSPACE_PANES.flatMap((filePane) => {
          const ref = projection.activeTabByPane[filePane]
          if (ref?.kind !== "file" || ref.id !== activeFileTabId) return []
          if (filePane === "files" && isSettingsActive) return []
          return projection.fileTabsByPane[filePane].filter(
            (tab) => tab.id === ref.id
          )
        })[0] ?? null)
  const viewerKind = fileTab ? fileViewerKindFromTab(fileTab) : null
  // 文本型预览直接复用已加载的源缓冲，不触发资源型 Viewer 的正文提取。
  const editor =
    fileTab &&
    isTextFileTab(fileTab) &&
    !fileTab.loading &&
    (viewerKind === "text" ||
      viewerKind === "markdown" ||
      viewerKind === "html")
      ? fileTab
      : null
  const terminal =
    isCurrent && selected?.kind === "primary"
      ? primaryTabs.find((tab) => tab.id === selected.id)
      : null
  const terminalId = terminal?.kind === "terminal" ? terminal.terminalId : null
  const fileId = editor?.id ?? null
  const path = editor?.path ?? null
  const content = editor?.content ?? null

  const lastFile = useRef<{ id: string; path: string; content: string } | null>(
    null
  )
  const lastFileEpoch = useRef(-1)
  const fileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileSequence = useRef(0)

  useEffect(() => {
    if (!isDesktop()) return
    const next =
      fileId !== null && path !== null && content !== null
        ? { id: fileId, path, content }
        : null
    const previous = lastFile.current
    if (
      previous?.id === next?.id &&
      previous?.path === next?.path &&
      previous?.content === next?.content &&
      lastFileEpoch.current === visibilityEpoch
    )
      return
    const epochChanged = lastFileEpoch.current !== visibilityEpoch
    lastFile.current = next
    lastFileEpoch.current = visibilityEpoch
    const sequence = ++fileSequence.current
    if (fileTimer.current !== null) clearTimeout(fileTimer.current)
    const submit = () => {
      fileQueue = fileQueue
        .catch(() => {})
        .then(async () => {
          if (sequence !== fileSequence.current) return
          await setCurrentDocumentContext(
            next
              ? {
                  scope: "workspace",
                  kind: "text",
                  path: next.path,
                  content: next.content,
                }
              : { scope: "workspace", kind: "", clear: true }
          )
        })
      void fileQueue.catch(() => {})
    }
    // 身份/可见性边界立即提交；只有同一编辑器的正文变更才防抖。
    if (
      previous?.id === next?.id &&
      previous?.path === next?.path &&
      next !== null &&
      !epochChanged &&
      previous?.content !== next.content
    ) {
      fileTimer.current = setTimeout(submit, 180)
    } else {
      submit()
    }
  }, [fileId, path, content, visibilityEpoch])

  const lastTerminal = useRef<string | null>(null)
  const lastTerminalEpoch = useRef(-1)
  const terminalSequence = useRef(0)
  useEffect(() => {
    if (!isDesktop()) return
    if (
      lastTerminal.current === terminalId &&
      lastTerminalEpoch.current === visibilityEpoch
    )
      return
    lastTerminal.current = terminalId
    lastTerminalEpoch.current = visibilityEpoch
    const sequence = ++terminalSequence.current
    terminalQueue = terminalQueue
      .catch(() => {})
      .then(async () => {
        if (sequence !== terminalSequence.current) return
        await setCurrentWorkspaceTerminal(terminalId)
      })
    void terminalQueue.catch(() => {})
  }, [terminalId, visibilityEpoch])

  useEffect(
    () => () => {
      if (fileTimer.current !== null) clearTimeout(fileTimer.current)
      if (!isDesktop()) return
      const fileRevision = ++fileSequence.current
      const terminalRevision = ++terminalSequence.current
      lastFile.current = null
      lastFileEpoch.current = -1
      lastTerminal.current = null
      lastTerminalEpoch.current = -1
      fileQueue = fileQueue
        .catch(() => {})
        .then(() => {
          if (fileSequence.current === fileRevision) {
            return setCurrentDocumentContext({
              scope: "workspace",
              kind: "",
              clear: true,
            })
          }
        })
      terminalQueue = terminalQueue
        .catch(() => {})
        .then(() => {
          if (terminalSequence.current === terminalRevision)
            return setCurrentWorkspaceTerminal(null)
        })
      void fileQueue.catch(() => {})
      void terminalQueue.catch(() => {})
    },
    []
  )

  return null
}
