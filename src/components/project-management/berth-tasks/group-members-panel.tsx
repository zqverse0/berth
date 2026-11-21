"use client"

import { lazy, Suspense, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Users } from "lucide-react"
import {
  SidebarHeaderActions,
  SidebarHeaderTabs,
} from "@/components/layout/sidebar/sidebar-header"
import { AgentLaunchShelfContent } from "@/components/layout/sidebar/agent-launch"
import type { AgentLaunchChoice } from "@/components/launchbar/use-launchbar"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useAgentPaneStore, useAllAgentPanes } from "@/lib/terminal/agent-panes"
import {
  controlAcpMember,
  joinAcpMember,
  memberAgent,
  memberLabel,
  setGroupLead,
  stopBerth,
} from "@/lib/agent/berth-group"
import { toast } from "@/lib/notify"
import { cn } from "@/lib/utils"
import {
  mainFolderId,
  memberLabel as projectMemberLabel,
} from "@/lib/workspace/projects"
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
import { GroupAddMember } from "../group/group-add-member"
import { ActiveDelegations } from "../group/active-delegations"
import { usePaneActions } from "../group/pane-actions"
import { MemberSessions } from "../group/member-sessions"
import { handoffAcpMember } from "../group/acp-handoff"
import { MemberRoutineDialog } from "../group/member-routine"

type Filter = "all" | "attention" | "working"
type Page = Filter | "sessions"

const trimSlash = (path: string) => path.replace(/[\\/]+$/, "")

function Members({
  folderId,
  live,
  filter,
}: {
  folderId: number
  live: boolean
  filter: Filter
}) {
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
  const rows = useMemo(
    () => memberRows(group.members, group.events, panes, seen),
    [group.members, group.events, panes, seen]
  )
  const progressOf = useMemo(
    () => delegationProgress(group.events, group.delivery),
    [group.events, group.delivery]
  )
  const labelOf = (name: string) =>
    memberLabel(group.members.find((m) => m.name === name) ?? { name })
  // 点成员 / 「全部」：首页切到与它单聊 / 群聊。
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

  // 「＋」入群：声明了 `agent.acp` 的插件以 ACP 成员入群，先在启动栏选专家 / 服务商 / 模型；
  // 名字取插件 id（重名加序号），加完切到和它单聊。失败抛出，启动栏提示。
  const addable = useMemo(() => agents.filter((agent) => agent.acp), [agents])
  const root = folders.find((folder) => folder.id === folderId)
  const addMember = async (agent: string, choice: AgentLaunchChoice) => {
    if (!group.name) return
    const taken = new Set(group.members.map((m) => m.name))
    let as = agent
    for (let n = 2; taken.has(as); n += 1) as = `${agent}-${n}`
    const response = await joinAcpMember(folderId, group.name, agent, as, {
      inputs: choice.agentLaunchInputs,
      provider: choice.providerId,
      model: choice.modelId,
    })
    if (!response.ok) throw new Error(response.error.message)
    group.refresh()
    select(as)
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
    const handed = row.member.handedTo != null
    const isLead = group.lead === row.member.name
    return (
      <>
        <DropdownMenuItem
          data-member-action="lead"
          onSelect={() =>
            group.name &&
            void run(() =>
              setGroupLead(
                folderId,
                group.name!,
                isLead ? null : row.member.name
              )
            )
          }
        >
          {isLead ? t("unsetLead") : t("setLead")}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-member-action="routine"
          onSelect={() => setRoutineFor(row.member.name)}
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
          disabled={handed}
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
          className="text-destructive"
          title={tGroup("acp.leaveHint")}
          onSelect={() => void control(row, "leave")}
        >
          {tGroup("acp.leave")}
        </DropdownMenuItem>
      </>
    )
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
  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? id
  const interrupt = (row: MemberRow) => {
    if (row.member.builtin) void stopBerth(folderId)
    else if (row.pane) void actions.interrupt(row.pane)
    else if (group.name)
      void controlAcpMember(folderId, group.name, row.member.name, "stop")
  }
  // 按工作目录分组：主项目在前，其余按目录名；内置 Berth 没有目录，归主项目。
  const family = folders.filter(
    (folder) => folder.kind !== "chat" && mainFolderId(folder) === folderId
  )
  const dirOf = (row: MemberRow) => {
    const cwd = row.member.bodies[row.member.bodies.length - 1]?.cwd
    const folder = cwd
      ? family.find((f) => trimSlash(f.path) === trimSlash(cwd))
      : root
    return folder
      ? {
          key: String(folder.id),
          label: projectMemberLabel(folder),
          main: folder.id === folderId,
        }
      : {
          key: cwd!,
          label: cwd!.split(/[\\/]/).filter(Boolean).pop() ?? cwd!,
          main: false,
        }
  }
  const shown = rows
    .filter((row) => filter === "all" || row.status === filter)
    .filter(({ member }) =>
      `${memberLabel(member)} ${member.name} ${agentName(memberAgent(member) ?? "")}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
  const sections = new Map<
    string,
    { label: string; main: boolean; rows: MemberRow[] }
  >()
  for (const row of shown) {
    const dir = dirOf(row)
    const section = sections.get(dir.key) ?? {
      label: dir.label,
      main: dir.main,
      rows: [],
    }
    section.rows.push(row)
    sections.set(dir.key, section)
  }
  const ordered = [...sections.entries()].sort(
    ([, a], [, b]) =>
      Number(b.main) - Number(a.main) || a.label.localeCompare(b.label)
  )
  return (
    <section data-member-group={group.name} className="space-y-3 px-2 py-1">
      {root && group.name ? (
        <SidebarHeaderActions>
          <GroupAddMember
            addable={addable}
            addForm={(agent, close) => (
              <AgentLaunchShelfContent
                agentId={agent}
                workingDirectory={root.path}
                folderId={folderId}
                onClose={close}
                launch={(choice) => addMember(agent, choice)}
                launchLabel={tGroup("add.join")}
              />
            )}
          />
        </SidebarHeaderActions>
      ) : null}
      <button
        type="button"
        data-member-all
        disabled={!group.name}
        aria-pressed={selected == null}
        onClick={() => select(null)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/40",
          selected == null && "bg-primary/10"
        )}
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-muted">
          <Users aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {tGroup("chat.all")}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {group.lead
            ? t("leadIs", { name: labelOf(group.lead) })
            : t("noLead")}
        </span>
      </button>
      {rows.length > 3 || query ? (
        <Input
          aria-label={tGroup("focus.search")}
          placeholder={tGroup("focus.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 text-xs"
        />
      ) : null}
      {ordered.map(([key, section]) => (
        <GroupSection
          key={key}
          title={section.label}
          count={section.rows.length}
        >
          <GroupMembers
            rows={section.rows}
            selected={selected}
            currentOf={currentOf}
            queuedOf={queuedOf}
            lead={group.lead}
            menu={(row) => (row.member.builtin ? null : menu(row))}
            onSelect={(row) => select(row.member.name)}
            agentName={agentName}
            onJump={open}
            onInterrupt={interrupt}
            sessions={(row) => (
              <MemberSessions
                row={row}
                folderId={folderId}
                events={group.events}
              />
            )}
          />
        </GroupSection>
      ))}
      {ordered.length === 0 && group.loaded ? (
        <p className="px-2 text-xs text-muted-foreground">
          {query || filter !== "all"
            ? tGroup("focus.noMatch")
            : t("emptyStarted")}
        </p>
      ) : null}
      <GroupSection title={t("sectionDelegations")} count={active.length}>
        <ActiveDelegations
          events={active}
          progressOf={progressOf}
          labelOf={labelOf}
          onSelect={(event) => select(event.to ?? null)}
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
    </section>
  )
}

const LazySessionsView = lazy(() =>
  import("@/sessions/project/project-sessions-view").then((m) => ({
    default: m.ProjectSessionsView,
  }))
)

/**
 * 侧栏群组视图：顶栏筛选「全部 / 等你 / 干活中」与「会话」页、「＋」入群。成员按工作目录（主项目 / 各 worktree）分组，
 * 点成员 = 首页切到与它单聊，「全部」= 群聊；行菜单设负责人、停止、新会话、在终端打开、移出；底部是派发中的委托。
 * 直接读空间的群，不依赖首页的选中状态。
 */
export function GroupMembersPanel({
  folderId,
  active = true,
}: {
  folderId: number
  /** 侧栏打开且停在群组视图：会话页据此才去读。 */
  active?: boolean
}) {
  const t = useTranslations("BerthTasks.group.members")
  const [page, setPage] = useState<Page>("all")
  return (
    <>
      <SidebarHeaderTabs<Page>
        tabs={[
          { id: "all", label: t("filterAll") },
          { id: "attention", label: t("filterAttention") },
          { id: "working", label: t("filterWorking") },
          { id: "sessions", label: t("pageSessions") },
        ]}
        value={page}
        onChange={setPage}
      />
      {page !== "sessions" ? (
        <div className="h-full min-h-0 overflow-auto py-1">
          <Members
            key={folderId}
            folderId={folderId}
            live={active}
            filter={page}
          />
        </div>
      ) : (
        <Suspense fallback={null}>
          <LazySessionsView
            key={folderId}
            folderId={folderId}
            active={active}
            onShowMember={() => setPage("all")}
          />
        </Suspense>
      )}
    </>
  )
}
