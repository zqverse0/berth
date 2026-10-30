"use client"

import { useEffect, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { toast } from "@/lib/notify"
import { Button } from "@/components/ui/button"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { listProjectSessionOverview } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { listBerthSessions, type GroupEvent } from "@/lib/agent/berth-group"
import {
  trimSlash,
  useOpenProjectSession,
} from "@/sessions/project/open-project-session"
import { cn } from "@/lib/utils"
import type { MemberRow } from "./group-model"

const PAGE = 100

/** 会话列表的一行：标题、时间、标记（当前 / 它的），点开到工作区标签。 */
interface Entry {
  key: string
  title: string | null
  updatedAt: number | null
  /** Berth 的当前会话；Agent 成员在跑、绑定或汇报过的会话。 */
  mark: string | null
  /** 不能打开的原因；能打开为 null。 */
  blocked: string | null
  open: () => void
}

/**
 * 成员卡片展开的会话列表，新的在前：Berth 是它在本项目的会话；Agent 成员是它所用 Agent 在本项目
 * （主目录与各群目录）的会话，它在跑、绑定或汇报过的标出来。
 */
export function MemberSessions({
  row,
  folderId,
  events,
}: {
  row: MemberRow
  folderId: number
  events: readonly GroupEvent[]
}) {
  const t = useTranslations("BerthTasks.group.members.sessions")
  const tView = useTranslations("Folder.sessionsView")
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  const workspace = useWorkspaceRuntimeActions()
  const openSession = useOpenProjectSession(folderId)
  const { member } = row
  const [limit, setLimit] = useState(PAGE)
  const [page, setPage] = useState<{
    entries: Entry[]
    hasMore: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const agents = new Set(member.bodies.map((body) => body.agent))
  const agentKey = [...agents].sort().join(",")

  useEffect(() => {
    let live = true
    const done = (entries: Entry[], hasMore = false) => {
      if (live) setPage({ entries, hasMore })
    }
    const fail = (cause: unknown) => {
      if (live) setError(toErrorMessage(cause))
    }
    if (member.builtin) {
      listBerthSessions(folderId)
        .then((response) => {
          if (!response.ok) return fail(response.error.message)
          done(
            response.result.map((session, index) => ({
              key: session.name,
              title: session.title,
              updatedAt: session.updatedAt,
              mark: index === 0 ? t("current") : null,
              blocked: null,
              open: () =>
                workspace.openBerthSessionTab({
                  folderId,
                  session: session.name,
                  title: `Berth · ${session.title ?? session.name}`,
                }),
            }))
          )
        })
        .catch(fail)
    } else {
      // 它绑定过或汇报出自的会话。
      const own = new Set([
        ...member.bodies.map((body) => body.sessionId),
        ...events
          .filter((event) => event.author === member.name)
          .map((event) => event.session_id),
      ])
      // ponytail: 总览按全部 Agent 取最近 N 条再筛，Agent 多、会话多时这位成员的旧会话要点「更多」。
      listProjectSessionOverview(folderId, limit)
        .then((overview) =>
          done(
            overview.items
              .filter((item) => agentKey.split(",").includes(item.agent))
              .map((item) => ({
                key: `${item.agent}:${item.sessionId ?? item.updatedAt}`,
                title: item.title,
                updatedAt: item.updatedAt,
                mark:
                  item.liveMember === member.name
                    ? t("live")
                    : item.sessionId && own.has(item.sessionId)
                      ? t("own")
                      : null,
                blocked: !item.sessionId
                  ? tView("cannotOpenAgent")
                  : trimSlash(item.cwd) !== trimSlash(item.groupDir)
                    ? tView("cannotOpenSubdir")
                    : null,
                open: () =>
                  void openSession({
                    agent: item.agent,
                    sessionId: item.sessionId!,
                    cwd: item.cwd,
                    title: item.title,
                  }),
              })),
            overview.hasMore
          )
        )
        .catch(fail)
    }
    return () => {
      live = false
    }
    // 只在成员、Agent 与页数变化时重读；回调每次渲染都是新的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, member.name, member.builtin, agentKey, limit])

  if (error)
    return (
      <p role="alert" className="px-2 py-1 text-[11px] text-destructive">
        {error}
      </p>
    )
  if (!page)
    return (
      <Loader2
        aria-label={t("loading")}
        className="mx-auto my-1 size-3.5 animate-spin text-muted-foreground"
      />
    )
  return (
    <div data-member-sessions={member.name} className="space-y-px">
      {page.entries.length === 0 ? (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          {tView("empty")}
        </p>
      ) : null}
      {page.entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          data-member-session={entry.key}
          aria-disabled={entry.blocked != null}
          title={entry.blocked ?? tView("open")}
          className={cn(
            "flex w-full min-w-0 items-baseline gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-accent/60",
            entry.blocked && "cursor-default opacity-60"
          )}
          onClick={() => (entry.blocked ? toast(entry.blocked) : entry.open())}
        >
          <span className="min-w-0 flex-1 truncate">
            {entry.title || tView("untitled")}
          </span>
          {entry.mark ? (
            <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
              {entry.mark}
            </span>
          ) : null}
          {entry.updatedAt ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/80">
              {format.relativeTime(
                new Date(Math.min(entry.updatedAt, now.getTime())),
                now
              )}
            </span>
          ) : null}
        </button>
      ))}
      {page.hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-full text-[11px] text-muted-foreground"
          onClick={() => setLimit((current) => current + PAGE)}
        >
          {tView("loadMore")}
        </Button>
      ) : null}
    </div>
  )
}
