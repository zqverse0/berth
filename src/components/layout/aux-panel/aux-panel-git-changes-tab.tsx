"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CloudUpload, Loader2, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel/aux-panel-no-folder-empty"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
} from "@/components/layout/sidebar/sidebar-header"
import { GitFileTree } from "@/components/layout/git/git-file-tree"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useGitCredential } from "@/contexts/git-credential-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { gitCommit, gitPush, gitPushInfo, gitStatus } from "@/lib/api"
import { invalidateGitFolderCache } from "@/lib/git/git-folder-cache"
import { toErrorMessage } from "@/lib/app-error"
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

/** 工作区变更：文件树（点文件在中心区看 diff）+ 侧栏内联的提交 / 推送。 */
export function GitChangesTab() {
  const t = useTranslations("Folder.gitChangesTab")
  const tCommon = useTranslations("Folder.common")
  const tCommit = useTranslations("Folder.commitDialog")
  const tPush = useTranslations("Folder.pushWindow")
  const { withCredentialRetry } = useGitCredential()
  const { activeFolder: folder } = useActiveFolder()
  const { openWorkingTreeDiff, openFilePreview } = useWorkspaceRuntimeActions()
  const [entries, setEntries] = useState<GitStatusEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState<"commit" | "push" | null>(null)
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

  const push = async () => {
    // 无远程时 git 只会报 "'origin' does not appear to be a git repository"，
    // 先拦住并指路。
    const info = await gitPushInfo(folder.path)
    if (info.remotes.length === 0) throw new Error(t("toasts.noRemote"))
    const result = await withCredentialRetry(
      (creds) => gitPush(folder.path, null, creds, folder.id),
      { folderPath: folder.path }
    )
    invalidateGitFolderCache(folder.path)
    if (result.upstream_set) {
      toast.success(
        tPush("toasts.upstreamSetAndPushed", { count: result.pushed_commits })
      )
    } else if (result.pushed_commits === 0) {
      toast.info(tPush("toasts.noCommitsToPush"))
    } else {
      toast.success(
        tPush("toasts.pushedCommits", { count: result.pushed_commits })
      )
    }
  }

  // andPush: 提交成功后接着推送；提交失败则不推。
  const run = async (kind: "commit" | "push", andPush = false) => {
    setBusy(kind)
    try {
      if (kind === "commit") {
        const result = await gitCommit(
          folder.path,
          message.trim(),
          entries.map((e) => e.file),
          folder.id
        )
        invalidateGitFolderCache(folder.path)
        setMessage("")
        toast.success(tCommit("toasts.commitCompleted"), {
          description: tCommit("toasts.committedFiles", {
            count: result.committed_files,
          }),
        })
        void load()
        if (!andPush) return
      }
      await push()
    } catch (error) {
      toast.error(
        tCommit(
          kind === "commit" && !andPush
            ? "toasts.commitFailed"
            : "toasts.pushFailed"
        ),
        { description: toErrorMessage(error) }
      )
    } finally {
      setBusy(null)
    }
  }

  const canCommit = entries.length > 0 && message.trim() !== "" && !busy

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeaderActions>
        <SidebarHeaderButton
          icon={RefreshCw}
          label={tCommon("refresh")}
          onClick={() => void load()}
          disabled={loading}
        />
        <SidebarHeaderButton
          icon={busy === "push" ? Loader2 : CloudUpload}
          label={tCommon("push")}
          onClick={() => void run("push")}
          disabled={busy !== null}
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
      <div className="shrink-0 space-y-2 border-t border-border/50 p-2">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
              e.preventDefault()
              void run("commit")
            }
          }}
          placeholder={tCommit("commitMessagePlaceholder")}
          aria-label={tCommit("commitMessage")}
          rows={3}
          className="resize-none text-sm"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!canCommit}
            onClick={() => void run("commit")}
          >
            {tCommit("commitButton", { count: entries.length })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={!canCommit}
            onClick={() => void run("commit", true)}
          >
            {tCommit("commitAndPushButton", { count: entries.length })}
          </Button>
        </div>
      </div>
    </div>
  )
}
