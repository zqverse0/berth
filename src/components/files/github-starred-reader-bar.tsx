"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Send, Star } from "lucide-react"
import { cn } from "@/lib/utils"
import type { GithubStarredPreviewMeta } from "@/lib/git/github-starred-preview"
import { useGithubStarredStore } from "@/stores/git/github-starred-store"
import { useGithubTrendingStore } from "@/stores/git/github-trending-store"
import { useSendToAgent } from "@/hooks/use-send-to-agent"
import {
  githubRepoReference,
  GithubRepoStats,
  useGithubRepoActions,
  type GithubRepoItem,
} from "@/components/layout/github-repo-list"
import { Button } from "@/components/ui/button"

/**
 * README 预览的工具栏：显示仓库概况并可直接加/取消星标。
 * 打开 GitHub、克隆等操作在侧栏列表行上，这里不重复。
 */
export function GithubStarredHeaderActions({
  meta,
}: {
  meta: GithubStarredPreviewMeta
}) {
  const t = useTranslations("ProjectBoot.githubTrending")
  const key = meta.full_name.toLowerCase()
  const starredRepo = useGithubStarredStore((s) =>
    s.repos.find((r) => r.full_name.toLowerCase() === key)
  )
  const trendingRepo = useGithubTrendingStore((s) =>
    Object.values(s.cache)
      .flatMap((entry) => entry?.repos ?? [])
      .find((r) => r.full_name.toLowerCase() === key)
  )
  const hydrated = useGithubStarredStore((s) => s.hydrated)
  const hydrating = useGithubStarredStore((s) => s.hydrating)
  const hydrate = useGithubStarredStore((s) => s.hydrate)
  const actions = useGithubRepoActions()
  const sendToAgent = useSendToAgent()

  // 重启后直接恢复的预览也要知道星标状态
  useEffect(() => {
    if (!hydrated && !hydrating) void hydrate().catch(() => {})
  }, [hydrated, hydrating, hydrate])

  const known = starredRepo ?? trendingRepo
  const repo: GithubRepoItem = {
    ...meta,
    description: known?.description ?? null,
    owner: known?.owner ?? {
      login: meta.full_name.split("/")[0] ?? "",
      avatar_url: "",
    },
    stargazers_count: known?.stargazers_count ?? null,
    forks_count: known?.forks_count ?? null,
    language: known?.language ?? null,
    license: known?.license ?? null,
  }
  const isStarred = Boolean(starredRepo)
  const pending = actions.starPendingName === meta.full_name
  const label = t(isStarred ? "unstar" : "star")

  return (
    <div className="mr-1 flex items-center gap-2">
      <GithubRepoStats repo={repo} />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => void actions.toggleStar(repo)}
        disabled={pending}
        title={label}
        aria-label={label}
      >
        {pending ? (
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
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => void sendToAgent.send(githubRepoReference(repo))}
        title={sendToAgent.label}
        aria-label={sendToAgent.label}
      >
        <Send className="h-3.5 w-3.5" />
      </Button>
      {actions.dialogs}
    </div>
  )
}
