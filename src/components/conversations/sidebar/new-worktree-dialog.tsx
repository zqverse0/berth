"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { FolderOpen, Loader2 } from "lucide-react"
import { getGitBranch, gitWorktreeAdd } from "@/lib/api"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import type { FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** 新建 worktree 的来源项目；为 null 时对话框关闭。 */
export interface NewWorktreeSource {
  folderId: number
  folderPath: string
}

/**
 * 项目视图唯一的「新建 worktree」对话框：项目行菜单与顶栏按钮都只负责给出
 * 来源项目，创建与登记在这里完成。
 */
export function NewWorktreeDialog({
  source,
  onClose,
  onCreated,
}: {
  source: NewWorktreeSource | null
  onClose: () => void
  onCreated: (detail: FolderDetail) => void
}) {
  const tBranch = useTranslations("Folder.branchDropdown")
  const tCommon = useTranslations("Folder.common")
  const openWorktreeFolder = useAppWorkspaceStore((s) => s.openWorktreeFolder)
  const isDesktopMode = isDesktop()
  const [form, setForm] = useState({
    branch: "",
    path: "",
    currentBranch: null as string | null,
    loading: false,
  })

  // 每次打开都按来源项目的当前分支生成默认分支名与同级目录路径。
  useEffect(() => {
    if (!source) return
    let cancelled = false
    const { folderPath } = source
    void (async () => {
      let curBranch = "main"
      try {
        const branchInfo = await getGitBranch(folderPath)
        if (branchInfo) curBranch = branchInfo
      } catch {
        // Non-git folder or branch query failed
      }
      if (cancelled) return
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
      let random = ""
      for (let i = 0; i < 6; i++) {
        random += chars[Math.floor(Math.random() * chars.length)]
      }
      const folderName =
        folderPath.split(/[\\/]/).filter(Boolean).pop() ?? "project"
      const lastSlash = Math.max(
        folderPath.lastIndexOf("/"),
        folderPath.lastIndexOf("\\")
      )
      const parent = lastSlash >= 0 ? folderPath.substring(0, lastSlash) : ""
      const sep = folderPath.includes("\\") ? "\\" : "/"
      setForm({
        branch: `cv-${curBranch}-${random}`,
        path: `${parent ? `${parent}${sep}` : ""}${folderName}-${curBranch}-${random}`,
        currentBranch: curBranch,
        loading: false,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [source])

  const handleBrowse = async () => {
    if (!isDesktopMode) return
    const selected = await openFileDialog({ directory: true, multiple: false })
    if (selected) {
      const path = Array.isArray(selected) ? selected[0] : selected
      setForm((prev) => ({ ...prev, path }))
    }
  }

  const handleCreate = async () => {
    const branch = form.branch.trim()
    const path = form.path.trim()
    if (!source || !branch || !path || form.loading) return

    setForm((prev) => ({ ...prev, loading: true }))
    try {
      await gitWorktreeAdd(source.folderPath, branch, path)
      const detail = await openWorktreeFolder(path, source.folderId)
      onCreated(detail)
      toast.success(
        tBranch("toasts.taskCompleted", {
          label: tBranch("tasks.newWorktree", { name: branch }),
        })
      )
      onClose()
    } catch (error) {
      toast.error(
        tBranch("toasts.taskFailed", { label: tBranch("newWorktree") }),
        { description: toErrorMessage(error) }
      )
    } finally {
      setForm((prev) => ({ ...prev, loading: false }))
    }
  }

  return (
    <Dialog open={source !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tBranch("dialogs.newWorktreeTitle")}</DialogTitle>
          <DialogDescription>
            {tBranch("dialogs.newWorktreeDescription", {
              branch: form.currentBranch ?? "-",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="new-worktree-branch">
              {tBranch("dialogs.branchNameLabel")}
            </Label>
            <Input
              id="new-worktree-branch"
              placeholder={tBranch("dialogs.branchNamePlaceholder")}
              value={form.branch}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, branch: e.target.value }))
              }
              disabled={form.loading}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.key === "Process") return
                if (e.key === "Enter") void handleCreate()
              }}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-worktree-path">
              {tBranch("dialogs.worktreePathLabel")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="new-worktree-path"
                placeholder={tBranch("dialogs.worktreePathPlaceholder")}
                value={form.path}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, path: e.target.value }))
                }
                disabled={form.loading}
                className="flex-1"
              />
              {isDesktopMode && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void handleBrowse()}
                  disabled={form.loading}
                  aria-label={tBranch("dialogs.worktreePathLabel")}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={form.loading}>
            {tCommon("cancel")}
          </Button>
          <Button
            disabled={!form.branch.trim() || !form.path.trim() || form.loading}
            onClick={() => void handleCreate()}
          >
            {form.loading && (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            )}
            {tCommon("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
