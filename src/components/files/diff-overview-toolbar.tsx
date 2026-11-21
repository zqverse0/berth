"use client"

import { useCallback, useState } from "react"
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useDiffOverviewStatusStore } from "@/lib/files/diff-overview-status"
import { copyTextToClipboard } from "@/lib/utils"

const iconBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-primary/8 hover:text-foreground transition-colors disabled:pointer-events-none disabled:opacity-35"

/**
 * 差异总览 tab 的顶部工具栏（挂在统一 FileWorkspaceHeader 的 h-10 槽位内）：
 * 左侧放全部展开/折叠与文件筛选，右侧放复制哈希与刷新。
 */
export function DiffOverviewToolbar({ tabId }: { tabId: string }) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const status = useDiffOverviewStatusStore(
    (state) => state.byTabId[tabId] ?? null
  )
  const [copied, setCopied] = useState(false)

  const handleCopyHash = useCallback(() => {
    if (!status?.copyText) return
    void copyTextToClipboard(status.copyText).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }, [status])

  if (!status) return null

  return (
    <div className="flex h-full min-w-0 items-center gap-2 px-3 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {status.fileCount > 0 && (
          <button
            type="button"
            onClick={status.onToggleAllFiles}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground hover:bg-primary/8 hover:text-foreground transition-colors"
            title={
              status.allExpanded ? t("collapseAllFiles") : t("expandAllFiles")
            }
          >
            {status.allExpanded ? (
              <>
                <ChevronsDownUp className="size-3.5" />
                <span>{t("collapseAllFiles")}</span>
              </>
            ) : (
              <>
                <ChevronsUpDown className="size-3.5" />
                <span>{t("expandAllFiles")}</span>
              </>
            )}
          </button>
        )}

        {status.fileCount > 1 && (
          <div className="relative flex min-w-0 max-w-[240px] flex-1 items-center">
            <Search className="pointer-events-none absolute left-2 size-3 text-muted-foreground/70" />
            <input
              type="text"
              value={status.fileFilter}
              onChange={(event) =>
                status.onFileFilterChange(event.target.value)
              }
              placeholder={t("filterDiffFilesPlaceholder")}
              aria-label={t("filterDiffFilesPlaceholder")}
              className="h-7 w-full rounded-md border border-border/60 bg-background/70 pl-6.5 pr-6 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary/50 focus:bg-background"
            />
            {status.fileFilter && (
              <button
                type="button"
                onClick={() => status.onFileFilterChange("")}
                aria-label={t("clearFileFilter")}
                className="absolute right-1.5 flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )}

        {status.kind !== "commit" && status.description && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">
            {status.description}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {status.kind === "commit" && status.copyText && (
          <button
            type="button"
            onClick={handleCopyHash}
            className={iconBtn}
            aria-label={t("copyCommitHash", { hash: status.copyText })}
            title={t("copyCommitHash", { hash: status.copyText })}
          >
            {copied ? (
              <Check className="size-3.5 text-emerald-500" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        )}

        {status.onRefresh && (
          <button
            type="button"
            onClick={status.onRefresh}
            className={iconBtn}
            aria-label={t("refreshDiff")}
            title={t("refreshDiff")}
          >
            <RefreshCw className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
