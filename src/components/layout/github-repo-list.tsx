"use client"

import { memo, useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import {
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  GitFork,
  Link,
  Loader2,
  MoreHorizontal,
  Send,
  Star,
} from "lucide-react"
import {
  cloneRepository,
  githubStarred,
  openFolderInWorkspace,
} from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { isDesktop, openFileDialog, openUrl } from "@/lib/platform"
import { cn, copyTextFromMenu } from "@/lib/utils"
import { useGitCredential } from "@/contexts/git-credential-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useSendToAgent } from "@/hooks/use-send-to-agent"
import {
  githubStarredPreviewId,
  rememberGithubStarredPreview,
  resolveGithubReadmeRelativeUrls,
} from "@/lib/git/github-starred-preview"
import type { GitHubAccount } from "@/lib/types"
import { AddGitHubAccountDialog } from "@/components/settings/add-github-account-dialog"
import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGithubStarredStore } from "@/stores/git/github-starred-store"

/** 趋势与星标两个列表共有的仓库字段 */
export interface GithubRepoItem {
  name: string
  full_name: string
  description: string | null
  html_url: string
  clone_url?: string | null
  owner: { login: string; avatar_url: string }
  stargazers_count: number | null
  forks_count?: number | null
  language: string | null
  license?: string | null
  archived?: boolean
  rank?: number
}

type CloneTarget = Pick<
  GithubRepoItem,
  "name" | "full_name" | "html_url" | "clone_url"
>

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString()
}

/** 发给 Agent 的仓库引用：单行（无换行即使终端不支持 bracketed paste 也不会被拆开提交），末尾留空格便于接着输入。 */
export function githubRepoReference(
  repo: Pick<GithubRepoItem, "full_name" | "html_url" | "description">
): string {
  const description = repo.description?.replace(/\s+/g, " ").trim()
  return `${repo.full_name} (${repo.html_url})${description ? ` — ${description}` : ""} `
}

function SendToAgentMenuItem({ repo }: { repo: GithubRepoItem }) {
  const { label, send } = useSendToAgent()
  return (
    <DropdownMenuItem onSelect={() => void send(githubRepoReference(repo))}>
      <Send />
      {label}
    </DropdownMenuItem>
  )
}

function cloneUrlOf(repo: CloneTarget): string {
  return repo.clone_url || `${repo.html_url.replace(/\/?$/, "")}.git`
}

/** clone 到 `目录/仓库名` 并打开；目标目录未设置时先选目录。 */
export function useGithubRepoClone() {
  const t = useTranslations("ProjectBoot.githubStars")
  const { withCredentialRetry } = useGitCredential()
  const targetDir = useGithubStarredStore((s) => s.targetDir)
  const setTargetDir = useGithubStarredStore((s) => s.setTargetDir)
  const [cloningName, setCloningName] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const pickResolver = useRef<((dir: string | null) => void) | null>(null)

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
    async (repo: CloneTarget, dir?: string): Promise<boolean> => {
      const base = dir ?? (targetDir || (await pickTargetDir()))
      if (!base) return false
      const cloneUrl = cloneUrlOf(repo)
      const fullPath = `${base.replace(/\/+$/, "")}/${repo.name}`
      setCloningName(repo.full_name)
      try {
        await withCredentialRetry(
          (creds) => cloneRepository(cloneUrl, fullPath, creds),
          { remoteUrl: cloneUrl }
        )
        await openFolderInWorkspace(fullPath)
        toast.success(t("cloneOk", { path: fullPath }))
        return true
      } catch (err) {
        if (extractAppCommandError(err)?.code === "already_exists") {
          toast.info(t("cloneExists", { path: fullPath }), {
            action: {
              label: t("openFolder"),
              onClick: () => void openFolderInWorkspace(fullPath),
            },
          })
        } else {
          toast.error(t("cloneFailed"), { description: toErrorMessage(err) })
        }
        return false
      } finally {
        setCloningName(null)
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

  return { cloningName, clone, pickTargetDir, dialog }
}

/** 列表行的全部操作：读 README、星标、clone；需要的对话框通过 `dialogs` 挂载。 */
export function useGithubRepoActions() {
  const t = useTranslations("ProjectBoot.githubStars")
  const tTrending = useTranslations("ProjectBoot.githubTrending")
  const workspace = useWorkspaceRuntimeActions()
  const accounts = useGithubStarredStore((s) => s.accounts)
  const addAccount = useGithubStarredStore((s) => s.addAccount)
  const storeToggleStar = useGithubStarredStore((s) => s.toggleStar)
  const [accountOpen, setAccountOpen] = useState(false)
  const [starPendingName, setStarPendingName] = useState<string | null>(null)
  const { cloningName, clone, pickTargetDir, dialog } = useGithubRepoClone()

  const cloneTo = useCallback(
    async (repo: GithubRepoItem) => {
      const dir = await pickTargetDir()
      if (dir) await clone(repo, dir)
    },
    [pickTargetDir, clone]
  )

  const openReadme = useCallback(
    async (repo: GithubRepoItem) => {
      rememberGithubStarredPreview(repo)
      const preview = (content: string) =>
        workspace.openReadonlyTextPreview({
          id: githubStarredPreviewId(repo.full_name),
          title: repo.full_name,
          path: "README.md",
          content,
          lifetime: "global",
        })
      preview(t("readmeLoading"))
      try {
        const result = await githubStarred({
          op: "readme",
          owner: repo.owner.login,
          name: repo.name,
        })
        preview(
          result.readme
            ? resolveGithubReadmeRelativeUrls(result.readme, repo.full_name)
            : t("readmeEmpty")
        )
      } catch (err) {
        // 未配置 GitHub Token 等情况：把失败原因写进预览，头部仍可「在 GitHub 打开」
        preview(t("readmeFailed", { error: toErrorMessage(err) }))
      }
    },
    [workspace, t]
  )

  const toggleStar = useCallback(
    async (repo: GithubRepoItem) => {
      if (accounts.accounts.length === 0) {
        setAccountOpen(true)
        return
      }
      setStarPendingName(repo.full_name)
      try {
        const isNowStarred = await storeToggleStar(repo)
        toast.success(
          tTrending(isNowStarred ? "starSuccess" : "unstarSuccess", {
            name: repo.full_name,
          }),
          {
            action: {
              label: t("undo"),
              onClick: () =>
                void storeToggleStar(repo).catch((err) =>
                  toast.error(toErrorMessage(err))
                ),
            },
          }
        )
      } catch (err) {
        toast.error(toErrorMessage(err))
      } finally {
        setStarPendingName(null)
      }
    },
    [accounts.accounts.length, storeToggleStar, t, tTrending]
  )

  const dialogs = (
    <>
      <AddGitHubAccountDialog
        open={accountOpen}
        onOpenChange={setAccountOpen}
        onAccountAdded={(account: GitHubAccount) => {
          void addAccount(account)
            .then(() => toast.success(account.username))
            .catch((err) =>
              toast.error(t("syncFailed"), { description: toErrorMessage(err) })
            )
        }}
        isFirstAccount={accounts.accounts.length === 0}
      />
      {dialog}
    </>
  )

  return {
    openReadme,
    toggleStar,
    starPendingName,
    requestAccount: () => setAccountOpen(true),
    clone,
    cloneTo,
    cloningName,
    dialogs,
  }
}

/** Stars / Forks / 语言 / 许可证：列表行与 README 工具栏共用 */
export function GithubRepoStats({
  repo,
  className,
}: {
  repo: Pick<
    GithubRepoItem,
    "stargazers_count" | "forks_count" | "language" | "license"
  >
  className?: string
}) {
  const t = useTranslations("ProjectBoot.githubTrending")
  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground",
        className
      )}
    >
      {repo.stargazers_count != null && (
        <span
          className="inline-flex items-center gap-0.5"
          aria-label={t("stars", { count: formatCount(repo.stargazers_count) })}
        >
          <Star className="h-3 w-3" />
          {formatCount(repo.stargazers_count)}
        </span>
      )}
      {repo.forks_count != null && (
        <span
          className="inline-flex items-center gap-0.5"
          aria-label={t("forks", { count: formatCount(repo.forks_count) })}
        >
          <GitFork className="h-3 w-3" />
          {formatCount(repo.forks_count)}
        </span>
      )}
      {repo.language && <span>{repo.language}</span>}
      {repo.license && repo.license !== "NOASSERTION" && (
        <span>{repo.license}</span>
      )}
    </span>
  )
}

export const GithubRepoRow = memo(function GithubRepoRow({
  repo,
  isStarred,
  isStarPending,
  isCloning,
  onOpen,
  onToggleStar,
  onClone,
  onCloneTo,
}: {
  repo: GithubRepoItem
  isStarred: boolean
  isStarPending: boolean
  isCloning: boolean
  onOpen: (repo: GithubRepoItem) => void
  onToggleStar: (repo: GithubRepoItem) => void
  onClone: (repo: GithubRepoItem) => void
  onCloneTo: (repo: GithubRepoItem) => void
}) {
  const t = useTranslations("ProjectBoot.githubStars")
  const tTrending = useTranslations("ProjectBoot.githubTrending")
  const targetDir = useGithubStarredStore((s) => s.targetDir)
  // Clone 直接用记住的目录，「克隆到其他目录」每次都选；把目录写进提示才分得清
  const cloneTitle = targetDir
    ? t("cloneInto", { dir: targetDir.replace(/^\/home\/[^/]+/, "~") })
    : t("clonePickDir")
  const copy = (text: string) => void copyTextFromMenu(text)
  // 悬停或键盘聚焦时才显示的次要操作
  const reveal =
    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"

  return (
    <div className="group flex items-start gap-0.5 pr-1.5 transition-colors hover:bg-muted/40">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 py-2 pl-3 text-left"
        onClick={() => onOpen(repo)}
      >
        {repo.rank !== undefined && (
          <span className="w-4 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
            {repo.rank}
          </span>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={repo.owner.avatar_url}
          alt=""
          loading="lazy"
          decoding="async"
          className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-muted"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {repo.full_name}
            </span>
            {repo.archived && (
              <Badge variant="secondary">{t("archived")}</Badge>
            )}
          </span>
          {repo.description && (
            <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {repo.description}
            </span>
          )}
          <GithubRepoStats repo={repo} className="mt-1" />
        </span>
      </button>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${t("clone")}: ${repo.full_name}`}
        title={cloneTitle}
        onClick={() => onClone(repo)}
        disabled={isCloning}
        className={cn(
          "mt-1.5 h-7 w-7 shrink-0 text-muted-foreground",
          !isCloning && reveal
        )}
      >
        {isCloning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${tTrending(isStarred ? "unstar" : "star")}: ${repo.full_name}`}
        title={tTrending(isStarred ? "unstar" : "star")}
        onClick={() => onToggleStar(repo)}
        disabled={isStarPending}
        className={cn(
          "mt-1.5 h-7 w-7 shrink-0 text-muted-foreground",
          !isStarred && !isStarPending && reveal
        )}
      >
        {isStarPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Star
            className={cn(
              "h-4 w-4",
              isStarred && "fill-amber-400 text-amber-400"
            )}
          />
        )}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${t("more")}: ${repo.full_name}`}
            className={cn(
              "mt-1.5 h-7 w-7 shrink-0 text-muted-foreground",
              reveal
            )}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <SendToAgentMenuItem repo={repo} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void openUrl(repo.html_url)}>
            <ExternalLink />
            {t("openGithub")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCloneTo(repo)}>
            <FolderInput />
            {t("cloneTo")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => copy(repo.html_url)}>
            <Link />
            {t("copyLink")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => copy(`git clone ${cloneUrlOf(repo)}`)}
          >
            <Copy />
            {t("copyCloneCommand")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
