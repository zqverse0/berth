"use client"

import { useCallback, useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { ExternalLink, Loader2, RefreshCw, SquareTerminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { getFolderConversation, resolveProjectAgentSession } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  memberLabel,
  readMemberDetail,
  type LaunchRecord,
  type MemberDetail as Detail,
} from "@/lib/agent/berth-group"
import type { ContextSource } from "@/lib/types"
import { StartupContext } from "@/sessions/components/startup-context"
import { folderIdFor } from "@/sessions/project/open-project-session"
import { paneNumber, type MemberRow } from "./group-model"

type Body = Detail["bodies"][number]

/** 一行「名称：值」；值可点开时显示打开按钮。 */
function Field({
  label,
  children,
  path,
}: {
  label: string
  children: React.ReactNode
  path?: string | null
}) {
  const t = useTranslations("BerthTasks.group.members.detail")
  const { openFilePreview } = useWorkspaceRuntimeActions()
  return (
    <div className="flex min-w-0 items-baseline gap-2 py-0.5 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all">{children}</span>
      {path ? (
        <button
          type="button"
          title={path}
          aria-label={t("open", { path })}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => void openFilePreview(path)}
        >
          <ExternalLink aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/** 启动计划的一项：字符串数组显示成标签，其余原样显示。 */
function PlanValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item) => (
          <span
            key={item}
            className="rounded border border-border/60 px-1 font-mono text-[10px]"
          >
            {item}
          </span>
        ))}
      </span>
    )
  if (typeof value === "string") return <>{value}</>
  return <code className="font-mono text-[10px]">{JSON.stringify(value)}</code>
}

const planEntries = (plan: LaunchRecord["plan"]) =>
  Object.entries(plan ?? {}).filter(
    ([, value]) =>
      value != null &&
      !(Array.isArray(value) && value.length === 0) &&
      !(
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
      )
  )

/** 会话文件里记下的启动上下文（每一项的来源、文件、估算 token）；没有会话时为 null。 */
function useSessionContext(folderId: number, body: Body | undefined) {
  const { agents } = useAgentProfiles()
  const agent = body?.agent
  const sessionId = body?.sessionId
  const cwd = body?.cwd
  const projectType = agents.find((item) => item.id === agent)?.projectType
  // 结果按会话记下：换了会话时旧结果不算数，显示加载中。
  const key = `${sessionId}\0${cwd}\0${projectType}`
  const [loaded, setLoaded] = useState<{
    key: string
    context: ContextSource[] | null
    error: string | null
  } | null>(null)
  const current = loaded?.key === key ? loaded : null
  useEffect(() => {
    if (!sessionId || !cwd || !projectType) return
    let live = true
    void (async () => {
      const result = await resolveProjectAgentSession({
        folderId: await folderIdFor(cwd, folderId),
        agentType: projectType,
        externalId: sessionId,
      })
      if (!result.conversation) throw new Error("session unavailable")
      const detail = await getFolderConversation(result.conversation.id)
      if (live) setLoaded({ key, context: detail.context ?? [], error: null })
    })().catch((cause: unknown) => {
      if (live) setLoaded({ key, context: null, error: toErrorMessage(cause) })
    })
    return () => {
      live = false
    }
  }, [folderId, sessionId, cwd, projectType, key])
  return {
    context: current?.context ?? null,
    error: current?.error ?? null,
    hasSession: Boolean(sessionId),
  }
}

function BodyDetail({
  body,
  agentName,
  folderId,
}: {
  body: Body
  agentName: (id: string) => string
  folderId: number
}) {
  const t = useTranslations("BerthTasks.group.members.detail")
  const format = useFormatter()
  const launch = body.launch
  const session = useSessionContext(folderId, body)
  const plan = planEntries(launch?.plan ?? null)
  const model =
    launch?.provider?.model ??
    (typeof launch?.inputs.model === "string" ? launch.inputs.model : null)
  return (
    <div className="space-y-3">
      <Section
        title={t("terminal", { number: paneNumber(body.target_ref) ?? "?" })}
      >
        <Field label={t("agent")}>
          {body.agent ? agentName(body.agent) : "?"}
        </Field>
        {launch?.provider || model ? (
          <Field label={t("model")}>
            {[launch?.provider?.name, model].filter(Boolean).join(" · ")}
          </Field>
        ) : null}
        <Field label={t("expert")} path={launch?.expert?.promptFile}>
          {launch?.expert
            ? `${launch.expert.name} (${launch.expert.id})`
            : t("noExpert")}
        </Field>
        {launch ? (
          <Field label={t("brief")}>
            {launch.brief > 0
              ? t("briefInjected", { count: launch.brief })
              : t("briefNone")}
          </Field>
        ) : null}
        <Field label={t("cwd")}>{body.cwd ?? "?"}</Field>
        <Field label={t("session")} path={body.sessionPath}>
          {body.sessionId ?? t("noSession")}
        </Field>
        {launch ? (
          <Field label={t("startedAt")}>
            {format.dateTime(new Date(launch.startedAt), {
              dateStyle: "short",
              timeStyle: "medium",
            })}
          </Field>
        ) : null}
        {!launch ? (
          <p className="text-[11px] text-muted-foreground">{t("noLaunch")}</p>
        ) : null}
      </Section>
      <Section title={t("context")}>
        {session.context ? (
          session.context.length > 0 ? (
            <StartupContext items={session.context} totalTokens={null} />
          ) : (
            <p className="text-xs text-muted-foreground">{t("contextEmpty")}</p>
          )
        ) : session.error ? (
          <p className="text-xs text-muted-foreground">
            {t("contextFailed", { error: session.error })}
          </p>
        ) : session.hasSession ? (
          <Loader2
            aria-label={t("loading")}
            className="size-3.5 animate-spin text-muted-foreground"
          />
        ) : (
          <p className="text-xs text-muted-foreground">{t("noSession")}</p>
        )}
      </Section>
      {plan.length > 0 || launch?.expert?.skills.length ? (
        <Section title={t("loaded")}>
          {launch?.expert?.skills.length ? (
            <Field label={t("expertSkills")}>
              <PlanValue
                value={launch.expert.skills.map(
                  (path) => path.split(/[\\/]/).pop() ?? path
                )}
              />
            </Field>
          ) : null}
          {plan.map(([key, value]) => (
            <Field key={key} label={key}>
              <PlanValue value={value} />
            </Field>
          ))}
        </Section>
      ) : null}
    </div>
  )
}

/**
 * 成员详情页（群组面板里点了成员）：它的每个终端用了什么 Agent / 模型 / 专家、是否注入 Berth 说明、
 * 会话文件与当前上下文组成、启动时加载的 skills / 扩展 / MCP，以及它最近改过的文件。
 */
export function MemberDetail({
  folderId,
  row,
  agentName,
  onJump,
}: {
  folderId: number
  row: MemberRow
  agentName: (id: string) => string
  onJump: (row: MemberRow) => void
}) {
  const t = useTranslations("BerthTasks.group.members.detail")
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = row.member.name
  const load = useCallback(() => {
    void readMemberDetail(folderId, name).then((response) => {
      setError(response.ok ? null : response.error.message)
      if (response.ok) setDetail(response.result)
    })
  }, [folderId, name])
  // 调用方按成员加 key：换成员即重建，不需要先清空。
  useEffect(load, [load])
  return (
    <div
      data-member-detail={name}
      className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-3"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {memberLabel(row.member)}
          {row.member.label ? (
            <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">
              #{name}
            </span>
          ) : null}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          title={t("refresh")}
          aria-label={t("refresh")}
          onClick={load}
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
        </Button>
        {row.pane ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={t("jump")}
            aria-label={t("jump")}
            onClick={() => onJump(row)}
          >
            <SquareTerminal aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : !detail ? (
        <Loader2
          aria-label={t("loading")}
          className="size-4 animate-spin text-muted-foreground"
        />
      ) : (
        <>
          {detail.bodies.map((body) => (
            <BodyDetail
              key={body.target_ref}
              body={body}
              agentName={agentName}
              folderId={folderId}
            />
          ))}
          <Section title={t("files", { count: detail.files.length })}>
            {detail.files.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noFiles")}</p>
            ) : (
              <ul>
                {detail.files.map((file) => (
                  <li key={`${file.root}\0${file.path}`}>
                    <button
                      type="button"
                      title={`${file.root}/${file.path}`}
                      className="w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-accent"
                      onClick={() =>
                        void openFilePreview(
                          file.root ? `${file.root}/${file.path}` : file.path
                        )
                      }
                    >
                      {file.path}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  )
}
