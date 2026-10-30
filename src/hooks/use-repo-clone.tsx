"use client"

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { cloneRepository, openFolderInWorkspace } from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { useGitCredential } from "@/contexts/git-credential-context"
import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"

/** 上次 clone 的目标目录，重启后沿用（键名沿用内置发现时期，记住的目录不丢）。 */
const TARGET_DIR_KEY = "github:clone-target-dir"

function loadTargetDir(): string {
  try {
    return localStorage.getItem(TARGET_DIR_KEY) ?? ""
  } catch {
    return ""
  }
}

/** `https://host/owner/name(.git)` → `name` */
export function repoDirName(url: string): string {
  return (
    url
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split("/")
      .pop() ?? ""
  )
}

/**
 * 把仓库 clone 到「目录/仓库名」并作为项目打开：目录记住上次的，没有或 `pickDirectory` 时先选。
 * 凭据走 Berth 的 Git 账号（失败时按需询问）。插件视图的 `clone` 动作用它。
 */
export function useRepoClone() {
  const t = useTranslations("RepoClone")
  const { withCredentialRetry } = useGitCredential()
  const [targetDir, setTargetDirState] = useState(loadTargetDir)
  const [browserOpen, setBrowserOpen] = useState(false)
  const pickResolver = useRef<((dir: string | null) => void) | null>(null)

  const setTargetDir = useCallback((dir: string) => {
    try {
      localStorage.setItem(TARGET_DIR_KEY, dir)
    } catch {
      // 存不下就只记本次会话。
    }
    setTargetDirState(dir)
  }, [])

  const settlePick = useCallback((dir: string | null) => {
    pickResolver.current?.(dir)
    pickResolver.current = null
  }, [])

  const pickTargetDir = useCallback(async (): Promise<string | null> => {
    if (isDesktop()) {
      const selected = await openFileDialog({
        directory: true,
        multiple: false,
      })
      const dir = Array.isArray(selected) ? selected[0] : selected
      if (dir) setTargetDir(dir)
      return dir ?? null
    }
    return new Promise((resolve) => {
      pickResolver.current = resolve
      setBrowserOpen(true)
    })
  }, [setTargetDir])

  const clone = useCallback(
    async (url: string, options?: { pickDirectory?: boolean }) => {
      const base =
        !options?.pickDirectory && targetDir ? targetDir : await pickTargetDir()
      if (!base) return
      const fullPath = `${base.replace(/\/+$/, "")}/${repoDirName(url)}`
      try {
        await withCredentialRetry(
          (creds) => cloneRepository(url, fullPath, creds),
          { remoteUrl: url }
        )
        await openFolderInWorkspace(fullPath)
        toast.success(t("cloned", { path: fullPath }))
      } catch (err) {
        if (extractAppCommandError(err)?.code === "already_exists") {
          toast.info(t("exists", { path: fullPath }), {
            action: {
              label: t("open"),
              onClick: () => void openFolderInWorkspace(fullPath),
            },
          })
        } else {
          toast.error(t("failed"), { description: toErrorMessage(err) })
        }
      }
    },
    [withCredentialRetry, targetDir, pickTargetDir, t]
  )

  const dialog = (
    <DirectoryBrowserDialog
      open={browserOpen}
      onOpenChange={(open) => {
        setBrowserOpen(open)
        if (!open) settlePick(null)
      }}
      onSelect={(path) => {
        setTargetDir(path)
        settlePick(path)
      }}
    />
  )

  return { targetDir, clone, dialog }
}
