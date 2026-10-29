"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useAgentPaneStore, useAllAgentPanes } from "@/lib/terminal/agent-panes"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { memberAgent, memberLabel } from "@/lib/agent/berth-group"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useTaskGroup } from "../group/use-task-group"
import {
  activeDelegations,
  delegationProgress,
  memberRows,
  type MemberRow,
} from "../group/group-model"
import {
  AddExpertMenu,
  GroupMembers,
  GroupSection,
} from "../group/group-members"
import { ActiveDelegations } from "../group/active-delegations"
import { launchExpert, usePaneActions } from "../group/pane-actions"
import type { AgentPaneRow } from "@/lib/terminal/agent-panes"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { EnableBerthNotice } from "../enable-berth-notice"

function Members({ folderId }: { folderId: number }) {
  const t = useTranslations("BerthTasks.group.members")
  const tGroup = useTranslations("BerthTasks.group")
  const [query, setQuery] = useState("")
  const group = useTaskGroup(folderId, true)
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
  const select = (name: string | null) => {
    if (!group.name) return
    const store = useGroupWorkspaceStore.getState()
    store.selectGroup(folderId, group.name)
    store.setFocusedMember(name)
    useAppUiStore.getState().showAuxView("group")
  }
  const open = (row: MemberRow) => {
    if (!row.pane || row.status === "offline" || row.status === "left") return
    const store = useGroupWorkspaceStore.getState()
    if (group.name) store.selectGroup(folderId, group.name)
    store.preview(actions.jump(row.pane, folderId))
  }
  const displayName =
    (
      group.env?.worktree ??
      folders.find((folder) => folder.id === folderId)?.path
    )
      ?.split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? ""
  if (group.uninitialized)
    return (
      <div className="px-2 py-1">
        <EnableBerthNotice folderId={folderId} onEnabled={group.refresh} />
      </div>
    )
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
  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? id
  const interrupt = (row: MemberRow) => {
    if (row.pane) void actions.interrupt(row.pane)
  }
  const present = rows.filter(
    (row) => row.status !== "left" && row.status !== "offline"
  )
  const needsYou = present.filter((row) => row.unread)
  const jumpPane = (pane: AgentPaneRow) => {
    const store = useGroupWorkspaceStore.getState()
    if (group.name) store.selectGroup(folderId, group.name)
    store.preview(actions.jump(pane, folderId))
  }
  // 新专家默认用群里最近启动的 Agent，没有就用项目默认的。
  const recentAgent =
    [...group.members]
      .flatMap((member) => member.bodies)
      .sort((a, b) => b.joined_seq - a.joined_seq)[0]?.agent ??
    folders.find((folder) => folder.id === folderId)?.default_agent_type ??
    null
  return (
    <section data-member-group={group.name} className="space-y-3 px-2 py-1">
      <div className="flex items-center gap-2 px-1">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">
          {displayName}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px]"
          disabled={!group.name}
          aria-pressed={selected == null}
          onClick={() => select(null)}
        >
          {tGroup("focus.all")}
        </Button>
      </div>
      {needsYou.length > 0 ? (
        <GroupSection
          title={t("needsYou")}
          count={needsYou.length}
          tone="attention"
        >
          {/* 需要你的成员点开直接到它的终端：通常是在等你回答。 */}
          <GroupMembers
            rows={needsYou}
            currentOf={currentOf}
            agentName={agentName}
            onJump={open}
            onInterrupt={interrupt}
          />
        </GroupSection>
      ) : null}
      <GroupSection
        title={t("sectionMembers")}
        count={present.length}
        action={
          group.name ? (
            <AddExpertMenu
              folderId={folderId}
              present={present.map((row) => row.member.name)}
              onPick={(expert) => launchExpert({ expert, agent: recentAgent })}
            />
          ) : null
        }
      >
        {present.length > 3 || query ? (
          <Input
            aria-label={tGroup("focus.search")}
            placeholder={tGroup("focus.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-1 h-7 text-xs"
          />
        ) : null}
        <GroupMembers
          rows={rows
            .filter(({ member }) =>
              `${memberLabel(member)} ${member.name} ${agentName(memberAgent(member) ?? "")}`
                .toLowerCase()
                .includes(query.toLowerCase())
            )
            .sort((a, b) => a.member.joined_seq - b.member.joined_seq)}
          selected={selected}
          currentOf={currentOf}
          onSelect={(row) => select(row.member.name)}
          agentName={agentName}
          onJump={open}
          onJumpPane={jumpPane}
          onAddBody={(row) =>
            launchExpert({
              expert: row.member.name,
              agent: row.body?.agent ?? memberAgent(row.member),
            })
          }
          onInterrupt={interrupt}
          empty={
            group.loaded ? (
              <p className="px-2 text-xs text-muted-foreground">
                {query ? tGroup("focus.noMatch") : t("emptyStarted")}
              </p>
            ) : null
          }
        />
      </GroupSection>
      <GroupSection title={t("sectionDelegations")} count={active.length}>
        <ActiveDelegations
          events={active}
          progressOf={progressOf}
          labelOf={labelOf}
          onSelect={(event) => select(event.to ?? null)}
        />
      </GroupSection>
    </section>
  )
}

/** 侧栏群组视图：成员与进行中的委托；直接读当前目录的群，不依赖群页的选中状态。 */
export function GroupMembersPanel({ folderId }: { folderId: number }) {
  return <Members key={folderId} folderId={folderId} />
}
