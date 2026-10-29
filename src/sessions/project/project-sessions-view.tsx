"use client"

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ArrowLeft, ChevronRight, RefreshCw, Users } from "lucide-react"
import { toast } from "@/lib/notify"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
  SidebarHeaderTabs,
} from "@/components/layout/sidebar/sidebar-header"
import { useSidebarViewStore } from "@/components/layout/sidebar/views"
import {
  SessionDetailsTab,
  useFocusedSessionTitle,
} from "@/components/layout/aux-panel/aux-panel-session-details-tab"
import { MemberAvatar } from "@/components/project-management/group/group-timeline"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { listProjectSessionOverview } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useAllAgentPanes } from "@/lib/terminal/agent-panes"
import type { ProjectSessionOverviewItem } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { PROJECT_GROUP } from "@/lib/agent/berth-group"
import { useTabStore } from "@/stores/tab-store"
import {
  folderIdFor,
  trimSlash,
  useOpenProjectSession,
} from "@/sessions/project/open-project-session"

const PAGE = 50
type Origin = ProjectSessionOverviewItem["origin"]
const ORIGINS: Origin[] = ["berth", "external", "unknown"]

// 列表筛选按项目记住上次选择（搜索词不记）。
const FILTERS_KEY = "berth.sessionsView.filters"
type SavedFilters = {
  live: boolean
  agent: string
  origin: Origin | ""
  group: string
}
const NO_FILTERS: SavedFilters = {
  live: false,
  agent: "",
  origin: "",
  group: "",
}

function readSavedFilters(): Record<string, SavedFilters> {
  try {
    return JSON.parse(window.localStorage.getItem(FILTERS_KEY) ?? "{}")
  } catch {
    return {}
  }
}

function saveFilters(folderId: number, filters: SavedFilters): void {
  try {
    window.localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({ ...readSavedFilters(), [folderId]: filters })
    )
  } catch {
    // 持久化失败只影响下次打开。
  }
}

/**
 * 侧栏「会话」视图，两级：本项目全部群目录下的 Agent 会话列表 → 当前焦点会话的
 * 大纲（阅读标签的目录 / Agent 终端的实时会话）。列表在第二级时保持挂载，返回时
 * 筛选与滚动位置不丢。
 */
export function ProjectSessionsView({
  folderId,
  active,
}: {
  folderId: number
  active: boolean
}) {
  const t = useTranslations("Folder.sessionsView")
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  const { agents } = useAgentProfiles()
  const openSession = useOpenProjectSession(folderId)
  const [filters, setFilters] = useState(() => ({
    ...NO_FILTERS,
    ...readSavedFilters()[folderId],
    query: "",
  }))
  const [inDetail, setInDetail] = useState(false)
  const focusTitle = useFocusedSessionTitle()
  const [limit, setLimit] = useState(PAGE)
  const [reload, setReload] = useState(0)
  /** 最近一次返回的结果；`key` 对应发出它的请求，与当前请求不同即在加载。 */
  const [page, setPage] = useState({
    key: "",
    items: [] as ProjectSessionOverviewItem[],
    hasMore: false,
    error: null as string | null,
  })
  const setFilter = (patch: Partial<typeof filters>) =>
    setFilters((current) => ({ ...current, ...patch }))
  const { live, agent, origin, group } = filters
  useEffect(() => {
    saveFilters(folderId, { live, agent, origin, group })
  }, [folderId, live, agent, origin, group])

  // 在跑的 Agent 终端增减时重读一次（复用全局 pane 轮询，不另起轮询）。
  const panes = useAllAgentPanes()
  const liveKey = useMemo(
    () =>
      panes
        .filter((row) => row.descriptor.agentId && row.state !== "exited")
        .map((row) => row.descriptor.terminalId)
        .sort()
        .join(","),
    [panes]
  )

  const requestKey = `${folderId}:${limit}:${reload}:${liveKey}`
  const loading = active && page.key !== requestKey
  useEffect(() => {
    if (!active) return
    let cancelled = false
    listProjectSessionOverview(folderId, limit)
      .then((result) => {
        if (!cancelled) setPage({ key: requestKey, ...result, error: null })
      })
      .catch((error) => {
        if (!cancelled)
          setPage((current) => ({
            ...current,
            key: requestKey,
            error: toErrorMessage(error),
          }))
      })
    return () => {
      cancelled = true
    }
  }, [active, folderId, limit, requestKey])

  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? id
  const choices = useMemo(
    () => ({
      // 记住的筛选值即使本页暂时没有对应会话，也留在选项里，免得显示成「任意」却在过滤。
      agents: [
        ...new Set([...page.items.map((item) => item.agent), agent]),
      ].filter(Boolean),
      groups: [
        ...new Set([...page.items.map((item) => item.groupName), group]),
      ].filter(Boolean),
    }),
    [page.items, agent, group]
  )
  const shown = useMemo(() => {
    const needle = filters.query.trim().toLowerCase()
    return page.items.filter(
      (item) =>
        (!filters.live || item.liveMember) &&
        (!filters.agent || item.agent === filters.agent) &&
        (!filters.origin || item.origin === filters.origin) &&
        (!filters.group || item.groupName === filters.group) &&
        (!needle ||
          [item.title, item.sessionId, item.groupName]
            .filter(Boolean)
            .some((text) => text!.toLowerCase().includes(needle)))
    )
  }, [page.items, filters])

  /** 不能打开时的原因；能打开为 null。 */
  const blocked = (item: ProjectSessionOverviewItem) => {
    const projectType = agents.find((a) => a.id === item.agent)?.projectType
    if (!item.sessionId || !projectType) return t("cannotOpenAgent")
    if (trimSlash(item.cwd) !== trimSlash(item.groupDir))
      return t("cannotOpenSubdir")
    return null
  }

  const open = (item: ProjectSessionOverviewItem) => {
    const reason = blocked(item)
    if (reason || !item.sessionId) {
      if (reason) toast(reason)
      return
    }
    void openSession({
      agent: item.agent,
      sessionId: item.sessionId,
      cwd: item.cwd,
      title: item.title,
    })
    setInDetail(true)
  }

  const showMember = async (item: ProjectSessionOverviewItem) => {
    if (!item.liveMember) return
    try {
      const target = await folderIdFor(item.groupDir, folderId)
      useTabStore.getState().activateFolderWorkspace(target)
      // 在群页按这个成员看它的委托与结果。
      const store = useGroupWorkspaceStore.getState()
      store.selectGroup(target, PROJECT_GROUP)
      store.setFocusedMember(item.liveMember)
      useAppUiStore.getState().showAuxView("group")
      useSidebarViewStore.getState().setView("group")
    } catch (error) {
      toast.error(t("openFailed", { error: toErrorMessage(error) }))
    }
  }

  const select =
    "h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-1.5 text-xs text-foreground"

  return (
    <div className="flex h-full min-h-0 flex-col">
      {inDetail ? (
        <div className="flex h-full min-h-0 flex-col">
          <button
            type="button"
            className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            onClick={() => setInDetail(false)}
          >
            <ArrowLeft aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{focusTitle ?? t("back")}</span>
          </button>
          <div className="min-h-0 flex-1">
            <SessionDetailsTab />
          </div>
        </div>
      ) : (
        <>
          <SidebarHeaderTabs
            tabs={[
              { id: "all", label: t("all") },
              { id: "live", label: t("live") },
            ]}
            value={filters.live ? "live" : "all"}
            onChange={(id) => setFilter({ live: id === "live" })}
          />
          <SidebarHeaderActions>
            <SidebarHeaderButton
              icon={RefreshCw}
              label={t("refresh")}
              spinning={loading}
              disabled={loading}
              onClick={() => setReload((count) => count + 1)}
            />
          </SidebarHeaderActions>
        </>
      )}
      <div className={cn("flex min-h-0 flex-1 flex-col", inDetail && "hidden")}>
        {focusTitle ? (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2 py-1.5 text-left text-xs hover:bg-accent/40"
            onClick={() => setInDetail(true)}
          >
            <span className="shrink-0 text-muted-foreground">
              {t("current")}
            </span>
            <span className="min-w-0 flex-1 truncate">{focusTitle}</span>
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </button>
        ) : null}
        <div className="space-y-1.5 border-b border-border/50 px-2 py-2">
          <Input
            value={filters.query}
            placeholder={t("search")}
            aria-label={t("search")}
            className="h-7 text-xs"
            onChange={(event) => setFilter({ query: event.target.value })}
          />
          <div className="flex gap-1">
            <select
              aria-label={t("agent")}
              className={select}
              value={filters.agent}
              onChange={(event) => setFilter({ agent: event.target.value })}
            >
              <option value="">{t("anyAgent")}</option>
              {choices.agents.map((id) => (
                <option key={id} value={id}>
                  {agentName(id)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("origin")}
              className={select}
              value={filters.origin}
              onChange={(event) =>
                setFilter({ origin: event.target.value as Origin | "" })
              }
            >
              <option value="">{t("anyOrigin")}</option>
              {ORIGINS.map((origin) => (
                <option key={origin} value={origin}>
                  {t(`origins.${origin}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("group")}
              className={select}
              value={filters.group}
              onChange={(event) => setFilter({ group: event.target.value })}
            >
              <option value="">{t("anyGroup")}</option>
              {choices.groups.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
          {page.error ? (
            <p role="alert" className="px-2 py-1 text-xs text-destructive">
              {page.error}
            </p>
          ) : null}
          {!loading && !page.error && shown.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("empty")}
            </p>
          ) : null}
          {shown.map((item) => {
            const reason = blocked(item)
            return (
              <div
                key={`${item.agent}:${item.sessionId ?? item.updatedAt}`}
                data-session={item.sessionId ?? undefined}
                className="group flex items-center gap-1 rounded-md hover:bg-accent/40"
              >
                <button
                  type="button"
                  aria-disabled={reason != null}
                  title={reason ?? t("open")}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left",
                    reason && "cursor-default opacity-70"
                  )}
                  onClick={() => open(item)}
                >
                  <span className="relative">
                    <MemberAvatar
                      agent={item.agent}
                      name={agentName(item.agent)}
                    />
                    {item.liveMember ? (
                      <span
                        aria-hidden="true"
                        className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-sm">
                        {item.title || t("untitled")}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/80">
                        {format.relativeTime(
                          new Date(Math.min(item.updatedAt, now.getTime())),
                          now
                        )}
                      </span>
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {agentName(item.agent)} · {item.groupName} ·{" "}
                      {t(`origins.${item.origin}`)}
                      {item.liveMember ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {" · "}
                          {t("liveAs", { member: item.liveMember })}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
                {item.liveMember ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mr-1 size-6 shrink-0 text-muted-foreground hover:text-foreground"
                    title={t("memberInGroup")}
                    aria-label={t("memberInGroup")}
                    onClick={() => void showMember(item)}
                  >
                    <Users aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            )
          })}
          {page.hasMore ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-7 w-full text-xs text-muted-foreground"
              disabled={loading}
              onClick={() => setLimit((current) => current + PAGE)}
            >
              {t("loadMore")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
