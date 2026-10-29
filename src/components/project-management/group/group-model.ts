import {
  type GroupEvent,
  GROUP_USER,
  sendBatchOf,
  type DeliveryState,
  type GroupBody,
  type GroupMember,
} from "@/lib/agent/berth-group"
import type { AgentPaneRow, SeenAttention } from "@/lib/terminal/agent-panes"

/** 成员栏状态：pane 的 Agent 状态；pane 已不在为 `offline`（后台进程随后让它离群）；离群为 `left`。 */
export type MemberStatus = "attention" | "working" | "idle" | "offline" | "left"

export interface MemberRow {
  member: GroupMember
  /** 成员各终端及其 pane（pane 已不在为 null）。 */
  bodies: { body: GroupBody; pane: AgentPaneRow | null }[]
  /** 代表成员状态的终端：最需要你的那个（需要关注 > 工作中 > 空闲）。 */
  body: GroupBody | null
  pane: AgentPaneRow | null
  status: MemberStatus
  /** 需要关注且用户还没看过这一轮（与侧栏角标同一已读层）。 */
  unread: boolean
  /** 最后活动：它最近的发言、pane 状态变化、入群，取最晚的。 */
  lastActivity: number | null
}

const ORDER: Record<MemberStatus, number> = {
  attention: 0,
  working: 1,
  idle: 2,
  offline: 3,
  left: 4,
}

export function memberRows(
  members: readonly GroupMember[],
  events: readonly GroupEvent[],
  panes: readonly AgentPaneRow[],
  seen: SeenAttention
): MemberRow[] {
  const spoke = new Map<string, number>()
  for (const event of events) {
    if (event.kind === "message" && event.author) {
      spoke.set(event.author, event.timestamp_ms)
    }
  }
  const rows = members.map((member) => {
    const bodies = member.bodies.map((body) => ({
      body,
      pane:
        member.leftAt == null
          ? (panes.find(
              (row) => row.descriptor.targetRef === body.target_ref
            ) ?? null)
          : null,
    }))
    const live = bodies.filter(
      (entry) => entry.pane && entry.pane.state !== "exited"
    )
    const primary =
      [...live].sort(
        (a, b) =>
          ORDER[a.pane?.state as MemberStatus] -
          ORDER[b.pane?.state as MemberStatus]
      )[0] ??
      bodies[bodies.length - 1] ??
      null
    const pane = primary?.pane ?? null
    // 看过的这一轮「需要关注」按空闲显示；Agent 再提醒（`since` 变了）才重新需要你。
    const status: MemberStatus =
      member.leftAt != null
        ? "left"
        : !pane || pane.state === "exited"
          ? "offline"
          : pane.state === "attention" &&
              seen[pane.descriptor.terminalId] === pane.since
            ? "idle"
            : pane.state
    const unread = status === "attention"
    const lastActivity = Math.max(
      spoke.get(member.name) ?? 0,
      member.leftAt ?? 0,
      status === "left" || status === "offline" ? 0 : (pane?.since ?? 0),
      member.joined_at ?? 0
    )
    return {
      member,
      bodies,
      body: primary?.body ?? null,
      pane,
      status,
      unread,
      lastActivity: lastActivity || null,
    }
  })
  return rows.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      a.member.joined_seq - b.member.joined_seq
  )
}

/**
 * 能发消息的成员：在线的，加上不在线的专家（消息存进群，启动后送达）；旧账本里按终端编号命名的离线成员不列。
 */
export function addressable(rows: readonly MemberRow[]): {
  present: MemberRow[]
  offline: MemberRow[]
} {
  const away = (row: MemberRow) =>
    row.status === "left" || row.status === "offline"
  return {
    present: rows.filter((row) => !away(row)),
    offline: rows.filter((row) => away(row) && !/^\d+$/.test(row.member.name)),
  }
}

const GIT_EVENTS = ["commits", "head", "merged"]

/** 入群 / 离群 / git 动作：账本照记，GUI 不显示（成员卡片的终端小标与结果卡片的提交已覆盖）。 */
export function isActivity(event: GroupEvent): boolean {
  return (
    event.kind === "joined" ||
    event.kind === "left" ||
    (event.kind === "system" && GIT_EVENTS.includes(event.event ?? ""))
  )
}

/** 开工 / 收尾、改名、契约升版：默认不显示，打开「系统事件」才显示。 */
export function isSystemNotice(event: GroupEvent): boolean {
  return (
    event.kind === "renamed" ||
    event.kind === "spec" ||
    (event.kind === "system" &&
      (event.event === "started" || event.event === "finished"))
  )
}

/** Agent 之间的委托与结果（群主不在其中）：群聊里折成一行，单聊里不出现。 */
export function isRelay(event: GroupEvent): boolean {
  return (
    event.kind === "message" &&
    event.author !== GROUP_USER &&
    event.to != null &&
    event.to !== GROUP_USER
  )
}

/** 群时间线上显示的事件：消息，`showSystem` 时加上系统事件（频道创建、入群离群与 git 动作不显示）。 */
export function timelineEvents(
  events: readonly GroupEvent[],
  showSystem = false
): GroupEvent[] {
  return events.filter(
    (event) =>
      event.kind !== "created" &&
      !isActivity(event) &&
      (showSystem || !isSystemNotice(event))
  )
}

/**
 * 委托的状态：送达状态 + 有没有结果（结果的 `reply_to` 指向它）；不另存。
 * `superseded`：已投进去但没有单独的结果，它之后发给同一成员的消息已回复（一轮里一起处理了）。
 */
export type Progress =
  | DeliveryState
  | "working"
  | "done"
  | "interrupted"
  | "superseded"

/** 委托 seq → 状态与结果 seq（已完成时）。 */
export type ProgressOf = (
  seq: number
) => { state: Progress; result?: number } | null

export function delegationProgress(
  events: readonly GroupEvent[],
  delivery: Readonly<Record<string, DeliveryState>>
): ProgressOf {
  const eventBySeq = new Map(events.map((event) => [event.seq, event]))
  // 委托 seq → 回答它的结果 seq。
  const results = new Map(
    events
      .filter(
        (event) => event.source === "transcript" && event.reply_to != null
      )
      .map((event) => [event.reply_to!, event.seq])
  )
  return (seq) => {
    const result = results.get(seq)
    if (result != null) return { state: "done", result }
    const state = delivery[String(seq)]
    if (state !== "delivered") return state ? { state } : null
    const to = eventBySeq.get(seq)?.to
    // 已投进去、没出结果它就离群了（终端关闭 / Agent 退出）：这一轮不会再有结果。
    const left = events.some(
      (event) => event.seq > seq && event.kind === "left" && event.author === to
    )
    if (left) return { state: "interrupted" }
    const later = events.some(
      (event) =>
        event.source === "transcript" &&
        event.author === to &&
        event.reply_to != null &&
        event.reply_to > seq
    )
    if (later) return { state: "superseded" }
    // 旧账本的汇报没有 reply_to：收件人之后汇报过就只显示「已送达」。
    const legacy = events.some(
      (event) =>
        event.seq > seq &&
        event.source === "transcript" &&
        event.reply_to == null &&
        event.author === to
    )
    return { state: legacy ? "delivered" : "working" }
  }
}

/** 进行中的委托（排队 / 处理中）：谁发起、交给谁、多久了；最新在前。 */
export function activeDelegations(
  events: readonly GroupEvent[],
  progressOf: ProgressOf
): GroupEvent[] {
  return events
    .filter(
      (event) =>
        event.kind === "message" &&
        event.source !== "transcript" &&
        event.to != null &&
        event.to !== GROUP_USER &&
        ["queued", "working"].includes(progressOf(event.seq)?.state ?? "")
    )
    .reverse()
}

/**
 * 时间线的一项：单个事件，或群主的一句提问（一次发给多位成员的几条合成一句，各自带送达状态）。
 * 提问的回答（结果的 `reply_to` 指向其中一条）收进 `answers`，挂在提问下，不按到达时间散在时间线里。
 */
export type TimelineItem =
  | { kind: "event"; event: GroupEvent }
  | { kind: "ask"; events: GroupEvent[]; answers: GroupEvent[] }

export function timelineItems(
  events: readonly GroupEvent[],
  showSystem = false
): TimelineItem[] {
  const items: TimelineItem[] = []
  let batch: string | null = null
  for (const event of timelineEvents(events, showSystem)) {
    const ask = event.kind === "message" && event.author === GROUP_USER
    const key = ask ? sendBatchOf(event.idempotency_key) : null
    const last = items[items.length - 1]
    if (key && key === batch && last?.kind === "ask") {
      items[items.length - 1] = { ...last, events: [...last.events, event] }
    } else {
      items.push(
        ask
          ? { kind: "ask", events: [event], answers: [] }
          : { kind: "event", event }
      )
    }
    batch = key
  }
  const owner = new Map<number, GroupEvent[]>()
  for (const item of items) {
    if (item.kind !== "ask") continue
    for (const event of item.events) owner.set(event.seq, item.answers)
  }
  if (owner.size === 0) return items
  return items.filter((item) => {
    if (item.kind !== "event" || item.event.source !== "transcript") return true
    const answers =
      item.event.reply_to == null ? undefined : owner.get(item.event.reply_to)
    answers?.push(item.event)
    return !answers
  })
}

/** 汇报正文：digest 里附带的「新提交」段落由卡片结构化显示，正文里去掉。 */
export function reportBody(event: GroupEvent): string {
  const digest = event.digest ?? event.text ?? ""
  if (!event.commits?.length) return digest
  const cut = digest.lastIndexOf("\n\n新提交：")
  return cut >= 0 ? digest.slice(0, cut) : digest
}

/** `<hash> <subject>` → 两部分。 */
export function splitCommit(line: string): { hash: string; subject: string } {
  const space = line.indexOf(" ")
  return space < 0
    ? { hash: line, subject: "" }
    : { hash: line.slice(0, space), subject: line.slice(space + 1) }
}

/** 单聊：群主与这位成员之间的消息和直接关联的回复（Agent 之间的委托不算）；不把正文里的名字猜作收件人。 */
export function filterMemberEvents(
  events: readonly GroupEvent[],
  member: string | null
): readonly GroupEvent[] {
  if (!member) return events
  const related = new Set(
    events
      .filter(
        (event) =>
          event.kind === "message" &&
          ((event.author === GROUP_USER && event.to === member) ||
            (event.author === member && !isRelay(event)))
      )
      .map((event) => event.seq)
  )
  return events.filter(
    (event) =>
      related.has(event.seq) ||
      (event.reply_to != null && related.has(event.reply_to))
  )
}

/** target ref 是 `v1.` + base64url(JSON)，编号在 `pane_id`。 */
export function paneNumber(targetRef: string | undefined): number | null {
  if (!targetRef?.startsWith("v1.")) return null
  try {
    const json = atob(targetRef.slice(3).replace(/-/g, "+").replace(/_/g, "/"))
    const id = (JSON.parse(json) as { pane_id?: unknown }).pane_id
    return typeof id === "number" ? id : null
  } catch {
    return null
  }
}

/** 目录名（路径最后一段）。 */
export function dirName(path: string | null | undefined): string {
  return path?.split(/[\\/]/).filter(Boolean).pop() ?? ""
}

/** 成员在同一目录里有两个以上在跑的终端：这些目录（可能改到同一批文件）。 */
export function sharedDirs(row: MemberRow): string[] {
  const seen = new Map<string, number>()
  for (const { body, pane } of row.bodies) {
    const cwd = body.cwd
    if (!cwd || !pane || pane.state === "exited") continue
    seen.set(cwd, (seen.get(cwd) ?? 0) + 1)
  }
  return [...seen].filter(([, count]) => count > 1).map(([cwd]) => cwd)
}
