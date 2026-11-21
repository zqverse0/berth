"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { GroupComposer } from "@/components/project-management/group/group-composer"
import {
  memberRows,
  filterMemberEvents,
  type MemberRow,
} from "@/components/project-management/group/group-model"
import { GroupLiveStatus } from "@/components/project-management/group/group-live-status"
import { GroupPermissions } from "@/components/project-management/group/group-permissions"
import { GroupTimeline } from "@/components/project-management/group/group-timeline"
import { usePaneActions } from "@/components/project-management/group/pane-actions"
import { useTaskGroup } from "@/components/project-management/group/use-task-group"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import {
  type GroupEvent,
  controlAcpMember,
  memberAgent,
  memberLabel,
  newSendBatch,
  postToMember,
} from "@/lib/agent/berth-group"
import { useAgentPaneStore, useAllAgentPanes } from "@/lib/terminal/agent-panes"
import { terminateTerminalSessionIdempotent } from "@/lib/terminal/terminal-record-cleanup"
import { handoffAcpMember } from "@/components/project-management/group/acp-handoff"

/**
 * 群对话主体，嵌在空间首页下部（一个空间一个群）：时间线（往上翻再读）、实时状态、审批卡片、输入框。
 * 单聊对象由侧栏群组视图选（{@link useGroupWorkspaceStore}），群聊不指定收件人、由负责人兜底。
 * 调用方按 folderId 加 key 重建。
 */
export function GroupPanel({ folderId }: { folderId: number }) {
  const t = useTranslations("BerthTasks.group")
  const group = useTaskGroup(folderId, true)
  const name = group.name
  useEffect(() => {
    if (name) useGroupWorkspaceStore.getState().selectGroup(folderId, name)
  }, [folderId, name])
  const workspace = useWorkspaceRuntimeActions()
  const panes = useAllAgentPanes()
  const seen = useAgentPaneStore((state) => state.seen)
  // 时间线是 memo 组件：跳转回调保持引用稳定，读最新的 pane 列表。
  const { jump } = usePaneActions()
  const latest = useRef({ panes, jump })
  useEffect(() => {
    latest.current = { panes, jump }
  })
  const openTerminal = useCallback(
    (targetRef: string) => {
      const pane = latest.current.panes.find(
        (row) => row.descriptor.targetRef === targetRef
      )
      if (pane) latest.current.jump(pane)
      else toast.info(t("terminalClosed"))
    },
    [t]
  )
  const [posting, setPosting] = useState(false)
  const storedFocus = useGroupWorkspaceStore((state) =>
    name && state.folderId === folderId && state.group === name
      ? state.focusedMember
      : null
  )
  const setFocus = (member: string | null) => {
    if (!name) return
    const store = useGroupWorkspaceStore.getState()
    store.selectGroup(folderId, name)
    store.setFocusedMember(member)
  }
  const rows = useMemo(
    () => memberRows(group.members, group.events, panes, seen),
    [group.members, group.events, panes, seen]
  )
  // 记住的单聊对象已不是成员（如已移出的 ACP 成员）：回到群聊。
  const focus =
    storedFocus == null ||
    rows.length === 0 ||
    rows.some((row) => row.member.name === storedFocus)
      ? storedFocus
      : null
  const [reply, setReply] = useState<GroupEvent | null>(null)
  // 回复 / 转给时收件人是这位成员（不一定是被引消息的作者）。
  const [replyMember, setReplyMember] = useState<string | null>(null)
  const [context, setContext] = useState<{ seq: number } | null>(null)
  // 时间线是 memo 组件：传给它的派生数据与回调保持引用稳定，无关重渲染（打开文件、
  // 成员 pane 轮询）不会让几百条消息跟着重画。
  const members = group.members
  const agentOf = useCallback(
    (member: string) => {
      const found = members.find((m) => m.name === member)
      return found ? memberAgent(found) : null
    },
    [members]
  )
  const labelOf = useCallback(
    (member: string) =>
      memberLabel(members.find((m) => m.name === member) ?? { name: member }),
    [members]
  )
  // 成员正在用的会话（最近入群的、报告过会话的终端）：进行中的提问下显示它的日志。
  const liveSessionOf = useCallback(
    (member: string) => {
      const body = [...(members.find((m) => m.name === member)?.bodies ?? [])]
        .reverse()
        .find((body) => body.sessionId && body.agent)
      return body
        ? {
            folderId,
            agent: body.agent!,
            sessionId: body.sessionId!,
            cwd: body.cwd ?? null,
          }
        : null
    },
    [members, folderId]
  )
  // Berth 与 ACP 成员没有会话可读：正在回答的提问下显示运行时报的过程。
  const liveLogOf = useCallback(
    (ask: GroupEvent) =>
      members.find((m) => m.log?.ask === ask.seq)?.log?.lines ?? null,
    [members]
  )
  // 汇报的过程日志：它出自的会话（Berth 是随回答存下的过程），从它回答的那条提问读起。
  const events = group.events
  const processOf = useCallback(
    (event: GroupEvent) => {
      const ask = events.find((other) => other.seq === event.reply_to)
      if (!ask) return null
      if (event.steps?.length)
        return { lines: event.steps, since: ask.timestamp_ms }
      if (!event.session_id || !event.agent) return null
      const body = members
        .find((m) => m.name === event.author)
        ?.bodies.find((body) => body.target_ref === event.target_ref)
      return {
        session: {
          folderId,
          agent: event.agent,
          sessionId: event.session_id,
          cwd: body?.cwd ?? event.root ?? null,
        },
        since: ask.timestamp_ms,
      }
    },
    [events, members, folderId]
  )
  const openFile = useCallback(
    (path: string) => void workspace.openFilePreview(path, { folderId }),
    [workspace, folderId]
  )
  const timelineEvents = useMemo(
    () => filterMemberEvents(group.events, focus),
    [group.events, focus]
  )
  const openTimelineContext = useCallback(
    (seq: number) => {
      const store = useGroupWorkspaceStore.getState()
      if (name) store.selectGroup(folderId, name)
      store.setFocusedMember(null)
      setContext({ seq })
    },
    [folderId, name]
  )
  const replyTo = useCallback((event: GroupEvent) => {
    if (!event.author) return
    setReplyMember(event.author)
    setReply(event)
  }, [])
  // 转给另一位成员：引用这条回答发给它（送达时附上摘录），比如让它交叉审阅。
  const forward = useCallback((event: GroupEvent, member: string) => {
    setReplyMember(member)
    setReply(event)
  }, [])
  const forwardTo = useMemo(() => rows.map((row) => row.member.name), [rows])
  // 收件人：回复 / 转给的对象 > 单聊的成员；群聊不指定，由后端交给负责人。
  const targets = useMemo(
    () => (reply && replyMember ? [replyMember] : focus ? [focus] : []),
    [reply, replyMember, focus]
  )
  const openMemberTerminal = useCallback(
    (row: MemberRow) => {
      if (row.pane) jump(row.pane)
    },
    [jump]
  )
  const openCommit = useCallback(
    (hash: string, subject: string) =>
      void workspace.openCommitDiff(hash, undefined, subject, {
        folderId,
      }),
    [folderId, workspace]
  )

  // 和 ACP 成员单聊时的成员操作。
  const acpRow =
    rows.find((row) => row.member.name === focus && !row.member.builtin) ?? null
  const controlMember = async (action: "stop" | "new" | "leave") => {
    if (!name || !acpRow) return
    const member = acpRow.member.name
    const response = await controlAcpMember(
      folderId,
      name,
      member,
      action
    ).catch((cause: unknown) => ({
      ok: false as const,
      error: { message: String(cause) },
    }))
    if (!response.ok) {
      toast.error(response.error.message)
      return
    }
    if (action === "new") toast.success(t("acp.newDone"))
    if (action === "leave") setFocus(null)
    group.refresh()
  }

  // 在终端打开：交接后用同一会话开终端（见 handoffAcpMember）。
  const handoffMember = async () => {
    if (!name || !acpRow) return
    const member = acpRow.member.name
    const failure = await handoffAcpMember(
      folderId,
      name,
      member,
      labelOf(member)
    )
    group.refresh()
    if (failure === "failed") toast.error(t("acp.handoffFailed"))
    else if (failure === "unsupported") toast.error(t("acp.handoffUnsupported"))
    else if (failure) toast.error(failure.message)
  }
  const returnMember = async (row: MemberRow) => {
    if (!name) return
    const terminal = row.member.handedTo
    if (terminal) {
      const closed = await terminateTerminalSessionIdempotent(terminal)
        .then(() => true)
        .catch((cause: unknown) => {
          toast.error(String(cause))
          return false
        })
      if (!closed) return
    }
    const response = await controlAcpMember(
      folderId,
      name,
      row.member.name,
      "return"
    )
    if (!response.ok) toast.error(response.error.message)
    group.refresh()
  }
  // 交给终端的会话：那个终端退出（或关掉）后自动交回。只认这次见过它在跑，刚打开页面时 pane 还没列全不误判。
  const handedAlive = useRef(new Set<string>())
  useEffect(() => {
    if (!name) return
    for (const row of rows) {
      const terminal = row.member.handedTo
      if (!terminal) continue
      if (row.pane && row.pane.state !== "exited") {
        handedAlive.current.add(terminal)
      } else if (handedAlive.current.delete(terminal)) {
        void controlAcpMember(folderId, name, row.member.name, "return").then(
          () => group.refresh()
        )
      }
    }
  }, [rows, name, folderId, group])

  const send = async (to: string[], text: string, replyTo?: number) => {
    if (!name || posting) return to
    setPosting(true)
    const batch = newSendBatch()
    const failed: string[] = []
    let firstError: string | null = null
    // 群聊不指定收件人：发一条到群里。
    for (const member of to.length ? to : [undefined]) {
      const row = rows.find((row) => row.member.name === member)
      // 已不在群里的成员不发。
      if (member && !row) {
        failed.push(member)
        firstError ??= t("composer.unavailable", { names: labelOf(member) })
        continue
      }
      const response = await postToMember(
        folderId,
        name,
        member,
        text,
        batch,
        replyTo
      ).catch((cause: unknown) => ({
        ok: false as const,
        error: { message: String(cause) },
      }))
      if (!response.ok) {
        if (member) failed.push(member)
        firstError ??= response.error.message
      }
    }
    if (firstError) {
      toast.error(
        to.length > 1
          ? t("composer.partialFailed", {
              names: failed.map(labelOf).join(", "),
              error: firstError,
            })
          : firstError
      )
    }
    group.refresh()
    setPosting(false)
    return failed
  }

  return (
    <div
      data-group-panel={name ?? ""}
      className="flex h-full min-h-0 flex-col bg-background ws-transparent-bg text-sm"
    >
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {group.error ? (
            <p role="alert" className="px-5 py-2 text-destructive">
              {group.error}
            </p>
          ) : null}
          {focus ? (
            <div
              data-acp-actions={acpRow?.member.name}
              className="flex shrink-0 items-center gap-1 border-b px-5 py-1 text-xs"
            >
              <span className="truncate font-medium">
                {t("focus.with", { name: labelOf(focus) })}
              </span>
              <button
                type="button"
                data-group-back
                className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setFocus(null)}
              >
                {t("focus.back")}
              </button>
              {acpRow ? (
                <>
                  {acpRow.member.handedTo != null ? (
                    <>
                      <span className="px-2 text-muted-foreground">
                        {t("acp.inTerminal")}
                      </span>
                      {acpRow.pane ? (
                        <button
                          type="button"
                          data-acp-action="jump"
                          className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => openMemberTerminal(acpRow)}
                        >
                          {t("acp.jump")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-acp-action="return"
                        title={t("acp.returnHint")}
                        className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => void returnMember(acpRow)}
                      >
                        {t("acp.return")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-acp-action="handoff"
                      title={t("acp.handoffHint")}
                      disabled={
                        acpRow.member.busy ||
                        !acpRow.member.bodies.some((body) => body.sessionId)
                      }
                      className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      onClick={() =>
                        void handoffMember().catch((cause: unknown) =>
                          toast.error(String(cause))
                        )
                      }
                    >
                      {t("acp.handoff")}
                    </button>
                  )}
                  {acpRow.member.busy ? (
                    <button
                      type="button"
                      data-acp-action="stop"
                      className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => void controlMember("stop")}
                    >
                      {t("acp.stop")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-acp-action="new"
                    disabled={acpRow.member.handedTo != null}
                    title={t("acp.newHint")}
                    className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                    onClick={() => void controlMember("new")}
                  >
                    {t("acp.new")}
                  </button>
                  <button
                    type="button"
                    data-acp-action="leave"
                    title={t("acp.leaveHint")}
                    className="ml-auto rounded px-2 py-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void controlMember("leave")}
                  >
                    {t("acp.leave")}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {group.more ? (
            <button
              type="button"
              data-group-older
              className="shrink-0 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={group.loadOlder}
            >
              {t("older")}
            </button>
          ) : null}
          <>
            <GroupTimeline
              events={timelineEvents}
              allEvents={group.events}
              scopeKey={focus ? `member:${focus}` : "all"}
              context={context}
              onContext={openTimelineContext}
              onReply={posting ? undefined : replyTo}
              delivery={group.delivery}
              agentOf={agentOf}
              labelOf={labelOf}
              onOpenCommit={openCommit}
              onOpenTerminal={openTerminal}
              forwardTo={forwardTo}
              onForward={posting ? undefined : forward}
              empty={group.name ? t("noEvents") : t("noGroup")}
              liveSessionOf={liveSessionOf}
              liveLogOf={liveLogOf}
              processOf={processOf}
              onOpenFile={openFile}
            />
            <GroupLiveStatus rows={rows} onOpenTerminal={openMemberTerminal} />
            {name ? (
              <GroupPermissions
                folderId={folderId}
                group={name}
                events={group.events}
                members={group.members}
                onAnswered={group.refresh}
              />
            ) : null}
          </>
          {group.name ? (
            <GroupComposer
              rows={rows}
              reply={reply}
              onReplyChange={setReply}
              targets={targets}
              onSend={send}
              folderId={folderId}
              lead={targets.length ? undefined : group.lead}
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}
