"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AgentLaunchShelfContent } from "@/components/layout/sidebar/agent-launch"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { type GroupEvent, setExpertConfig } from "@/lib/agent/berth-group"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useExpertConfigList, useExpertConfigs } from "./group-experts"
import type { MemberRow } from "./group-model"
import { MemberSessions } from "./member-sessions"

/**
 * 「Agent / 模型」（单聊顶栏「Agent 与会话」里）：选 Agent（声明 `agent.acp` 的插件，缺省现在用的），再在它的启动栏里选服务商、模型等
 * （专家已定、不显示），存进本空间的专家配置（所有群共用）。它在的群下一条消息生效：只换模型同一会话，换 Agent 开新会话。
 */
export function ExpertSettings({
  folderId,
  expert,
  agent,
  addable,
  workingDirectory,
  onSaved,
}: {
  folderId: number
  expert: string
  /** 专家现在用的 Agent；未配置为 null。 */
  agent: string | null
  addable: readonly { id: string; name: string }[]
  workingDirectory: string
  onSaved: () => void
}) {
  const t = useTranslations("BerthTasks.group.memberSettings")
  const [chosen, setChosen] = useState(agent ?? addable[0]?.id ?? "")
  return (
    <div data-expert-settings={expert} className="grid gap-1.5 py-1">
      <label className="grid gap-1 text-[11px] text-muted-foreground">
        {t("agent")}
        <select
          data-expert-settings-agent
          className="h-7 rounded-md border bg-background px-2 text-xs text-foreground"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          {addable.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {agent && chosen !== agent ? (
        <p className="text-[11px] text-muted-foreground">{t("newSession")}</p>
      ) : null}
      {chosen ? (
        <AgentLaunchShelfContent
          key={chosen}
          agentId={chosen}
          workingDirectory={workingDirectory}
          folderId={folderId}
          expert={expert}
          onClose={onSaved}
          launchLabel={t("apply")}
          launch={async (choice) => {
            const response = await setExpertConfig(folderId, expert, chosen, {
              inputs: choice.agentLaunchInputs,
              provider: choice.providerId,
              model: choice.modelId,
            })
            if (!response.ok) throw new Error(response.error.message)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * 单聊顶栏「Agent 与会话」：专家可在这里换 Agent / 模型（存进本空间的专家配置，见 {@link ExpertSettings}），
 * 在这份对话里待过的成员列出它的会话。专家的私聊在主项目目录运行。
 */
export function ChatSettings({
  folderId,
  expert,
  row,
  events,
  onSaved,
}: {
  folderId: number
  /** 是专家时为它的 id；spawn 的 worker、旧成员为 null（只看会话）。 */
  expert: string | null
  /** 它在这份对话里的成员行；还没进来为 null。 */
  row: MemberRow | null
  events: readonly GroupEvent[]
  onSaved: () => void
}) {
  const t = useTranslations("BerthTasks.group.members.sessions")
  const [open, setOpen] = useState(false)
  const { agents } = useAgentProfiles()
  const addable = useMemo(() => agents.filter((agent) => agent.acp), [agents])
  const configs = useExpertConfigList(folderId)
  const root = useAppWorkspaceStore(
    (state) => state.allFolders.find((folder) => folder.id === folderId)?.path
  )
  if (!(expert && root) && !row) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-chat-settings
          className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("toggle")}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[70vh] w-96 overflow-y-auto p-3"
      >
        {expert && root ? (
          <ExpertSettings
            folderId={folderId}
            expert={expert}
            agent={configs[expert]?.agent ?? null}
            addable={addable}
            workingDirectory={root}
            onSaved={() => {
              setOpen(false)
              void useExpertConfigs.getState().reload(folderId)
              onSaved()
            }}
          />
        ) : null}
        {row ? (
          <MemberSessions row={row} folderId={folderId} events={events} />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
