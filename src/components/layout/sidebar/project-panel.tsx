"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  Maximize2,
  Minimize2,
  Server,
} from "lucide-react"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { parseDeviceFolderId } from "@/lib/transport/device"
import { cn } from "@/lib/utils"
import { FileTreeTab } from "@/components/layout/aux-panel/aux-panel-file-tree-tab"
import { GitChangesTab } from "@/components/layout/aux-panel/aux-panel-git-changes-tab"
import { GitLogTab } from "@/components/layout/aux-panel/aux-panel-git-log-tab"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel/aux-panel-no-folder-empty"
import { BranchDropdown } from "@/components/layout/git/branch-dropdown"
import {
  panelView,
  useProjectPanelStore,
  useSidebarViewStore,
  type ProjectPanelTab,
} from "./views"

/** 面板头的高度：收起后只剩这一行。 */
export const PROJECT_PANEL_HEADER_PX = 33

const HEADER_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

/**
 * 侧栏下方的当前项目面板：标题「项目 ⎇ 分支」，标签 文件 / 变更 / 提交 / 分支，内容复用文件树与 Git 视图。
 * 跟随当前项目（选项目、worktree 或会话都会切当前项目）；`visible` 为 false 时不挂内容（不留文件监视）。
 */
export function ProjectPanel({
  visible,
  maximized,
}: {
  visible: boolean
  maximized: boolean
}) {
  const t = useTranslations("ProjectPanel")
  const tTabs = useTranslations("Folder.auxPanel.tabs")
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const { tab, collapsed, setTab, setCollapsed } = useProjectPanelStore()
  const setView = useSidebarViewStore((s) => s.setView)
  const root = useAppWorkspaceStore((s) =>
    activeFolder?.parent_id == null
      ? null
      : s.allFolders.find((f) => f.id === activeFolder.parent_id)
  )
  const branch = useAppWorkspaceStore((s) =>
    activeFolder
      ? (s.branches.get(activeFolder.id) ?? activeFolder.git_branch ?? null)
      : null
  )
  const head = useAppWorkspaceStore((s) =>
    activeFolder ? (s.gitHeads.get(activeFolder.id) ?? null) : null
  )
  const isRepo = head ? head.is_repo : branch !== null

  // 命令面板 / 快捷键的文件搜索：带着搜索词进文件标签
  const [query, setQuery] = useState("")
  const fileSearchRequest = useAppUiStore((s) => s.projectFileSearchRequest)
  const fileSearchQuery = useAppUiStore((s) => s.projectFileSearchQuery)
  const consumeFileSearch = useAppUiStore((s) => s.consumeProjectFileSearch)
  useEffect(() => {
    if (fileSearchRequest > 0 && fileSearchQuery != null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery(fileSearchQuery)
      consumeFileSearch()
    }
  }, [fileSearchRequest, fileSearchQuery, consumeFileSearch])

  const tabs: { id: ProjectPanelTab; label: string }[] = [
    { id: "files", label: tTabs("files") },
    ...(isRepo
      ? [
          { id: "changes" as const, label: tTabs("changes") },
          { id: "commits" as const, label: tTabs("commits") },
        ]
      : []),
    { id: "branches", label: tTabs("branches") },
  ]
  // 非 repo 没有变更 / 提交（后端 git 命令必然失败）
  const current = tabs.some((item) => item.id === tab) ? tab : "files"
  const selectTab = (next: ProjectPanelTab) => {
    setTab(next)
    setCollapsed(false)
    if (maximized) setView(panelView(next))
  }

  const name = root
    ? root.alias || root.name
    : activeFolder
      ? activeFolder.alias || activeFolder.name
      : null
  const remote = activeFolder ? parseDeviceFolderId(activeFolder.id) : null
  const showBody = !collapsed || maximized

  return (
    <section
      aria-label={t("label")}
      className="flex h-full min-h-0 flex-col border-t border-border/50"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 text-xs">
        <span className="flex min-w-0 flex-1 items-center gap-1 font-medium">
          {remote ? (
            <Server
              aria-label={t("onDevice")}
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span className="min-w-0 truncate">{name ?? t("noProject")}</span>
          {branch ? (
            <span className="flex min-w-0 shrink items-center gap-0.5 font-normal text-muted-foreground">
              <GitBranch aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          ) : null}
        </span>
        {maximized ? null : (
          <button
            type="button"
            className={HEADER_BUTTON}
            aria-label={collapsed ? t("expand") : t("collapse")}
            title={collapsed ? t("expand") : t("collapse")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        )}
        <button
          type="button"
          className={HEADER_BUTTON}
          aria-label={maximized ? t("restore") : t("maximize")}
          title={maximized ? t("restore") : t("maximize")}
          onClick={() => {
            setCollapsed(false)
            setView(maximized ? "projects" : panelView(current))
          }}
        >
          {maximized ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </button>
      </div>
      {showBody ? (
        <>
          <div
            role="tablist"
            aria-label={t("label")}
            className="flex shrink-0 items-center gap-0.5 px-1.5 pb-1"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={current === item.id}
                onClick={() => selectTab(item.id)}
                className={cn(
                  "h-6 rounded px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  current === item.id && "bg-accent text-foreground"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
            {!visible ? null : !activeFolder || isChatMode ? (
              <AuxPanelNoFolderEmpty />
            ) : current === "files" ? (
              <FileTreeTab
                key={activeFolder.id}
                searchQuery={query}
                onSearchQueryChange={setQuery}
              />
            ) : current === "changes" ? (
              <GitChangesTab />
            ) : current === "commits" ? (
              <GitLogTab />
            ) : (
              // 分支（含非 repo 时的「初始化 Git 仓库」）
              <BranchDropdown
                folder={activeFolder}
                isChatMode={isChatMode}
                inline
              />
            )}
          </div>
        </>
      ) : null}
    </section>
  )
}
