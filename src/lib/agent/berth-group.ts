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

/** 成员正在回答的提问与到目前的执行过程。 */
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
  /** system `permission`：ACP 成员的审批请求可选的应答；`permission_reply` 的 `option` 是选中的 id。 */
  options?: { id: string; name: string; kind: string }[]
  /** system `permission`：工具调用的原始参数（Agent 给什么显示什么）。 */
  input?: unknown
  option?: string | null
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
  /** 正在回答（带 `log`）。 */
  busy?: boolean
  log?: BerthLiveLog | null
  /** ACP 成员的会话交给了终端：那个终端的 id（交接了还没开好终端时为 ""）；在群里为 null。 */
  handedTo?: string | null
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
  /** 这页之前还有更早的事件（往上翻带 `before` = 这页第一条的 seq）。 */
  more?: boolean
  members: GroupMember[]
  /** seq → 送达状态。 */
  delivery: Record<string, DeliveryState>
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

/** 空间的群 `group`（缺省 `main`）：`after` 之后的事件（给 `before` 时是它之前的一页）+ 成员 + 送达状态。 */
export function readTaskGroup(
  folderId: number,
  after = 0,
  page?: { before: number; limit: number },
  group: string = PROJECT_GROUP
) {
  return call<GroupRead>(folderId, "group.read", {
    name: group,
    after,
    ...page,
  })
}

/** 空间的一个聊天群（群列表）。 */
export interface ChatGroup {
  /** 群键：账本、会话都按它存，改名不变。 */
  name: string
  title: string | null
  /** 群目录：成员的 Agent 在这里运行。 */
  cwd: string
  /** 在群成员。 */
  members: string[]
  /** 与这位专家私聊的账本（不在群列表里显示）；普通群为 null。 */
  dm?: string | null
}

/** 群列表：`main` 在前。 */
export function listChatGroups(folderId: number) {
  return call<{ groups: ChatGroup[] }>(folderId, "group.list", { chat: true })
}

/** 新建群；`cwd` 缺省主项目。 */
export function createChatGroup(
  folderId: number,
  name: string,
  title?: string,
  cwd?: string
) {
  return call<{ name: string }>(folderId, "group.create", { name, title, cwd })
}

/** 改显示名；空为改回群键。 */
export function renameChatGroup(folderId: number, name: string, title: string) {
  return call<{ name: string }>(folderId, "group.rename", { name, title })
}

/** 删除群（`main` 不能删）。 */
export function deleteChatGroup(folderId: number, name: string) {
  return call<{ name: string }>(folderId, "group.delete", { name })
}

/** 改群设置：`cwd` 为 null 改回主项目、不给不改；改目录后成员下一条消息在新目录开新会话。 */
export function configureChatGroup(
  folderId: number,
  name: string,
  settings: { cwd?: string | null }
) {
  return call<{ name: string }>(folderId, "group.settings", {
    name,
    ...settings,
  })
}

/** 启动记录：launch 时宿主与 launch.js 记下的 Agent、专家、服务商、Berth 说明长度与启动计划。 */
export interface LaunchRecord {
  agent: string
  startedAt: number
  cwd: string
  inputs: Record<string, unknown>
  expert: {
    id: string
    name: string
    promptFile: string | null
    skills: string[]
    mcp: string[]
  } | null
  provider: { name: string; model: string | null } | null
  /** 注入的 Berth 说明字数；0 为没注入。 */
  brief: number
  /** launch.js 声明的启动计划（skills / 扩展 / MCP 等，键由各 Agent 决定）；没声明为 null。 */
  plan: Record<string, unknown> | null
}

/** 启动清单（宿主写到 `$BERTH_HOME/run/launches`）：提供了什么资产、插件报告了什么、哪些没人报告。 */
export interface LaunchManifest {
  id: string
  agent: string
  target: string | null
  startedAt: number
  cwd: string
  inputs: Record<string, unknown>
  expert: { id: string; name: string } | null
  provider: { name: string; model: string | null } | null
  prompt: { file: string | null; hash: string | null; text: string } | null
  brief: number
  declared: { kind: string; id: string; path: string }[]
  report: {
    kind: string
    id: string
    status: string
    reason?: string
    source?: string
  }[]
  unhandled: { kind: string; id: string }[]
  plan: Record<string, unknown> | null
}

/** 这个终端最近一次启动的清单；不是 Berth 启动的 Agent 为 null。 */
export async function readLaunchManifest(target: string) {
  const response = await runtimeBridgeOperation<LaunchManifest | null>({
    method: "expert.launch",
    params: { target },
  })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

/** 插件 inspect 钩子的结果；`implemented` 为假是插件没实现，界面显示「未验证」。 */
export interface LaunchInspection {
  implemented: boolean
  items: LaunchManifest["report"]
}

/** 对这个终端最近一次启动运行 inspect 钩子，核对声明与实际。 */
export async function inspectLaunch(target: string) {
  const response = await runtimeBridgeOperation<LaunchInspection>({
    method: "expert.inspect",
    params: { target },
  })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
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
  /** 不给：发到群里，后端交给被回复者或负责人。 */
  to: string | undefined,
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
      idempotencyKey: `${batch}:${to ?? ""}`,
      ...(replyTo != null ? { replyTo } : {}),
    }
  )
}

/** 专家在本空间用的 Agent / 启动栏值 / 服务商与模型（所有群共用）。 */
export interface ExpertConfig {
  agent: string
  inputs: Record<string, string | boolean>
  provider: number | null
  model: string | null
}

/** 全部专家与它在本空间的配置（未配置为 null）、所在群数。 */
export function listExpertConfigs(folderId: number) {
  return call<{
    experts: { id: string; name: string; config: ExpertConfig | null }[]
  }>(folderId, "group.experts")
}

/** 与专家私聊的账本（没有就建），返回群键；消息只在这里，不进任何群。 */
export function openExpertDm(folderId: number, expert: string) {
  return call<{ name: string }>(folderId, "group.dm", { expert })
}

/** 存专家用的 Agent 与启动栏选择：它所在的群下一条消息生效，只换模型同一会话、换 Agent 开新会话。 */
export function setExpertConfig(
  folderId: number,
  expert: string,
  agent: string,
  choice: {
    inputs: Record<string, string | boolean>
    provider: number | null
    model: string | null
  }
) {
  return call<{ groups: string[] }>(folderId, "group.expert.set", {
    expert,
    agent,
    ...choice,
  })
}

/** `handoff` 的应答：在终端里打开同一会话要的启动参数。 */
export interface AcpHandoff extends GroupEvent {
  session: string
  agent: string
  cwd: string
  inputs: Record<string, string | boolean>
  provider: number | null
  model: string | null
}

/**
 * ACP 成员：`stop` 停下这一轮，`new` 下一条消息开新会话，`leave` 移出群（会话保留，同名再加回来接着用），
 * `handoff` 把会话交给终端（`terminal` 是开好的终端，可之后再带上），`return` 交回群里。
 */
export function controlAcpMember(
  folderId: number,
  group: string,
  member: string,
  action: "stop" | "new" | "leave" | "handoff" | "return",
  terminal?: string
) {
  return call<AcpHandoff>(folderId, "group.member.control", {
    name: group,
    member,
    action,
    ...(terminal ? { terminal } : {}),
  })
}

/** 应答 ACP 成员的审批请求；不给 `option` 即取消。 */
export function answerPermission(
  folderId: number,
  group: string,
  request: number,
  option?: string
) {
  return call<GroupEvent>(folderId, "group.approve", {
    name: group,
    request,
    ...(option ? { option } : {}),
  })
}

/** 还没应答、那一轮也还没结束的审批请求。 */
export function pendingPermissions(events: readonly GroupEvent[]) {
  const answered = new Set<number>()
  const ended = new Set<string>()
  for (const event of events) {
    if (event.event === "permission_reply" && event.reply_to != null)
      answered.add(event.reply_to)
    if (event.author && event.reply_to != null && event.event !== "permission")
      ended.add(`${event.author}:${event.reply_to}`)
  }
  return events.filter(
    (event) =>
      event.event === "permission" &&
      !answered.has(event.seq) &&
      !ended.has(`${event.author}:${event.reply_to}`)
  )
}

/** 当前 checkout 的唯一群组（`all` 时为项目全部群组），内部键与目录显示名分离。 */
export function listGroups(folderId: number, all = false) {
  return call<{
    groups: string[]
    worktrees: Record<string, string>
  }>(folderId, "group.list", all ? { all } : {})
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
