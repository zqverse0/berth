"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel/aux-panel-no-folder-empty"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
} from "@/components/layout/sidebar/sidebar-header"
import { GitFileTree } from "@/components/layout/git/git-file-tree"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { gitStatus } from "@/lib/api"
import { subscribe } from "@/lib/platform"
import type { GitLogFileChange, GitStatusEntry } from "@/lib/types"

// ponytail: 5s 轮询 + 聚焦/git 事件刷新——没有文件系统监听可订阅；
// gitStatus 带 --no-optional-locks 开销小。需要实时再接 fs watcher。
const POLL_MS = 5000

// 轮询结果不变时保持引用，避免文件树展开状态被每次刷新重置。
function sameEntries(a: GitStatusEntry[], b: GitStatusEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => e.file === b[i].file && e.status === b[i].status)
  )
}

/** 工作区变更：文件树（点文件在中心区看 diff）。 */
export function GitChangesTab() {
  const t = useTranslations("Folder.gitChangesTab")
  const tCommon = useTranslations("Folder.common")
  const { activeFolder: folder } = useActiveFolder()
  const { openWorkingTreeDiff, openFilePreview } = useWorkspaceRuntimeActions()
  const [entries, setEntries] = useState<GitStatusEntry[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const folderId = folder?.id ?? null
  const folderPath = folder?.path ?? null

  const load = useCallback(async () => {
    if (!folderPath) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const next = await gitStatus(folderPath)
      if (mine === seq.current)
        setEntries((prev) => (sameEntries(prev, next) ? prev : next))
    } catch (error) {
      console.error("[GitChangesTab] git status failed:", error)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [folderPath])

  useEffect(() => {
    setEntries([])
    void load()
    const tick = () => {
      if (document.visibilityState === "visible") void load()
    }
    const timer = window.setInterval(tick, POLL_MS)
    window.addEventListener("focus", tick)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", tick)
    }
  }, [load])

  useEffect(() => {
    if (folderId == null) return
    let cancelled = false
    const unlistens: (() => void)[] = []
    for (const name of [
      "folder://git-commit-succeeded",
      "folder://git-push-succeeded",
      "folder://git-branch-changed",
    ]) {
      subscribe<{ folder_id: number }>(name, (p) => {
        if (!cancelled && p.folder_id === folderId) void load()
      })
        .then((fn) => (cancelled ? fn() : unlistens.push(fn)))
        .catch((err) => console.error(`[GitChangesTab] listen ${name}:`, err))
    }
    return () => {
      cancelled = true
      unlistens.forEach((fn) => fn())
    }
  }, [folderId, load])

  // gitStatus 不带增删行数；状态码原样传入，着色/角标由 git-file-state 决定。
  const files = useMemo<GitLogFileChange[]>(
    () =>
      entries.map((e) => ({
        path: e.file,
        status: e.status,
        additions: 0,
        deletions: 0,
      })),
    [entries]
  )
  if (!folder) return <AuxPanelNoFolderEmpty />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeaderActions>
        <SidebarHeaderButton
          icon={RefreshCw}
          label={tCommon("refresh")}
          onClick={() => void load()}
          disabled={loading}
        />
      </SidebarHeaderActions>
      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {loading ? tCommon("loading") : t("noChanges")}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1 p-2">
          <GitFileTree
            files={files}
            folderName={folder.name}
            className="max-h-none overflow-visible border-0"
            defaultCollapsed
            onOpenDiff={(path) =>
              void openWorkingTreeDiff(path, { folderId: folder.id })
            }
            onOpenFilePreview={(path) => void openFilePreview(path)}
          />
        </ScrollArea>
      )}
    </div>
  )
}
