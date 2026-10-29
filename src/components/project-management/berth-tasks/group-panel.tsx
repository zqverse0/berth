"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { GroupComposer } from "@/components/project-management/group/group-composer"
import {
  addressable,
  memberRows,
  filterMemberEvents,
  type MemberRow,
} from "@/components/project-management/group/group-model"
import { GroupChatStrip } from "@/components/project-management/group/group-chat-strip"
import { GroupLiveStatus } from "@/components/project-management/group/group-live-status"
import { EnableBerthNotice } from "@/components/project-management/enable-berth-notice"
import { GroupTimeline } from "@/components/project-management/group/group-timeline"
import {
  launchExpert,
  usePaneActions,
} from "@/components/project-management/group/pane-actions"
import { useTaskGroup } from "@/components/project-management/group/use-task-group"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import {
  type GroupEvent,
  memberAgent,
  memberLabel,
  newSendBatch,
  postToMember,
} from "@/lib/agent/berth-group"
import { useAgentPaneStore, useAllAgentPanes } from "@/lib/terminal/agent-panes"

/**
 * 群组面板固定在辅助面板里，跟随当前项目 / worktree（各自一个群）：成员聚焦、时间线与
 * 明确收件人的输入；任务和终端操作仍留在既有侧栏。调用方按 folderId 加 key 重建。
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
  const focus = useGroupWorkspaceStore((state) =>
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
  const [reply, setReply] = useState<GroupEvent | null>(null)
  // 回复 / 转给时收件人是这位成员（不一定是被引消息的作者）。
  const [replyMember, setReplyMember] = useState<string | null>(null)
  const [context, setContext] = useState<{ seq: number } | null>(null)
  const [showSystem, setShowSystem] = useState(false)
  const rows = useMemo(
    () => memberRows(group.members, group.events, panes, seen),
    [group.members, group.events, panes, seen]
  )
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
  // 汇报的过程日志：它出自的会话，从它回答的那条提问读起。
  const events = group.events
  const processOf = useCallback(
    (event: GroupEvent) => {
      const ask = events.find((other) => other.seq === event.reply_to)
      if (!ask || !event.session_id || !event.agent) return null
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
  const forwardTo = useMemo(
    () => addressable(rows).present.map((row) => row.member.name),
    [rows]
  )
  // 收件人：回复 / 转给的对象 > 单聊的成员 > 群聊时全体在线成员。
  const targets = useMemo(
    () => (reply && replyMember ? [replyMember] : focus ? [focus] : forwardTo),
    [reply, replyMember, focus, forwardTo]
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

  const send = async (to: string[], text: string, replyTo?: number) => {
    if (!name || posting) return to
    setPosting(true)
    const batch = newSendBatch()
    const failed: string[] = []
    let firstError: string | null = null
    for (const member of to) {
      const row = rows.find((row) => row.member.name === member)
      // 离线的专家照发：消息存进群，它下次启动入群后投给它。
      if (!row) {
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
        failed.push(member)
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
      {group.name && rows.length > 0 ? (
        <GroupChatStrip
          rows={rows}
          focus={focus}
          onFocus={(member) => {
            setFocus(member)
            setContext(null)
          }}
          showSystem={showSystem}
          onShowSystemChange={setShowSystem}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {group.uninitialized ? (
            <div className="p-5">
              <EnableBerthNotice
                folderId={folderId}
                onEnabled={group.refresh}
              />
            </div>
          ) : (
            <>
              {group.error ? (
                <p role="alert" className="px-5 py-2 text-destructive">
                  {group.error}
                </p>
              ) : null}
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
                showSystem={showSystem}
                liveSessionOf={liveSessionOf}
                processOf={processOf}
                onOpenFile={openFile}
              />
              <GroupLiveStatus
                rows={rows}
                onOpenTerminal={openMemberTerminal}
              />
              {group.name ? (
                <GroupComposer
                  rows={rows}
                  reply={reply}
                  onReplyChange={setReply}
                  targets={targets}
                  onSend={send}
                  onLaunch={(row) =>
                    launchExpert({
                      expert: row.member.name,
                      agent: row.body?.agent ?? memberAgent(row.member),
                      cwd: row.body?.cwd,
                    })
                  }
                  folderId={folderId}
                />
              ) : null}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
