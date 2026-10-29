"use client"

import { useCallback, useState } from "react"
import { toast } from "@/lib/notify"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { openFolderInWorkspace } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"
import { useTranslations } from "next-intl"

/**
 * 直接打开本地文件夹：桌面弹系统目录选择框，远端工作区降级为应用内
 * 目录浏览器。选中后经 `openFolderInWorkspace` 交接，workspace 监听器
 * 会为该目录创建并激活项目管理 tab。
 */
export function useOpenFolderPicker() {
  const t = useTranslations("ProjectBoot.openFolder")
  const [browserOpen, setBrowserOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const handoffFolder = useCallback(async (path: string) => {
    setBusy(true)
    try {
      await openFolderInWorkspace(path)
    } finally {
      setBusy(false)
    }
  }, [])

  const handleBrowserSelect = useCallback(
    async (path: string) => {
      try {
        await handoffFolder(path)
      } catch (err) {
        toast.error(t("failed"), { description: toErrorMessage(err) })
      }
    },
    [handoffFolder, t]
  )

  const openFolderPicker = useCallback(async () => {
    if (busy) return
    if (isDesktop()) {
      try {
        const result = await openFileDialog({
          directory: true,
          multiple: false,
        })
        if (!result) return
        const selected = Array.isArray(result) ? result[0] : result
        if (!selected) return
        await handoffFolder(selected)
      } catch (err) {
        toast.error(t("failed"), { description: toErrorMessage(err) })
      }
      return
    }
    // 远端工作区——应用内目录浏览器。
    setBrowserOpen(true)
  }, [busy, handoffFolder, t])

  const browserDialog = (
    <DirectoryBrowserDialog
      open={browserOpen}
      onOpenChange={setBrowserOpen}
      onSelect={(path) => void handleBrowserSelect(path)}
    />
  )

  return { openFolderPicker, browserDialog, busy }
}
