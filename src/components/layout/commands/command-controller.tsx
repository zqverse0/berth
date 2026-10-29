"use client"

import {
  useSidebarViewStore,
  type SidebarView,
} from "@/components/layout/sidebar/views"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import {
  readWorkspaceLayoutProjection,
  useWorkspaceLayoutProjection,
} from "@/hooks/workspace/use-workspace-layout"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import { useOpenFolderPicker } from "@/hooks/workspace/use-open-folder-picker"

import { requestAgentLaunch } from "@/stores/agent-launch-store"
import { createProjectDrawingFile } from "@/lib/files/create-drawing-file"
import { toErrorMessage } from "@/lib/app-error"
import { createAndOpenFolderTerminal } from "@/lib/terminal/create-and-open-primary-terminal"
import {
  OPEN_PROJECT_SWITCHER_EVENT,
  type WorkspaceCommandId,
} from "@/components/layout/commands/commands"
import {
  WorkspaceCommandPalette,
  type WorkspaceCommandAction,
} from "@/components/layout/commands/command-palette"
import { workspaceTabKey } from "@/lib/workspace/workspace-tab-placement"
import {
  GIT_ACCOUNTS_TOOL_ID,
  useToolsSettingsStore,
} from "@/stores/tools-settings-store"

/** 所有工作区命令和键盘路由的唯一入口。 */
export function WorkspaceCommandController() {
  const { activeFolder } = useActiveFolder()
  const isOpen = useAppUiStore((state) => state.sidebarOpen)
  const toggle = useAppUiStore((state) => state.toggleSidebar)
  const toggleAuxPanel = useAppUiStore((state) => state.toggleAuxPanel)
  const { closeTab } = useTabActions()
  const { hasConversationTab, hasFilesTab, hasActiveTab, auxTabCount } =
    useWorkspaceLayoutProjection((projection) => ({
      auxTabCount: projection.tabsByPane.conversation.length,
      hasConversationTab: projection.activeTabByPane.conversation != null,
      hasFilesTab: projection.activeTabByPane.files != null,
      hasActiveTab: projection.activeWorkspaceTab != null,
    }))
  const setAuxPanelOpen = useAppUiStore((state) => state.setAuxPanelOpen)
  // Collapse the aux panel when its last tab goes away; restore it if we were
  // the ones who collapsed it (e.g. switching back to a project with tabs).
  const prevAuxTabCount = useRef(auxTabCount)
  const autoCollapsed = useRef(false)
  useEffect(() => {
    const prev = prevAuxTabCount.current
    prevAuxTabCount.current = auxTabCount
    if (prev > 0 && auxTabCount === 0) {
      if (useAppUiStore.getState().auxPanelOpen) {
        autoCollapsed.current = true
        setAuxPanelOpen(false)
      }
    } else if (prev === 0 && auxTabCount > 0 && autoCollapsed.current) {
      autoCollapsed.current = false
      setAuxPanelOpen(true)
    }
  }, [auxTabCount, setAuxPanelOpen])
  const selectWorkspaceTab = useWorkspaceLayoutStore(
    (state) => state.selectWorkspaceTab
  )
  const closeGlobalTab = useWorkspaceLayoutStore(
    (state) => state.closeGlobalTab
  )
  const { closeFileTab, closeAllFileTabs, openFilePreview } =
    useWorkspaceRuntimeActions()
  const tTerminal = useTranslations("Folder.terminal")
  const tFiles = useTranslations("Folder.fileWorkspacePanel")
  const { openSettings } = useSettingsWorkspace()
  const { openFolderPicker } = useOpenFolderPicker()
  const requestFocus = useAppUiStore((state) => state.requestSearchFocus)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // 项目页面都是侧栏视图；协作在任务视图里。
  const openView = useCallback(
    (view: SidebarView) => {
      useSidebarViewStore.getState().setView(view)
      if (!isOpen) toggle()
    },
    [isOpen, toggle]
  )

  const actions = useMemo<WorkspaceCommandAction[]>(() => {
    const switchTab = (offset: number) => {
      const { activeWorkspaceTab, paneForTab, orderedTabsByPane } =
        readWorkspaceLayoutProjection()
      if (!activeWorkspaceTab) return
      const pane = paneForTab(activeWorkspaceTab)
      const tabs = orderedTabsByPane[pane]
      const activeKey = workspaceTabKey(activeWorkspaceTab)
      const index = tabs.findIndex((tab) => workspaceTabKey(tab) === activeKey)
      if (index < 0 || tabs.length < 2) return
      const tab = tabs[(index + offset + tabs.length) % tabs.length]
      if (tab) selectWorkspaceTab(tab)
    }
    const focusPane = (pane: "conversation" | "files") => {
      const tab = readWorkspaceLayoutProjection().activeTabByPane[pane]
      if (tab) selectWorkspaceTab(tab)
    }
    return [
      {
        id: "switch_project",
        run: () => {
          if (!isOpen) toggle()
          useSidebarViewStore.getState().setView("projects")
          window.dispatchEvent(new Event(OPEN_PROJECT_SWITCHER_EVENT))
        },
      },
      { id: "open_project", run: () => void openFolderPicker() },
      {
        id: "toggle_search",
        run: () => {
          if (!isOpen) toggle()
          requestFocus()
        },
      },
      { id: "previous_tab", run: () => switchTab(-1) },
      { id: "next_tab", run: () => switchTab(1) },
      {
        id: "focus_left_pane",
        run: () => focusPane("conversation"),
        disabled: !hasConversationTab,
      },
      {
        id: "focus_right_pane",
        run: () => focusPane("files"),
        disabled: !hasFilesTab,
      },
      {
        id: "close_tab",
        disabled: !hasActiveTab,
        run: () => {
          const { activeWorkspaceTab } = readWorkspaceLayoutProjection()
          if (!activeWorkspaceTab) return
          if (activeWorkspaceTab.kind === "global")
            closeGlobalTab(activeWorkspaceTab.id)
          else if (activeWorkspaceTab.kind === "primary")
            closeTab(activeWorkspaceTab.id)
          else closeFileTab(activeWorkspaceTab.id)
        },
      },
      { id: "close_all_file_tabs", run: closeAllFileTabs },
      { id: "toggle_sidebar", run: toggle },
      { id: "toggle_aux_panel", run: toggleAuxPanel },
      {
        id: "new_conversation",
        disabled: !activeFolder,
        run: () => {
          if (activeFolder) {
            requestAgentLaunch({
              folderId: activeFolder.id,
              workingDirectory: activeFolder.path,
            })
          }
        },
      },
      {
        id: "new_terminal",
        disabled: !activeFolder,
        run: () => {
          if (activeFolder) {
            void createAndOpenFolderTerminal(
              {
                cwd: activeFolder.path,
                folderId: activeFolder.id,
              },
              tTerminal
            )
          }
        },
      },
      {
        id: "new_canvas",
        disabled: !activeFolder,
        run: () => {
          if (!activeFolder) return
          void createProjectDrawingFile(activeFolder.path)
            .then((absPath) => openFilePreview(absPath))
            .catch((error) => {
              toast.error(tFiles("drawingCreateFailed"), {
                description: toErrorMessage(error),
              })
            })
        },
      },
      { id: "open_settings", run: openSettings },
      { id: "open_files", run: () => openView("files") },
      { id: "open_git", run: () => openView("git") },
      { id: "open_berth_tasks", run: () => openView("tasks") },
      { id: "open_group", run: () => openView("group") },
      { id: "open_sessions", run: () => openView("sessions") },
      { id: "open_memory", run: () => openView("memory") },
      { id: "open_discover", run: () => openView("discover") },
      {
        id: "open_settings_appearance",
        run: () => openSettings("appearance"),
      },
      {
        id: "open_settings_model_providers",
        run: () => openSettings("model-providers"),
      },
      {
        id: "open_settings_version_control",
        // Git 程序与账号合并进 工具 → GitHub CLI（GIT_ACCOUNTS_TOOL_ID）。
        run: () => {
          useToolsSettingsStore.getState().selectTool(GIT_ACCOUNTS_TOOL_ID)
          openSettings("tools")
        },
      },
      {
        id: "open_settings_advanced",
        run: () => openSettings("advanced"),
      },
    ]
  }, [
    activeFolder,
    closeAllFileTabs,
    closeFileTab,
    closeGlobalTab,
    closeTab,
    isOpen,
    openFilePreview,
    openFolderPicker,
    tFiles,
    tTerminal,
    openView,
    openSettings,
    hasActiveTab,
    hasConversationTab,
    hasFilesTab,
    requestFocus,
    selectWorkspaceTab,
    toggle,
    toggleAuxPanel,
  ])

  const actionById = useMemo(
    () => new Map(actions.map((action) => [action.id, action])),
    [actions]
  )
  const run = useCallback(
    (id: WorkspaceCommandId) => {
      const action = actionById.get(id)
      if (action && !action.disabled) action.run()
    },
    [actionById]
  )
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return
      // Leader：Ctrl+Space 开关命令面板，面板里单键执行
      if (!event.shiftKey && event.code === "Space") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) setPaletteOpen((open) => !open)
        return
      }
      // 终端里 Ctrl+Tab 没有语义，可以安全占用
      if (event.key === "Tab") {
        event.preventDefault()
        event.stopImmediatePropagation()
        run(event.shiftKey ? "previous_tab" : "next_tab")
      }
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [run])

  return (
    <WorkspaceCommandPalette
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      actions={actions}
    />
  )
}
