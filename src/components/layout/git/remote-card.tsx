"use client"

import { useCallback, useEffect, useState } from "react"
import { ExternalLink, Globe, Plus, Settings2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { RemoteManageForm } from "@/components/layout/git/remote-manage-dialog"
import { Button } from "@/components/ui/button"
import { gitListRemotes } from "@/lib/api"
import { remoteWebUrl } from "@/lib/git/remote-url"
import { openUrl } from "@/lib/platform"
import type { GitRemote } from "@/lib/types"

/**
 * 分支页顶部的远程仓库卡片：列出远程（名字 + URL，可在浏览器打开）；
 * 没有远程时直接给「添加远程」入口；编辑沿用 RemoteManageForm，就地展开。
 */
export function RemoteCard({
  folderPath,
  onChanged,
}: {
  folderPath: string
  onChanged: () => void
}) {
  const t = useTranslations("Folder.branchDropdown")
  const [remotes, setRemotes] = useState<GitRemote[] | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(() => {
    gitListRemotes(folderPath)
      .then((list) =>
        // `git remote -v` 的 fetch/push 各一条，按名字去重。
        setRemotes(
          list.filter((r, i) => list.findIndex((x) => x.name === r.name) === i)
        )
      )
      .catch(() => setRemotes([]))
  }, [folderPath])

  useEffect(() => {
    load()
  }, [load])

  if (remotes === null) return null

  return (
    <div className="shrink-0 border-b border-border/50">
      {remotes.map((r) => {
        const web = remoteWebUrl(r.url)
        return (
          <div
            key={r.name}
            className="flex items-center gap-2 px-3 py-1.5 text-sm"
          >
            <Globe className="size-3.5 shrink-0 opacity-70" />
            <span className="shrink-0 font-medium">{r.name}</span>
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={r.url}
            >
              {r.url}
            </span>
            {web ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                title={t("openRemoteInBrowser")}
                aria-label={t("openRemoteInBrowser")}
                onClick={() => void openUrl(web)}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
          </div>
        )
      })}
      <div className="flex items-center gap-2 px-3 py-1.5">
        {remotes.length === 0 ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {t("dialogs.manageRemotesEmpty")}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          variant="outline"
          size="xs"
          className="shrink-0 gap-1"
          onClick={() => setEditing((v) => !v)}
        >
          {remotes.length === 0 ? (
            <Plus className="size-3" />
          ) : (
            <Settings2 className="size-3" />
          )}
          {remotes.length === 0
            ? t("addRemoteRepo")
            : t("dialogs.manageRemotesTitle")}
        </Button>
      </div>
      {editing ? (
        <div className="h-64 border-t border-border/50">
          <RemoteManageForm
            folderPath={folderPath}
            onSaved={() => {
              load()
              onChanged()
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
