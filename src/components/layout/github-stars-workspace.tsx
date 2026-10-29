"use client"

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { Loader2, RefreshCw, SlidersHorizontal } from "lucide-react"
import { Virtualizer } from "virtua"
import { toErrorMessage } from "@/lib/app-error"
import {
  filterStarredRepos,
  NO_LICENSE_SENTINEL,
  normalizeLicense,
  uniqueValues,
  type StarredSortBy,
} from "@/lib/git/github-starred-search"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
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
import {
  GITHUB_STARRED_FILTER_ALL as ALL,
  useGithubStarredStore,
} from "@/stores/git/github-starred-store"

const MAX_FILTER_OPTIONS = 80

export function GithubStarsWorkspace() {
  const t = useTranslations("ProjectBoot.githubStars")
  const format = useFormatter()
  const actions = useGithubRepoActions()
  const accounts = useGithubStarredStore((s) => s.accounts)
  const repos = useGithubStarredStore((s) => s.repos)
  const syncedAt = useGithubStarredStore((s) => s.syncedAt)
  const cacheAccountId = useGithubStarredStore((s) => s.cacheAccountId)
  const query = useGithubStarredStore((s) => s.query)
  const sortBy = useGithubStarredStore((s) => s.sortBy)
  const language = useGithubStarredStore((s) => s.language)
  const topic = useGithubStarredStore((s) => s.topic)
  const license = useGithubStarredStore((s) => s.license)
  const hydrated = useGithubStarredStore((s) => s.hydrated)
  const hydrating = useGithubStarredStore((s) => s.hydrating)
  const syncing = useGithubStarredStore((s) => s.syncing)
  const hydrate = useGithubStarredStore((s) => s.hydrate)
  const sync = useGithubStarredStore((s) => s.sync)
  const setQuery = useGithubStarredStore((s) => s.setQuery)
  const setSortBy = useGithubStarredStore((s) => s.setSortBy)
  const setLanguage = useGithubStarredStore((s) => s.setLanguage)
  const setTopic = useGithubStarredStore((s) => s.setTopic)
  const setLicense = useGithubStarredStore((s) => s.setLicense)
  const [queryDraft, setQueryDraft] = useState(query)

  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback((element: HTMLElement | null) => {
    viewportRef.current = element
    setViewportEl(element)
  }, [])

  useEffect(() => {
    void hydrate().catch((err) => toast.error(toErrorMessage(err)))
  }, [hydrate])

  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(queryDraft), 150)
    return () => window.clearTimeout(handle)
  }, [queryDraft, setQuery])

  const defaultAccount = useMemo(
    () => accounts.accounts.find((a) => a.is_default) ?? accounts.accounts[0],
    [accounts]
  )

  const handleSync = useCallback(async () => {
    if (!defaultAccount) {
      actions.requestAccount()
      return
    }
    try {
      await sync()
    } catch (err) {
      toast.error(t("syncFailed"), { description: toErrorMessage(err) })
    }
  }, [defaultAccount, sync, t, actions])

  const languages = useMemo(
    () =>
      uniqueValues(repos.map((r) => r.language)).slice(0, MAX_FILTER_OPTIONS),
    [repos]
  )
  const topics = useMemo(
    () =>
      uniqueValues(repos.flatMap((r) => r.topics)).slice(0, MAX_FILTER_OPTIONS),
    [repos]
  )
  const licenses = useMemo(
    () =>
      uniqueValues(repos.map((r) => normalizeLicense(r.license))).slice(
        0,
        MAX_FILTER_OPTIONS
      ),
    [repos]
  )

  const deferredQuery = useDeferredValue(query)
  const deferredLanguage = useDeferredValue(language)
  const deferredTopic = useDeferredValue(topic)
  const deferredLicense = useDeferredValue(license)
  const deferredSortBy = useDeferredValue(sortBy)

  const visible = useMemo(
    () =>
      filterStarredRepos(repos, {
        query: deferredQuery,
        languages: deferredLanguage === ALL ? [] : [deferredLanguage],
        topics: deferredTopic === ALL ? [] : [deferredTopic],
        licenses: deferredLicense === ALL ? [] : [deferredLicense],
        sortBy: deferredSortBy,
        sortOrder: "desc",
      }),
    [
      repos,
      deferredQuery,
      deferredLanguage,
      deferredTopic,
      deferredLicense,
      deferredSortBy,
    ]
  )

  const cacheMismatch = Boolean(
    cacheAccountId && defaultAccount && cacheAccountId !== defaultAccount.id
  )
  const showSpinner = !hydrated && hydrating
  const activeFilterCount = [language, topic, license].filter(
    (v) => v !== ALL
  ).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeaderActions>
        <SidebarHeaderButton
          icon={RefreshCw}
          label={syncing ? t("syncing") : t("sync")}
          onClick={() => void handleSync()}
          disabled={syncing}
          spinning={syncing}
        />
      </SidebarHeaderActions>
      <div className="shrink-0 space-y-1.5 border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            placeholder={t("search")}
            className="h-8 min-w-0 flex-1"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="relative shrink-0"
                aria-label={t("filter")}
                title={t("filter")}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {activeFilterCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 space-y-2 p-2">
              <Select
                value={sortBy}
                onValueChange={(v) => setSortBy(v as StarredSortBy)}
              >
                <SelectTrigger className="w-full" size="sm">
                  <SelectValue placeholder={t("sort")} />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="stars">{t("sortStars")}</SelectItem>
                  <SelectItem value="updated">{t("sortUpdated")}</SelectItem>
                  <SelectItem value="starred">{t("sortStarred")}</SelectItem>
                  <SelectItem value="name">{t("sortName")}</SelectItem>
                </SelectContent>
              </Select>
              <FilterSelect
                value={language}
                onChange={setLanguage}
                allLabel={t("allLanguages")}
                options={languages}
              />
              <FilterSelect
                value={topic}
                onChange={setTopic}
                allLabel={t("allTopics")}
                options={topics}
              />
              <FilterSelect
                value={license}
                onChange={setLicense}
                allLabel={t("allLicenses")}
                options={licenses}
                labelFor={(v) =>
                  v === NO_LICENSE_SENTINEL ? t("noLicense") : v
                }
              />
            </PopoverContent>
          </Popover>
        </div>
        {defaultAccount ? (
          <p
            className="truncate text-[11px] text-muted-foreground"
            title={defaultAccount.server_url}
          >
            {defaultAccount.username} ·{" "}
            {syncedAt
              ? t("syncedAt", {
                  time: format.relativeTime(new Date(syncedAt), new Date()),
                })
              : t("neverSynced")}
          </p>
        ) : (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0">{t("emptyAccount")}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-[11px]"
              onClick={actions.requestAccount}
            >
              {t("addAccount")}
            </Button>
          </div>
        )}
        {cacheMismatch && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            {t("otherAccountCache")}
          </p>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1" onViewportRef={handleViewportRef}>
        {showSpinner ? (
          <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {repos.length === 0 ? t("emptyCache") : t("emptyFilter")}
          </p>
        ) : viewportEl ? (
          <Virtualizer scrollRef={viewportRef} itemSize={72}>
            {visible.map((repo) => (
              <GithubRepoRow
                key={repo.id}
                repo={repo}
                isStarred
                isStarPending={actions.starPendingName === repo.full_name}
                isCloning={actions.cloningName === repo.full_name}
                onOpen={actions.openReadme}
                onToggleStar={actions.toggleStar}
                onClone={actions.clone}
                onCloneTo={actions.cloneTo}
              />
            ))}
          </Virtualizer>
        ) : null}
      </ScrollArea>

      {actions.dialogs}
    </div>
  )
}

const FilterSelect = memo(function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  labelFor,
}: {
  value: string
  onChange: (value: string) => void
  allLabel: string
  options: string[]
  labelFor?: (value: string) => string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labelFor ? labelFor(option) : option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
})
