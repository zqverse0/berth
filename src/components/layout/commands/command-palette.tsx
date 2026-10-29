"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  commandForKey,
  WORKSPACE_COMMANDS,
  type WorkspaceCommand,
  type WorkspaceCommandGroup,
  type WorkspaceCommandId,
} from "@/components/layout/commands/commands"

function matchesQuery(
  query: string,
  title: string,
  description: string,
  id: string
): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return `${id} ${title} ${description}`
    .toLocaleLowerCase()
    .includes(normalized)
}

export interface WorkspaceCommandAction {
  id: WorkspaceCommandId
  run: () => void
  disabled?: boolean
}

export function WorkspaceCommandPalette({
  open,
  onOpenChange,
  actions,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: WorkspaceCommandAction[]
}) {
  const t = useTranslations("CommandPalette")
  const commandsT = useTranslations("WorkspaceCommands")
  const [query, setQuery] = useState("")
  // `?` 前缀进入搜索，其余单键直接执行
  const search = query.replace(/^\?/, "")

  const actionById = useMemo(
    () => new Map(actions.map((action) => [action.id, action])),
    [actions]
  )

  const grouped = useMemo(() => {
    const result = new Map<WorkspaceCommandGroup, WorkspaceCommand[]>()
    for (const command of WORKSPACE_COMMANDS) {
      if (!actionById.has(command.id)) continue
      if (
        !matchesQuery(
          search,
          commandsT(`${command.id}.title`),
          commandsT(`${command.id}.description`),
          command.id
        )
      ) {
        continue
      }
      const list = result.get(command.group) ?? []
      list.push(command)
      result.set(command.group, list)
    }
    return result
  }, [actionById, commandsT, search])

  const runAction = (id: WorkspaceCommandId) => {
    const action = actionById.get(id)
    if (!action || action.disabled) return
    onOpenChange(false)
    setQuery("")
    action.run()
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.repeat || event.nativeEvent.isComposing) return
    if (query || event.ctrlKey || event.metaKey || event.altKey) return
    const id = commandForKey(event.key)
    if (!id) return
    event.preventDefault()
    event.stopPropagation()
    runAction(id)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("")
        onOpenChange(next)
      }}
      title={t("title")}
      shouldFilter={false}
      containerClassName="flex items-end justify-end p-3 pb-10"
      overlayClassName="bg-transparent"
      className="origin-bottom-right max-w-none w-[min(26rem,calc(100vw-1.5rem))] max-h-[min(32rem,calc(100dvh-3.5rem))] gap-0 border bg-popover text-popover-foreground shadow-2xl ring-1 ring-border"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("placeholder")}
        onKeyDown={handleInputKeyDown}
      />
      <CommandList className="max-h-[min(24rem,calc(100dvh-9rem))]">
        <CommandEmpty>{t("empty")}</CommandEmpty>
        {[...grouped.entries()].map(([group, commands]) => (
          <CommandGroup key={group} heading={t(`groups.${group}`)}>
            {commands.map((command) => (
              <CommandItem
                key={command.id}
                value={`${command.id} ${commandsT(`${command.id}.title`)}`}
                disabled={actionById.get(command.id)?.disabled}
                onSelect={() => runAction(command.id)}
                className="flex items-center justify-between gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {commandsT(`${command.id}.title`)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {commandsT(`${command.id}.description`)}
                  </span>
                </span>
                {"key" in command ? (
                  <kbd className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded border bg-muted px-1.5 font-mono text-[10px] font-semibold uppercase text-foreground/90">
                    {command.key}
                  </kbd>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
