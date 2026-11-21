"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { renameWorktree } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useTabActions } from "@/contexts/tab-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** worktree 改名（目录与分支一起改）：成员 ⋯ 菜单的入口与对话框。 */
export function useRenameWorktree() {
  const t = useTranslations("Folder.sidebar")
  const { closeTabsByFolder } = useTabActions()
  const [target, setTarget] = useState<number | null>(null)
  const [value, setValue] = useState("")

  const requestRename = useCallback((folderId: number) => {
    const folder = useAppWorkspaceStore
      .getState()
      .allFolders.find((item) => item.id === folderId)
    if (!folder) return
    setValue(folder.path.split(/[\\/]/).filter(Boolean).pop() ?? "")
    setTarget(folderId)
  }, [])

  const confirm = useCallback(async () => {
    const name = value.trim()
    const folderId = target
    setTarget(null)
    if (!name || folderId == null) return
    try {
      await renameWorktree(folderId, name)
      // 路径变了：旧路径下的文件 tab 已失效，关掉后按新路径重开。
      closeTabsByFolder(folderId)
      await useAppWorkspaceStore.getState().fetchFolders()
      toast.success(t("toasts.worktreeRenamed", { name }))
    } catch (err) {
      toast.error(
        t("toasts.worktreeRenameFailed", { message: toErrorMessage(err) })
      )
    }
  }, [closeTabsByFolder, t, target, value])

  const renameDialog = (
    <Dialog
      open={target != null}
      onOpenChange={(open) => !open && setTarget(null)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("folderHeaderMenu.renameWorktreeTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t("folderHeaderMenu.renameWorktreeHint")}
        </p>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key === "Process") return
            if (e.key === "Enter") void confirm()
          }}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setTarget(null)}>
            {t("folderHeaderMenu.setAliasCancel")}
          </Button>
          <Button onClick={() => void confirm()}>
            {t("folderHeaderMenu.setAliasSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { requestRename, renameDialog }
}
