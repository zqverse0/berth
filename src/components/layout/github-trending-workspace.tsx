"use client"

import { useEffect, useMemo } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Loader2, RefreshCw } from "lucide-react"
import type { TrendingTimeRange } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
} from "@/components/layout/sidebar/sidebar-header"
import {
  GithubRepoRow,
  useGithubRepoActions,
} from "@/components/layout/github-repo-list"
import { useGithubStarredStore } from "@/stores/git/github-starred-store"
import { useGithubTrendingStore } from "@/stores/git/github-trending-store"

/** 剩余配额低于此值才提示，平时不占位置 */
const LOW_RATE_LIMIT = 10

const TIME_RANGES: Array<{
  value: TrendingTimeRange
  labelKey: "rangeDaily" | "rangeWeekly" | "rangeMonthly"
}> = [
  { value: "daily", labelKey: "rangeDaily" },
  { value: "weekly", labelKey: "rangeWeekly" },
  { value: "monthly", labelKey: "rangeMonthly" },
]

export function GithubTrendingWorkspace() {
  const t = useTranslations("ProjectBoot.githubTrending")
  const format = useFormatter()
  const actions = useGithubRepoActions()

  const timeRange = useGithubTrendingStore((s) => s.timeRange)
  const cache = useGithubTrendingStore((s) => s.cache)
  const loading = useGithubTrendingStore((s) => s.loading)
  const error = useGithubTrendingStore((s) => s.error)
  const load = useGithubTrendingStore((s) => s.load)
  const refresh = useGithubTrendingStore((s) => s.refresh)
  const setTimeRange = useGithubTrendingStore((s) => s.setTimeRange)

  const starredRepos = useGithubStarredStore((s) => s.repos)
  const starredHydrated = useGithubStarredStore((s) => s.hydrated)
  const starredHydrating = useGithubStarredStore((s) => s.hydrating)
  const hydrateStarred = useGithubStarredStore((s) => s.hydrate)

  // 加载当前时间跨度的趋势（如果已有缓存则不重复拉取）
  useEffect(() => {
    void load(timeRange, false)
  }, [load, timeRange])

  // 自动水合本地星标仓库缓存以匹配已星标状态
  useEffect(() => {
    if (!starredHydrated && !starredHydrating) {
      void hydrateStarred().catch(() => {})
    }
  }, [starredHydrated, starredHydrating, hydrateStarred])

  const starredSet = useMemo(() => {
    return new Set(starredRepos.map((r) => r.full_name.toLowerCase()))
  }, [starredRepos])

  const currentCache = cache[timeRange]
  const repos = useMemo(() => currentCache?.repos ?? [], [currentCache?.repos])
  const fetchedAt = currentCache?.fetchedAt ?? null
  const rateLimitRemaining = currentCache?.rateLimitRemaining ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeaderActions>
        <SidebarHeaderButton
          icon={RefreshCw}
          label={loading ? t("refreshing") : t("refresh")}
          onClick={() => void refresh()}
          disabled={loading}
          spinning={loading}
        />
      </SidebarHeaderActions>

      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Select
          value={timeRange}
          onValueChange={(value) => setTimeRange(value as TrendingTimeRange)}
        >
          <SelectTrigger className="w-auto" size="sm">
            <SelectValue aria-label={t("range")} />
          </SelectTrigger>
          <SelectContent position="popper">
            {TIME_RANGES.map(({ value, labelKey }) => (
              <SelectItem key={value} value={value}>
                {t(labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={t("source")}
        >
          {fetchedAt &&
            t("updatedAt", {
              time: format.relativeTime(new Date(fetchedAt), new Date()),
            })}
          {rateLimitRemaining !== null &&
            rateLimitRemaining < LOW_RATE_LIMIT &&
            ` · ${t("rateLimit", { count: rateLimitRemaining })}`}
        </p>
      </div>

      {error && (
        <div className="mx-3 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>{error || t("loadFailed")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {t("tryAgain")}
          </Button>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {loading && repos.length === 0 ? (
          <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("loading")}
          </div>
        ) : repos.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="divide-y">
            {repos.map((repo) => (
              <GithubRepoRow
                key={repo.full_name}
                repo={repo}
                isStarred={starredSet.has(repo.full_name.toLowerCase())}
                isStarPending={actions.starPendingName === repo.full_name}
                isCloning={actions.cloningName === repo.full_name}
                onOpen={actions.openReadme}
                onToggleStar={actions.toggleStar}
                onClone={actions.clone}
                onCloneTo={actions.cloneTo}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {actions.dialogs}
    </div>
  )
}
