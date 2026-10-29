"use client"

import { useMemo, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  FileCode,
  Folder,
  FolderGit2,
  Terminal as TerminalIcon,
  MessagesSquare,
  Settings,
  GitCommit,
  GitMerge,
  Archive,
  Check,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { isConversationTab, isTerminalTab } from "@/lib/workspace/primary-tabs"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"
import { copyTextToClipboard } from "@/lib/utils"
import { isVirtualPreviewPath } from "@/lib/files/file-open-target"
import { githubStarredPreviewMetaFromPath } from "@/lib/git/github-starred-preview"
import type { WorkspaceLayoutProjection } from "@/lib/workspace/workspace-layout-projection"
import { isTextFileTab } from "@/lib/files/file-workspace-tab"
import { FileStatusInfo } from "@/components/layout/status-bar/file-status-info"

interface LocationPresentation {
  icon: LucideIcon
  projectName: string | null
  projectPath: string | null
  subInfo: string
  rawPath: string | null
  relativePath: string | null
  tooltip: string
  kind: "file" | "terminal" | "conversation" | "global" | "project"
}

export function getRelativeOrCleanPath(
  fullPath: string,
  folders: readonly {
    id: number
    path: string
    name: string
    alias?: string | null
  }[]
): { projectName: string | null; relativePath: string } {
  if (!fullPath) return { projectName: null, relativePath: "" }

  const sortedFolders = [...folders].sort(
    (a, b) => b.path.length - a.path.length
  )
  const matched = sortedFolders.find(
    (f) =>
      fullPath === f.path ||
      fullPath.startsWith(f.path.endsWith("/") ? f.path : `${f.path}/`)
  )

  if (matched) {
    const projectName = matched.alias || matched.name
    if (fullPath === matched.path) {
      return { projectName, relativePath: "" }
    }
    const rel = fullPath.slice(matched.path.length).replace(/^[/\\]+/, "")
    return { projectName, relativePath: rel }
  }

  const clean = fullPath.replace(/^\/home\/[^/]+/, "~")
  return { projectName: null, relativePath: clean }
}

/** 工作区段只投影中间区域：焦点在辅助面板（pane `conversation`）时仍显示中间激活的 tab。 */
function mainAreaTab(projection: WorkspaceLayoutProjection) {
  return projection.activePane === "conversation"
    ? projection.activeTabByPane.files
    : projection.activeWorkspaceTab
}

/**
 * 底部状态栏的当前焦点页面位置与项目信息投影。
 * 舒展展示所属项目与相对路径，点击直接复制绝对路径，简洁快速无多余弹窗。
 */
/** "project" = project pill only (sidebar segment), "path" = location only. */
export type ActivePathPart = "all" | "project" | "path"

export function ActivePathStatus({ part = "all" }: { part?: ActivePathPart }) {
  const t = useTranslations("Folder.statusBar")
  const tTabs = useTranslations("Folder.auxPanel.tabs")
  const activeWorkspaceTab = useWorkspaceLayoutProjection(mainAreaTab)
  const fileTabs = useWorkspaceFileStore((state) => state.fileTabs)
  const primaryTabs = useTabStore((state) => state.tabs)
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const activeFolderId = useAppWorkspaceStore((state) => state.activeFolderId)

  const [copiedTarget, setCopiedTarget] = useState<"project" | "path" | null>(
    null
  )

  const handleCopy = useCallback(
    async (
      text: string | null | undefined,
      target: "project" | "path",
      e?: React.MouseEvent
    ) => {
      e?.stopPropagation()
      if (!text) return
      const success = await copyTextToClipboard(text)
      if (success) {
        setCopiedTarget(target)
        setTimeout(() => {
          setCopiedTarget((curr) => (curr === target ? null : curr))
        }, 1200)
      }
    },
    []
  )

  const activeFile =
    activeWorkspaceTab?.kind === "file"
      ? (fileTabs.find((tab) => tab.id === activeWorkspaceTab.id) ?? null)
      : null
  const activePrimary =
    activeWorkspaceTab?.kind === "primary"
      ? (primaryTabs.find((tab) => tab.id === activeWorkspaceTab.id) ?? null)
      : null
  const terminalId =
    activePrimary && isTerminalTab(activePrimary)
      ? activePrimary.terminalId
      : null
  const runtimeCwd = useTerminalRuntimeStore((state) =>
    terminalId ? (state.sessions[terminalId]?.lastKnownCwd ?? null) : null
  )

  const presentation = useMemo<LocationPresentation | null>(() => {
    // 1. 文件页面
    if (activeFile) {
      const filePath = activeFile.path ?? ""
      // 内存预览（README、专家产出）的虚拟路径对用户无意义：显示来源，复制来源
      if (isVirtualPreviewPath(filePath)) {
        const githubUrl = githubStarredPreviewMetaFromPath(filePath)?.html_url
        const label = githubUrl ?? activeFile.title ?? "Preview"
        return {
          icon: FileCode,
          projectName: null,
          projectPath: null,
          subInfo: label.replace(/^https:\/\//, ""),
          rawPath: githubUrl ?? null,
          relativePath: null,
          tooltip: label,
          kind: "file",
        }
      }
      const { projectName, relativePath } = getRelativeOrCleanPath(
        filePath,
        allFolders
      )
      const matchedFolder = allFolders.find(
        (f) =>
          filePath === f.path ||
          filePath.startsWith(f.path.endsWith("/") ? f.path : `${f.path}/`)
      )
      const projectPath = matchedFolder?.path ?? null
      const displaySub =
        relativePath ||
        activeFile.title ||
        (filePath ? (filePath.split("/").pop() ?? "") : "File")
      return {
        icon: FileCode,
        projectName,
        projectPath,
        subInfo: displaySub,
        rawPath: filePath,
        relativePath: relativePath || null,
        tooltip: filePath || displaySub,
        kind: "file",
      }
    }

    // 2. Primary 页面
    if (activePrimary) {
      // 2.1 终端页
      if (isTerminalTab(activePrimary)) {
        const rawCwd =
          runtimeCwd ??
          activePrimary.lastKnownCwd ??
          activePrimary.initialCwd ??
          activePrimary.detachedFolderPath ??
          ""
        const folder = activePrimary.folderId
          ? (allFolders.find((f) => f.id === activePrimary.folderId) ?? null)
          : null
        const { projectName: matchedProject, relativePath } =
          getRelativeOrCleanPath(rawCwd, allFolders)
        const projectName = folder
          ? folder.alias || folder.name
          : matchedProject
        const matchedFolder =
          folder ??
          allFolders.find((f) => (f.alias || f.name) === projectName) ??
          null
        const projectPath = matchedFolder?.path ?? null
        const termTitle = activePrimary.title?.trim()

        let subInfo = ""
        if (relativePath) {
          subInfo =
            termTitle && termTitle !== relativePath
              ? `${relativePath} · ${termTitle}`
              : relativePath
        } else {
          subInfo = termTitle || "Terminal"
        }

        return {
          icon: TerminalIcon,
          projectName,
          projectPath,
          subInfo,
          rawPath: rawCwd,
          relativePath: relativePath || null,
          tooltip: rawCwd || subInfo,
          kind: "terminal",
        }
      }

      // 2.2 会话页
      if (isConversationTab(activePrimary)) {
        const folder =
          allFolders.find((f) => f.id === activePrimary.folderId) ?? null
        const projectName = folder
          ? folder.alias || folder.name
          : activePrimary.isChat
            ? null
            : "Chat"
        const projectPath = folder?.path ?? null
        const sessionTitle = activePrimary.title?.trim() || "Session"

        return {
          icon: MessagesSquare,
          projectName,
          projectPath,
          subInfo: sessionTitle,
          rawPath: folder?.path ?? null,
          relativePath: null,
          tooltip: folder ? `${folder.path} - ${sessionTitle}` : sessionTitle,
          kind: "conversation",
        }
      }
    }

    // 3. 全局页面
    if (activeWorkspaceTab?.kind === "global") {
      const globalId = activeWorkspaceTab.id
      if (globalId === "settings") {
        return {
          icon: Settings,
          projectName: null,
          projectPath: null,
          subInfo: "Settings",
          rawPath: null,
          relativePath: null,
          tooltip: "Settings",
          kind: "global",
        }
      }
      if (globalId === "commit") {
        return {
          icon: GitCommit,
          projectName: null,
          projectPath: null,
          subInfo: "Git Commit",
          rawPath: null,
          relativePath: null,
          tooltip: "Git Commit",
          kind: "global",
        }
      }
      if (globalId === "merge") {
        return {
          icon: GitMerge,
          projectName: null,
          projectPath: null,
          subInfo: "Git Merge",
          rawPath: null,
          relativePath: null,
          tooltip: "Git Merge",
          kind: "global",
        }
      }
      if (globalId === "stash") {
        return {
          icon: Archive,
          projectName: null,
          projectPath: null,
          subInfo: "Git Stash",
          rawPath: null,
          relativePath: null,
          tooltip: "Git Stash",
          kind: "global",
        }
      }
      return {
        icon: Settings,
        projectName: null,
        projectPath: null,
        subInfo: globalId,
        rawPath: null,
        relativePath: null,
        tooltip: globalId,
        kind: "global",
      }
    }

    // 4. Fallback: 当前激活的项目
    if (activeFolderId != null) {
      const activeFolder = allFolders.find((f) => f.id === activeFolderId)
      if (activeFolder) {
        return {
          icon: Folder,
          projectName: activeFolder.alias || activeFolder.name,
          projectPath: activeFolder.path,
          subInfo: "",
          rawPath: activeFolder.path,
          relativePath: null,
          tooltip: activeFolder.path,
          kind: "project",
        }
      }
    }

    return null
  }, [
    activeFile,
    activeFolderId,
    activePrimary,
    activeWorkspaceTab,
    allFolders,
    runtimeCwd,
  ])

  // 侧栏段的项目入口：显示项目名，点击复制项目绝对路径（切到项目列表走活动栏图标）
  if (part === "project") {
    const activeFolder = allFolders.find((f) => f.id === activeFolderId)
    const name =
      presentation?.projectName ??
      (activeFolder ? activeFolder.alias || activeFolder.name : null) ??
      tTabs("projects")
    const path = presentation?.projectPath ?? activeFolder?.path ?? null
    return (
      <button
        type="button"
        data-testid="active-location-status"
        className="group flex h-5 min-w-0 max-w-full items-center justify-center gap-1.5 rounded px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer select-none"
        title={path ? t("copyAbsolutePathHint", { path }) : name}
        onClick={(e) => handleCopy(path, "project", e)}
      >
        {copiedTarget === "project" ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
        )}
        <span className="min-w-0 truncate font-medium text-foreground/90">
          {name}
        </span>
      </button>
    )
  }

  if (!presentation) return null

  const { icon: Icon, projectName, subInfo, rawPath, tooltip } = presentation

  return (
    <div
      className={cn(
        "flex h-full min-w-0 max-w-full items-center gap-1 text-xs select-none text-muted-foreground"
      )}
      title={tooltip}
      data-testid="active-location-status"
    >
      {projectName && part === "all" ? (
        <span className="min-w-0 truncate px-1.5 font-medium text-foreground/90">
          {projectName}
        </span>
      ) : null}

      {/* 2. Separator */}
      {part === "all" && projectName && subInfo ? (
        <span className="shrink-0 text-muted-foreground/40 mx-0.5 font-mono text-[11px]">
          /
        </span>
      ) : null}

      {/* 3. SubInfo / Active Path Item - Click to directly copy item absolute path */}
      {subInfo ? (
        <button
          type="button"
          onClick={(e) => handleCopy(rawPath || tooltip, "path", e)}
          className="group flex min-w-0 shrink items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-foreground/80 hover:bg-muted/80 hover:text-foreground transition-colors cursor-pointer overflow-hidden font-mono text-[11px]"
          title={
            rawPath || tooltip
              ? t("copyAbsolutePathHint", { path: rawPath || tooltip })
              : tooltip
          }
        >
          {copiedTarget === "path" ? (
            <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          ) : (
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
          )}
          <span className="truncate text-foreground/80 group-hover:text-foreground">
            {subInfo}
          </span>
        </button>
      ) : null}
      {activeFile && isTextFileTab(activeFile) ? (
        <div className="ml-auto pl-2">
          <FileStatusInfo tab={activeFile} />
        </div>
      ) : null}
    </div>
  )
}
