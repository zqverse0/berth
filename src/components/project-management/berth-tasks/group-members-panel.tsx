"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useAgentPaneStore, useAllAgentPanes } from "@/lib/terminal/agent-panes"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import {
  controlAcpMember,
  memberAgent,
  memberLabel,
} from "@/lib/agent/berth-group"
import { toast } from "@/lib/notify"
import { showProjectHome } from "@/lib/workspace/project-home"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { useTaskGroup } from "../group/use-task-group"
import {
  activeDelegations,
  delegationProgress,
  memberRows,
  type MemberRow,
} from "../group/group-model"
import { GroupMembers, GroupSection } from "../group/group-members"
import {
  ExpertNewButton,
  openExpertEditor,
  useExpertConfigList,
} from "../group/group-experts"
import {
  GroupList,
  useChatGroupList,
  useChatGroups,
} from "../group/group-switcher"
import { useExperts } from "../group/expert-editor"
import { usePaneActions } from "../group/pane-actions"
import { handoffAcpMember } from "../group/acp-handoff"
import { MemberRoutineDialog } from "../group/member-routine"

/** 还没进这个群的专家：一行空闲、没有终端的成员行（给它发消息时后端按它的配置入群）。 */
const idleRow = (id: string, name: string): MemberRow => ({
  member: {
    name: id,
    bodies: [],
    joined_seq: 0,
    joined_at: null,
    leftAt: null,
    expertName: name,
  },
  pane: null,
  status: "idle",
  unread: false,
  lastActivity: null,
})

/**
 * 「专家」分组：本空间的全部专家（不分进没进群），每行是它用的 Agent · 模型（没配显示「未选 Agent」），在做事 / 等你时显示状态；
 * 点名字 = 首页与它私聊（私聊顶栏里选 Agent / 模型、看会话），行菜单在终端里聊、编辑专家、停止、新会话等。
 * 不是专家的成员（spawn 的 worker、旧成员）排在后面。
 */
function Experts({ folderId, live }: { folderId: number; live: boolean }) {
  const t = useTranslations("BerthTasks.group.members")
  const tGroup = useTranslations("BerthTasks.group")
  const [query, setQuery] = useState("")
  const [routineFor, setRoutineFor] = useState<string | null>(null)
  const group = useTaskGroup(folderId, live)
  const selected = useGroupWorkspaceStore((state) =>
    state.folderId === folderId && state.group === group.name
      ? state.focusedMember
      : null
  )
  const panes = useAllAgentPanes()
  const seen = useAgentPaneStore((state) => state.seen)
  const folders = useAppWorkspaceStore((state) => state.allFolders)
  const actions = usePaneActions()
  const { agents } = useAgentProfiles()
  const { catalog } = useExperts()
  const configs = useExpertConfigList(folderId)
  const groups = useChatGroupList(folderId)
  const memberList = useMemo(
    () => memberRows(group.members, group.events, panes, seen),
    [group.members, group.events, panes, seen]
  )
  const progressOf = useMemo(
    () => delegationProgress(group.events, group.delivery),
    [group.events, group.delivery]
  )
  const root = folders.find((folder) => folder.id === folderId)
  const current = groups.find((item) => item.name === group.name)
  // 群目录（群列表里取；还没读到时用主项目）。
  const groupCwd = current?.cwd ?? root?.path
  const experts = catalog?.experts ?? []
  const isExpert = (name: string) => experts.some((entry) => entry.id === name)
  const present = new Set(memberList.map((row) => row.member.name))
  const rows = [
    ...experts.map(
      (entry) =>
        memberList.find((row) => row.member.name === entry.id) ??
        idleRow(entry.id, entry.expert.name || entry.id)
    ),
    ...memberList.filter((row) => !isExpert(row.member.name)),
  ]
  const labelOf = (name: string) =>
    memberLabel(
      rows.find((row) => row.member.name === name)?.member ?? { name }
    )
  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? id
  // 点专家 / 群聊行：首页切到与它单聊 / 群聊。
  const select = (name: string | null) => {
    if (!group.name) return
    const store = useGroupWorkspaceStore.getState()
    store.selectGroup(folderId, group.name)
    store.setFocusedMember(name)
    showProjectHome()
  }
  const open = (row: MemberRow) => {
    if (!row.pane) return
    const store = useGroupWorkspaceStore.getState()
    if (group.name) store.selectGroup(folderId, group.name)
    store.preview(actions.jump(row.pane, folderId))
  }

  const run = async (
    work: () => Promise<
      { ok: true } | { ok: false; error: { message: string } }
    >
  ) => {
    const response = await work().catch((cause: unknown) => ({
      ok: false as const,
      error: { message: String(cause) },
    }))
    if (!response.ok) toast.error(response.error.message)
    group.refresh()
    void useChatGroups.getState().reload(folderId)
  }
  const control = (row: MemberRow, action: "stop" | "new" | "leave") =>
    group.name &&
    run(() => controlAcpMember(folderId, group.name!, row.member.name, action))
  const handoff = async (row: MemberRow) => {
    if (!group.name) return
    const failure = await handoffAcpMember(
      folderId,
      group.name,
      row.member.name,
      labelOf(row.member.name)
    )
    group.refresh()
    if (failure === "failed") toast.error(tGroup("acp.handoffFailed"))
    else if (failure === "unsupported")
      toast.error(tGroup("acp.handoffUnsupported"))
    else if (failure) toast.error(failure.message)
  }
  const menu = (row: MemberRow) => {
    const name = row.member.name
    const handed = row.member.handedTo != null
    const member = present.has(name)
    const agent = memberAgent(row.member) ?? configs[name]?.agent ?? null
    return (
      <>
        <DropdownMenuItem
          data-member-action="private"
          disabled={!agent}
          title={tGroup("acp.privateHint")}
          onSelect={() =>
            // 私聊 = 带这个专家的普通终端（在群目录），不进群记录。
            useStatusBarLaunchStore.getState().openLaunchShelf(agent, {
              expert: isExpert(name) ? name : null,
              folderId,
              workingDirectory: groupCwd,
            })
          }
        >
          {tGroup("acp.private")}
        </DropdownMenuItem>
        {isExpert(name) ? (
          <DropdownMenuItem
            data-member-action="edit"
            onSelect={() => openExpertEditor(name)}
          >
            {t("editExpert")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          data-member-action="routine"
          disabled={!member}
          onSelect={() => setRoutineFor(name)}
        >
          {tGroup("routine.menu")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!row.member.busy || handed}
          onSelect={() => void control(row, "stop")}
        >
          {tGroup("acp.stop")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!member || handed}
          title={tGroup("acp.newHint")}
          onSelect={() => void control(row, "new")}
        >
          {tGroup("acp.new")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={
            handed ||
            !!row.member.busy ||
            !row.member.bodies.some((body) => body.sessionId)
          }
          title={tGroup("acp.handoffHint")}
          onSelect={() => void handoff(row)}
        >
          {tGroup("acp.handoff")}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-member-action="leave"
          disabled={!member}
          className="text-destructive"
          title={tGroup("acp.leaveHint")}
          onSelect={() => void control(row, "leave")}
        >
          {tGroup("acp.leave")}
        </DropdownMenuItem>
      </>
    )
  }
  // 名字下面一行：专家是它配的 Agent · 模型；不是专家的成员是它在用的 Agent。
  const subtitle = (row: MemberRow) => {
    const name = row.member.name
    if (!isExpert(name)) return agentName(memberAgent(row.member) ?? "")
    const config = configs[name]
    return config
      ? [agentName(config.agent), config.model].filter(Boolean).join(" · ")
      : t("noAgent")
  }

  if (group.error)
    return (
      <p role="alert" className="px-2 py-1 text-xs text-destructive">
        {group.error}
      </p>
    )
  const active = activeDelegations(group.events, progressOf)
  // 成员正在做的委托：处理中的优先，其次排队的（都取最新）。
  const currentOf = (name: string) =>
    active.find(
      (event) => event.to === name && progressOf(event.seq)?.state === "working"
    ) ??
    active.find((event) => event.to === name) ??
    null
  const queuedOf = (seq: number) => progressOf(seq)?.state === "queued"
  const interrupt = (row: MemberRow) => {
    if (row.pane) void actions.interrupt(row.pane)
    else if (group.name)
      void controlAcpMember(folderId, group.name, row.member.name, "stop")
  }
  const shown = rows.filter((row) =>
    `${memberLabel(row.member)} ${row.member.name} ${subtitle(row)}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )
  return (
    <>
      <GroupSection title={t("sectionExperts")} action={<ExpertNewButton />}>
        {rows.length > 3 || query ? (
          <Input
            aria-label={tGroup("focus.search")}
            placeholder={tGroup("focus.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 text-xs"
          />
        ) : null}
        <GroupMembers
          rows={shown}
          selected={selected}
          currentOf={currentOf}
          queuedOf={queuedOf}
          menu={menu}
          subtitle={subtitle}
          onSelect={(row) => select(row.member.name)}
          agentName={agentName}
          onJump={open}
          onInterrupt={interrupt}
          empty={
            catalog ? (
              <p className="px-2 text-xs text-muted-foreground">
                {query ? tGroup("focus.noMatch") : t("emptyExperts")}
              </p>
            ) : null
          }
        />
      </GroupSection>
      {routineFor ? (
        <MemberRoutineDialog
          folderId={folderId}
          member={routineFor}
          label={labelOf(routineFor)}
          onClose={() => setRoutineFor(null)}
        />
      ) : null}
    </>
  )
}

/**
 * 侧栏群组视图：一列里上面是「群」（建群、切群、群设置），下面是「专家」（全部专家，点专家 = 与它私聊）。
 * 会话列表在「会话分析」插件里。
 */
export function GroupMembersPanel({
  folderId,
  active = true,
}: {
  folderId: number
  /** 侧栏打开且停在群组视图：专家页据此才轮询群状态。 */
  active?: boolean
}) {
  return (
    <div className="h-full min-h-0 space-y-3 overflow-auto px-2 py-2">
      <GroupList key={`groups-${folderId}`} folderId={folderId} />
      <Experts key={folderId} folderId={folderId} live={active} />
    </div>
  )
}
