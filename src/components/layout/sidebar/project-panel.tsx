"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Maximize2, Minimize2 } from "lucide-react"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { cn } from "@/lib/utils"
import { FileTreeTab } from "@/components/layout/aux-panel/aux-panel-file-tree-tab"
import { GitChangesTab } from "@/components/layout/aux-panel/aux-panel-git-changes-tab"
import { GitLogTab } from "@/components/layout/aux-panel/aux-panel-git-log-tab"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel/aux-panel-no-folder-empty"
import { BranchDropdown } from "@/components/layout/git/branch-dropdown"
import { useProjectPanelStore, type ProjectPanelTab } from "./views"

const HEADER_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

/**
 * 侧栏下方的当前项目面板：标签 文件 / 变更 / 提交 / 分支，内容复用文件树与 Git 视图；
 * 标题与收起开关在状态栏项目段（`StatusBarProject`）。跟随当前项目（选项目、worktree 或会话都会切当前项目）；`visible` 为 false 时不挂内容（不留文件监视）。
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
  const { tab, collapsed, setTab, setCollapsed, setMaximized } =
    useProjectPanelStore()
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

  if (collapsed && !maximized) return null

  return (
    <section
      aria-label={t("label")}
      className="flex h-full min-h-0 flex-col border-t border-border/50"
    >
      <div className="flex shrink-0 items-center gap-1 px-1.5 py-1">
        <div
          role="tablist"
          aria-label={t("label")}
          className="flex min-w-0 flex-1 items-center gap-0.5"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={current === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "h-6 rounded px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                current === item.id && "bg-accent text-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={HEADER_BUTTON}
          aria-label={maximized ? t("restore") : t("maximize")}
          title={maximized ? t("restore") : t("maximize")}
          onClick={() => {
            setCollapsed(false)
            setMaximized(!maximized)
          }}
        >
          {maximized ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </button>
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
    </section>
  )
}
