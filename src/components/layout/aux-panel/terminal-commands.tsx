"use client"

import { useCallback, useEffect, useState } from "react"
import { Pencil, Play, Plus, SquareChevronRight, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  createFolderCommand,
  deleteFolderCommand,
  quickMessagesCreate,
  quickMessagesDelete,
  quickMessagesUpdate,
  updateFolderCommand,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import { createAndOpenPrimaryTerminalDetailed } from "@/lib/terminal/create-and-open-primary-terminal"
import { reportAgentLaunchAlert } from "@/lib/terminal/report-agent-launch-alert"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"
import { loadTerminalShortcuts, type Shortcut } from "@/lib/terminal/shortcuts"

type Scope = "project" | "global"

/** 行内编辑表单；id 为 null 表示新建。 */
interface Draft {
  scope: Scope
  id: number | null
  name: string
  content: string
}

const CONNECT_TIMEOUT_MS = 10_000

/** 新建终端连上后再发送输入；超时放弃，避免订阅常驻。 */
function sendWhenConnected(terminalId: string, text: string) {
  const trySend = () => {
    const runtime = useTerminalRuntimeStore.getState()
    if (runtime.sessions[terminalId]?.status !== "connected") return false
    runtime.sendInput(terminalId, text)
    return true
  }
  if (trySend()) return
  const unsubscribe = useTerminalRuntimeStore.subscribe(() => {
    if (trySend()) stop()
  })
  const timer = setTimeout(() => stop(), CONNECT_TIMEOUT_MS)
  function stop() {
    unsubscribe()
    clearTimeout(timer)
  }
}

function withNewline(content: string) {
  return /[\r\n]$/.test(content) ? content : `${content}\n`
}

/** 标题区「切换辅助面板」左侧的指令按钮：弹层里是项目指令与全局指令。 */
export function TerminalCommandsMenu({ className }: { className?: string }) {
  const t = useTranslations("Folder.auxPanel")
  const { activeFolder } = useActiveFolder()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-7 text-muted-foreground hover:text-foreground",
            className
          )}
          title={t("commands")}
          aria-label={t("commands")}
        >
          <SquareChevronRight className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-80 p-0">
        <TerminalCommands
          folderId={activeFolder?.id ?? null}
          folderPath={activeFolder?.path ?? ""}
          onRan={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/** 快捷指令：点击执行，并就地增删改。 */
export function TerminalCommands({
  folderId,
  folderPath,
  onRan,
}: {
  folderId: number | null
  folderPath: string
  /** 指令已发出（弹层借此关闭）。 */
  onRan?: () => void
}) {
  const t = useTranslations("Folder.projectSessions")
  const tTools = useTranslations("Folder.shortcutTools")
  const tCommon = useTranslations("Folder.common")
  const activeTerminal = useTabStore((s) => {
    const tab = s.tabs.find((candidate) => candidate.id === s.activeTabId)
    return tab && isTerminalTab(tab) ? tab : null
  })

  const [projectCommands, setProjectCommands] = useState<Shortcut[]>([])
  const [globalCommands, setGlobalCommands] = useState<Shortcut[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const shortcuts = await loadTerminalShortcuts(folderId)
      setGlobalCommands(
        shortcuts.filter((shortcut) => shortcut.scope === "global")
      )
      setProjectCommands(
        shortcuts.filter((shortcut) => shortcut.scope === "project")
      )
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }, [folderId])

  useEffect(() => {
    void load()
  }, [load])

  const newTerminal = useCallback(async () => {
    setError(null)
    try {
      const result = await createAndOpenPrimaryTerminalDetailed({
        cwd: folderPath,
        folderId,
        launchSource: { kind: "shell" },
      })
      if (!result.terminalId) throw new Error("Failed to create terminal")
      return result.terminalId
    } catch (err) {
      const message = toErrorMessage(err)
      setError(message)
      reportAgentLaunchAlert(t("terminal"), message)
      return null
    }
  }, [folderId, folderPath, t])

  // 有活动终端发给它；没有就新建一个，连上后再发。
  const run = async (shortcut: Shortcut) => {
    setError(null)
    const text = withNewline(shortcut.content)
    if (activeTerminal) {
      const runtime = useTerminalRuntimeStore.getState()
      const session = runtime.sessions[activeTerminal.terminalId]
      if (session && session.status !== "connected") {
        setError(t("terminalNotReady"))
        return
      }
      runtime.sendInput(activeTerminal.terminalId, text)
      onRan?.()
      return
    }
    const terminalId = await newTerminal()
    if (!terminalId) return
    sendWhenConnected(terminalId, text)
    onRan?.()
  }

  const save = async () => {
    if (!draft || saving) return
    const name = draft.name.trim()
    const content = draft.content.trim()
    if (!name || !content) return
    setSaving(true)
    setError(null)
    try {
      if (draft.scope === "project" && folderId != null) {
        await (draft.id == null
          ? createFolderCommand(folderId, name, content)
          : updateFolderCommand(draft.id, name, content))
      } else {
        await (draft.id == null
          ? quickMessagesCreate({ title: name, content })
          : quickMessagesUpdate({ id: draft.id, title: name, content }))
      }
      setDraft(null)
      await load()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (shortcut: Shortcut) => {
    setError(null)
    try {
      await (shortcut.scope === "project"
        ? deleteFolderCommand(shortcut.id)
        : quickMessagesDelete(shortcut.id))
      await load()
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  const editor = draft ? (
    <form
      className="flex flex-col gap-1.5 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setDraft(null)
      }}
    >
      <Input
        autoFocus
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        placeholder={tTools("namePlaceholder")}
        aria-label={tTools("nameLabel")}
        className="h-7 text-xs"
      />
      <Textarea
        value={draft.content}
        onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save()
        }}
        placeholder={tTools("contentPlaceholder")}
        aria-label={tTools("commandLabel")}
        rows={2}
        className="min-h-0 resize-none font-mono text-xs"
      />
      <div className="flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setDraft(null)}
        >
          {tCommon("cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={saving || !draft.name.trim() || !draft.content.trim()}
        >
          {tCommon("save")}
        </Button>
      </div>
    </form>
  ) : null

  const section = (scope: Scope, label: string, items: Shortcut[]) => (
    <section className="flex flex-col">
      <div className="group/section flex h-7 items-center gap-1 pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground"
          onClick={() => setDraft({ scope, id: null, name: "", content: "" })}
          title={
            scope === "project" ? tTools("newProject") : tTools("newGlobal")
          }
          aria-label={
            scope === "project" ? tTools("newProject") : tTools("newGlobal")
          }
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      {draft?.scope === scope && draft.id == null ? editor : null}
      {items.length === 0 && !(draft?.scope === scope && draft.id == null) ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          {scope === "project" ? tTools("projectEmpty") : tTools("globalEmpty")}
        </p>
      ) : null}
      <ul>
        {items.map((item) =>
          draft?.scope === scope && draft.id === item.id ? (
            <li key={item.id}>{editor}</li>
          ) : (
            <li key={item.id} className="group relative">
              <button
                type="button"
                onClick={() => void run(item)}
                title={tTools("runShortcutTitle", { name: item.name })}
                className="flex w-full min-w-0 items-center gap-2 py-1 pl-3 pr-14 text-left transition-colors hover:bg-accent"
              >
                <Play
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{item.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {item.content}
                  </span>
                </span>
              </button>
              <div className="absolute inset-y-0 right-2 hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground"
                  onClick={() => setDraft({ ...item })}
                  title={tTools("edit")}
                  aria-label={`${tTools("edit")} ${item.name}`}
                >
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(item)}
                  title={tCommon("delete")}
                  aria-label={`${tCommon("delete")} ${item.name}`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </Button>
              </div>
            </li>
          )
        )}
      </ul>
    </section>
  )

  return (
    <div className="flex max-h-[70vh] min-h-0 flex-col gap-1 overflow-y-auto py-1.5">
      {error ? (
        <p
          role="alert"
          className="mx-3 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      {folderId != null
        ? section("project", t("projectCommands"), projectCommands)
        : null}
      {section("global", t("globalCommands"), globalCommands)}
    </div>
  )
}
