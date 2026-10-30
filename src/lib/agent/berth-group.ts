/**
 * 项目群组：时间线、成员、收发消息（与 `berth group` 同一实现，进程内）。
 */
import {
  runtimeBridgeOperation,
  type RuntimeBridgeResponse,
} from "@/lib/runtime-bridge"

/** 执行过程的一行（会话日志与 Berth 的过程同形）：报错标红，思考弱化。 */
export interface GroupLogLine {
  text: string
  error?: boolean
  thinking?: boolean
}

/** 内置成员 Berth 正在回答的提问与到目前的执行过程。 */
export interface BerthLiveLog {
  ask: number
  lines: GroupLogLine[]
}

/** Berth 一轮的用量：调用次数、输入 / 输出 / 缓存命中 token 总数、最后一次调用的输入（上下文大小）。 */
export interface BerthUsage {
  calls: number
  input: number
  output: number
  cached: number
  context: number
}

/** 对话记录里的一条：模型的话，或一次工具调用（参数与完整输出；还没结果时 output 为 null）。 */
export type BerthRecordItem =
  | { kind: "text"; text: string }
  | {
      kind: "tool"
      id: string
      name: string
      args: unknown
      output: string | null
      failed: boolean
    }

/**
 * 对话记录的一轮（会话文件的一行）：提问、过程与回答（`items`）、用量。
 * `complete` 为假是被停下或出错的一轮：只存了提问和那句回答，过程看 `steps`。
 */
export interface BerthRecordTurn {
  ask: number
  at: number | null
  text: string | null
  model: string | null
  usage: BerthUsage | null
  steps: GroupLogLine[] | null
  complete: boolean
  items: BerthRecordItem[]
}

/** 一个会话的对话记录：会话名（没有会话为 null）与各轮。 */
export interface BerthRecord {
  session: string | null
  turns: BerthRecordTurn[]
}

/** Berth 在本项目的一个会话（列表新的在前，第一个是当前会话）。 */
export interface BerthSession {
  name: string
  /** 第一轮的提问；空会话为 null。 */
  title: string | null
  updatedAt: number | null
}

/** 群账本里的一条事件。 */
export interface GroupEvent {
  schema_version: number
  seq: number
  timestamp_ms: number
  kind:
    | "created"
    | "joined"
    | "left"
    | "message"
    | "spec"
    | "system"
    | "renamed"
  author?: string
  to?: string
  reply_to?: number
  text?: string
  /** 收集器从 worker 会话取回的回复为 `transcript`。 */
  source?: string
  /** 收集器报告的 Agent 原生会话标识，不是承载 pane 的 termd session。 */
  session_id?: string | null
  notification?: string | null
  /** joined / left：成员的哪个终端（TargetBindingRef 编码）；汇报：出自哪个终端；消息：指定由哪个终端接。 */
  target_ref?: string
  /** 汇报：出自的 Agent。 */
  agent?: string
  /** joined：终端所在目录。 */
  cwd?: string | null
  /** commits / head：哪个 checkout（群内部键）。 */
  checkout?: string
  description?: string
  task?: string
  idempotency_key?: string
  /** message：worker 的变更申请。 */
  intent?: string
  /** spec：契约版本。 */
  rev?: number
  /** 汇报：回复正文前 800 字（全文在 `text`）、新提交（`<hash> <subject>`）与 diffstat。 */
  digest?: string
  commits?: string[]
  diffstat?: string
  /** Berth 的回答：这一轮的执行过程（没有会话可读，过程随回答存下）。 */
  steps?: GroupLogLine[]
  /** Berth 的回答：这一轮的用量。 */
  usage?: BerthUsage
  /** 汇报：这一轮改了的文件（路径相对 `root`，根外的是绝对路径）。 */
  files?: {
    path: string
    status: "added" | "modified" | "deleted"
    /** 增删行数；算不出（二进制、不在 git 仓库里改的旧文件）时缺省。 */
    added?: number | null
    removed?: number | null
  }[]
  root?: string
  /** left：离群原因（`pane_closed` / `left_worktree` / `agent_exited`）。 */
  reason?: string
  /** system：`started` 等；开工事件带分支、base、worktree。 */
  event?: string
  branch?: string
  base?: string
  worktree?: string
  resumed?: boolean
  /** system `finished`：是否放弃收尾、分支是否删除、分支最后的提交（删除后据此找回）。 */
  abandoned?: boolean
  branchDeleted?: boolean
  commit?: string | null
  /** system `commits` / `head` / `merged`：群目录的 git 动作（后台进程记录）。 */
  head?: string
  /** commits：合并进来的分支（合并提交或快进到别的群分支）。 */
  merged?: string | null
  /** commits：旧 HEAD 不在新历史里（rebase / amend）。 */
  rewritten?: boolean
  /** head：切换分支前的分支；同一分支上回退为 null。 */
  from_branch?: string | null
  /** merged：来源分支已合并进的分支。 */
  into?: string
  /** renamed：被改名的成员与新显示名（null 为改回成员名）。 */
  member?: string
  label?: string | null
}

/** 群主（用户）的固定作者名，与 berth-project-core `group::USER` 一致。 */
export const GROUP_USER = "user"
/** 群的内置成员 Berth：没有终端，宿主进程用所选模型直接回答。 */
export const BERTH_MEMBER = "berth"

/** 项目群的内部键（一个项目一个群），与 berth-project-core `group::MAIN_GROUP` 一致。 */
export const PROJECT_GROUP = "main"

/** 成员（专家）的一个终端。 */
export interface GroupBody {
  target_ref: string
  agent: string | null
  cwd: string | null
  collect: boolean
  derived: boolean
  joined_seq: number
  joined_at: number | null
  /** 绑定的 Agent 会话（收集器确认的或最近汇报带的）；`group.read` 才有。 */
  sessionId?: string | null
}

/** 来过群的成员（`group::roster`）：一个专家，可同时有几个终端；`leftAt` 为离群时间，在群为 null。 */
export interface GroupMember {
  name: string
  /** 在群的终端；离群的成员保留离群前最后的终端。 */
  bodies: GroupBody[]
  joined_seq: number
  joined_at: number | null
  leftAt: number | null
  /** 群主起的显示名；没有为 null。 */
  label?: string | null
  /** 专家的显示名（`experts/<id>.json` 的 `name`）；`group.read` 才有，专家文件不在为 null。 */
  expertName?: string | null
  /** 内置成员 Berth（没有终端）；`busy` 为它正在回答。 */
  builtin?: boolean
  busy?: boolean
  log?: BerthLiveLog | null
}

/** 成员最近入群的终端跑的 Agent。 */
export function memberAgent(member: Pick<GroupMember, "bodies">) {
  return member.bodies[member.bodies.length - 1]?.agent ?? null
}

/** 成员在群里显示的名字：显示名优先，其次专家名；旧账本里名字是终端编号的显示为 `Agent#编号`，与 `@` 解析兼容。 */
export function memberLabel(
  member: Pick<GroupMember, "name" | "label"> & {
    agent?: string | null
    bodies?: GroupBody[]
    expertName?: string | null
  }
) {
  if (member.label) return member.label
  if (member.expertName) return member.expertName
  const agent =
    member.agent ??
    (member.bodies ? memberAgent(member as Pick<GroupMember, "bodies">) : null)
  return agent && /^\d+$/.test(member.name)
    ? `${agent}#${member.name}`
    : member.name
}

/** 发给成员的消息：已投进它的 pane / 它在群但还没投到 / 它已离群（不会再投）。 */
export type DeliveryState = "delivered" | "queued" | "undelivered"

export interface GroupRead {
  env?: { branch: string; baseBranch: string; worktree: string } | null
  /** 群的内部键；当前目录还没有群时为 null。 */
  name: string | null
  events: GroupEvent[]
  nextAfter: number
  members: GroupMember[]
  /** seq → 送达状态。 */
  delivery: Record<string, DeliveryState>
  /** 内置成员 Berth 的状态。 */
  builtin?: { name: string; busy: boolean; log?: BerthLiveLog | null }
}

/** 和 Berth 对话用的模型（模型服务商里的档案与模型 id）。 */
export interface BerthModel {
  providerId: number
  modelId: string
}

const BERTH_MODEL_KEY = "berth:group-berth-model"

export function loadBerthModel(): BerthModel | null {
  try {
    const raw = JSON.parse(localStorage.getItem(BERTH_MODEL_KEY) ?? "null")
    return typeof raw?.providerId === "number" &&
      typeof raw?.modelId === "string" &&
      raw.modelId
      ? { providerId: raw.providerId, modelId: raw.modelId }
      : null
  } catch {
    return null
  }
}

export function saveBerthModel(model: BerthModel) {
  try {
    localStorage.setItem(BERTH_MODEL_KEY, JSON.stringify(model))
  } catch {
    // 存储不可用时只在本次生效
  }
}

/** `group.read` 的内置成员 → 成员行用的成员（固定排在最前，显示名 Berth）。 */
export function builtinMember(
  builtin: NonNullable<GroupRead["builtin"]>
): GroupMember {
  return {
    name: builtin.name,
    bodies: [],
    joined_seq: 0,
    joined_at: null,
    leftAt: null,
    label: "Berth",
    builtin: true,
    busy: builtin.busy,
    log: builtin.log ?? null,
  }
}

function call<T>(
  folderId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<RuntimeBridgeResponse<T>> {
  return runtimeBridgeOperation<T>({ method, folderId, params })
}

export function mergeGroupEvents(
  current: GroupEvent[],
  incoming: GroupEvent[]
): GroupEvent[] {
  const bySeq = new Map<number, GroupEvent>()
  for (const event of current) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/** 当前 checkout 的群（后端只认 checkout，不接受群名）：`after` 之后的事件 + 成员 + 送达状态。 */
export function readTaskGroup(folderId: number, after = 0) {
  return call<GroupRead>(folderId, "group.read", { after })
}

/** 确保后台进程在跑（派生成员、排队送达、收集汇报）。 */
export function ensureGroupWatch(folderId: number) {
  return call<{ running: boolean; started: boolean }>(folderId, "group.watch")
}

/** 同一次发给多位成员的消息共用的幂等键前缀（时间线据此合成一条）。 */
export function newSendBatch(): string {
  return `gui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** `gui-<批次>:<成员>` 的批次部分；不是群发产生的为 null。 */
export function sendBatchOf(idempotencyKey: string | undefined): string | null {
  if (!idempotencyKey?.startsWith("gui-")) return null
  const colon = idempotencyKey.lastIndexOf(":")
  return colon > 0 ? idempotencyKey.slice(0, colon) : null
}

/**
 * 以群主身份发给一位成员：立即写入群账本，由后台进程在成员空闲时送达。发给多位成员时每人一条（各自送达），
 * 传同一个 `batch`（[`newSendBatch`]）。
 */
export function postToMember(
  folderId: number,
  group: string,
  to: string,
  text: string,
  batch: string = newSendBatch(),
  replyTo?: number
) {
  return call<GroupEvent & { doorbell?: { status?: string } }>(
    folderId,
    "group.post",
    {
      name: group,
      author: GROUP_USER,
      to,
      text,
      idempotencyKey: `${batch}:${to}`,
      ...(replyTo != null ? { replyTo } : {}),
      // 发给 Berth 带上所选模型：宿主据此回答。
      ...(to === BERTH_MEMBER ? { model: loadBerthModel() } : {}),
    }
  )
}

/** 停下 Berth 在这个项目里正在回答和排队的消息（各回一句「已停止」）。 */
export function stopBerth(folderId: number) {
  return call<{ stopped: boolean }>(folderId, "group.stopBerth")
}

/** Berth 在本项目的会话，新的在前。 */
export function listBerthSessions(folderId: number) {
  return call<BerthSession[]>(folderId, "group.berthSessions")
}

/** Berth 一个会话（不给为当前会话）的各轮。 */
export function readBerthRecord(folderId: number, session?: string) {
  return call<BerthRecord>(
    folderId,
    "group.berthRecord",
    session ? { session } : {}
  )
}

/** 开始和 Berth 的新会话（输入框里发 `/new`）：之后的提问从空上下文开始。 */
export function newBerthSession(folderId: number) {
  return call<{ session: string }>(folderId, "group.berthNew")
}

/** 当前 checkout 的唯一群组（`all` 时为项目全部群组），内部键与目录显示名分离。 */
export function listGroups(folderId: number, all = false) {
  return call<{
    groups: string[]
    worktrees: Record<string, string>
  }>(folderId, "group.list", all ? { all } : {})
}

/** 项目行未读数：本项目各 checkout 群的未读条数（键是 worktree 路径）；带 `seen` 先记该群已读到 `seq`。 */
export function readGroupUnread(
  folderId: number,
  seen?: { group: string; seq: number }
) {
  return call<{ worktrees: Record<string, number> }>(
    folderId,
    "group.unread",
    seen ? { seen } : {}
  )
}

/** 把任务分配给群组；群组 = worktree，一个群组可有多个任务。 */
export function assignTask(folderId: number, task: string, group: string) {
  return call<{ taskDirName: string; group: string }>(
    folderId,
    "group.assign",
    {
      task,
      group,
    }
  )
}
