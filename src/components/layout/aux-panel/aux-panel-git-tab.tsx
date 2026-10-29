"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel/aux-panel-no-folder-empty"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { BranchDropdown } from "@/components/layout/git/branch-dropdown"
import { GitChangesTab } from "@/components/layout/aux-panel/aux-panel-git-changes-tab"
import { GitLogTab } from "@/components/layout/aux-panel/aux-panel-git-log-tab"
import { SidebarHeaderTabs } from "@/components/layout/sidebar/sidebar-header"
import type { GitPanelView } from "@/components/layout/git/git-panel-view"

type GitTabView = GitPanelView

/**
 * The unified Git surface: 分支（含远程管理）/ 提交记录，
 * tab 条渲染在侧栏顶栏（`SidebarHeaderTabs`）。变更/提交/
 * 推送/新建分支/新建工作树/贮藏视图已按主线收敛移除（git 日常操作走终端
 * CLI 或聊天分支 chip）；分支切换/合并/变基仍在分支 tab 的列表里。
 * 趋势/星标已独立为「发现」视图（aux-panel-discover-tab）。
 * 提交记录/管理远程只在 git 仓库可见——非 repo 文件夹点它们会让后端
 * git 命令必然失败，tab 直接隐藏（分支 tab 仍提供初始化入口）。
 */
export function AuxPanelGitTab() {
  const t = useTranslations("Folder.auxPanel.tabs")
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const [view, setView] = useState<GitTabView>("changes")
  // 与 BranchDropdown 同一 repo 判定（head poll 未到前回落分支名）。
  const branch = useAppWorkspaceStore((s) =>
    activeFolder
      ? (s.branches.get(activeFolder.id) ?? activeFolder.git_branch ?? null)
      : null
  )
  const head = useAppWorkspaceStore((s) =>
    activeFolder ? (s.gitHeads.get(activeFolder.id) ?? null) : null
  )
  const isRepo = head ? head.is_repo : branch !== null

  useEffect(() => {
    // A Git panel can remain mounted while the active folder changes. Start the
    // new folder on its change list rather than carrying over a stale view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView("changes")
  }, [activeFolder?.id])

  if (!activeFolder || isChatMode) return <AuxPanelNoFolderEmpty />

  const tabs: { id: GitTabView; label: string }[] = [
    ...(isRepo ? [{ id: "changes" as const, label: t("changes") }] : []),
    { id: "branches", label: t("branches") },
    ...(isRepo ? [{ id: "git_log" as const, label: t("commits") }] : []),
  ]
  // 非 repo 只有分支 tab（初始化入口）；变更/提交对非 repo 必然失败。
  const current: GitTabView = isRepo ? view : "branches"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeaderTabs tabs={tabs} value={current} onChange={setView} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {current === "changes" ? (
          <GitChangesTab />
        ) : current === "git_log" ? (
          <GitLogTab />
        ) : (
          // branches（含非 repo 时的「初始化 Git 仓库」提示页）。
          <BranchDropdown
            folder={activeFolder}
            isChatMode={isChatMode}
            inline
          />
        )}
      </div>
    </div>
  )
}
