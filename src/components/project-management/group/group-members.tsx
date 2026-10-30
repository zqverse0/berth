"use client"

import { useState, type KeyboardEvent } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  AlertTriangle,
  AtSign,
  ChevronRight,
  MessagesSquare,
  OctagonX,
  Pencil,
  Plus,
  SquareTerminal,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { listExperts } from "@/knowledge/api/knowledge-client"
import { toErrorMessage } from "@/lib/app-error"
import {
  type GroupEvent,
  memberAgent,
  memberLabel,
} from "@/lib/agent/berth-group"
import { cn } from "@/lib/utils"
import type { AgentPaneRow } from "@/lib/terminal/agent-panes"
import {
  dirName,
  paneNumber,
  sharedDirs,
  type MemberRow,
  type MemberStatus,
} from "./group-model"
import { MemberAvatar } from "./group-timeline"

export const MEMBER_DOT: Record<MemberStatus, string> = {
  attention: "bg-amber-500",
  working: "bg-emerald-500 animate-pulse",
  idle: "bg-primary/70",
  offline: "bg-muted-foreground/30",
  left: "bg-muted-foreground/20",
}

const STATUS_TEXT: Record<MemberStatus, string> = {
  attention: "text-amber-600 dark:text-amber-400",
  working: "text-emerald-600 dark:text-emerald-400",
  idle: "text-muted-foreground",
  offline: "text-muted-foreground/70",
  left: "text-muted-foreground/70",
}

/** 改显示名：Enter 保存（空为改回成员名）、Esc 取消；失败时留在编辑状态。 */
function LabelEditor({
  initial,
  placeholder,
  onSave,
  onDone,
}: {
  initial: string
  placeholder: string
  onSave: (label: string) => Promise<boolean>
  onDone: () => void
}) {
  const t = useTranslations("BerthTasks.group.members")
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (saving) return
    if (value.trim() === initial) {
      onDone()
      return
    }
    setSaving(true)
    const ok = await onSave(value.trim())
    setSaving(false)
    if (ok) onDone()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      onDone()
    }
  }
  return (
    <Input
      autoFocus
      data-member-label-input
      value={value}
      maxLength={32}
      disabled={saving}
      placeholder={placeholder}
      aria-label={t("rename")}
      title={t("renameHint")}
      className="h-6 px-1.5 text-sm"
      onChange={(event) => setValue(event.target.value.replace(/[\s@]/g, ""))}
      onKeyDown={onKeyDown}
      onBlur={() => void save()}
    />
  )
}

/** 成员的各个终端：Agent、忙闲、目录、编号；点一下跳到那个终端。 */
function BodyChips({
  row,
  agentName,
  onJumpPane,
}: {
  row: MemberRow
  agentName: (agentId: string) => string
  onJumpPane?: (pane: AgentPaneRow) => void
}) {
  const t = useTranslations("BerthTasks.group.members")
  const shared = sharedDirs(row)
  const live = row.bodies.filter(({ pane }) => pane && pane.state !== "exited")
  if (live.length === 0) return null
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1">
      {live.map(({ body, pane }) => {
        const state = pane!.state as MemberStatus
        return (
          <button
            key={body.target_ref}
            type="button"
            data-member-body={paneNumber(body.target_ref) ?? undefined}
            disabled={!onJumpPane}
            title={`${t("jump")} · ${body.cwd ?? ""}`}
            className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 px-1 py-px text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none"
            onClick={(event) => {
              event.stopPropagation()
              onJumpPane?.(pane!)
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                MEMBER_DOT[state]
              )}
            />
            <span className="truncate">
              {body.agent ? agentName(body.agent) : "?"} · {dirName(body.cwd)}
            </span>
            <span className="shrink-0 font-mono">
              #{paneNumber(body.target_ref) ?? "?"}
            </span>
          </button>
        )
      })}
      {shared.length ? (
        <span
          role="img"
          data-member-shared-dir
          aria-label={t("sharedDir")}
          title={t("sharedDir")}
          className="text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle aria-hidden="true" className="size-3" />
        </span>
      ) : null}
    </span>
  )
}

function MemberCard({
  row,
  agentName,
  onJump,
  onJumpPane,
  onAddBody,
  onMention,
  onInterrupt,
  onRename,
  onSelect,
  selected,
  current,
  sessions,
}: {
  row: MemberRow
  /** 展开的会话列表；不给时没有「会话」按钮。 */
  sessions?: (row: MemberRow) => React.ReactNode
  /** 它正在做的委托（排队或处理中）；没有为 null。 */
  current?: GroupEvent | null
  agentName: (agentId: string) => string
  onJump: (row: MemberRow) => void
  /** 跳到它的某个终端（终端小标）；没有时不显示小标。 */
  onJumpPane?: (pane: AgentPaneRow) => void
  /** 给它再开一个终端。 */
  onAddBody?: (row: MemberRow) => void
  onMention?: (name: string) => void
  onInterrupt: (row: MemberRow) => void
  onRename?: (name: string, label: string) => Promise<boolean>
  onSelect?: (row: MemberRow) => void
  selected?: string | null
}) {
  const t = useTranslations("BerthTasks.group.members")
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { member, status, pane } = row
  const live = status !== "left" && status !== "offline"
  const iconButton = "size-6 text-muted-foreground hover:text-foreground"
  return (
    <div
      data-member={member.name}
      data-member-status={status}
      className={cn(
        "group relative rounded-md border-l-2 border-transparent px-2 py-1.5 transition-colors hover:bg-accent/40",
        row.unread && "border-amber-500 bg-amber-500/5",
        !live && "opacity-60",
        selected === member.name && "bg-primary/10"
      )}
    >
      {editing && onRename ? (
        <div className="flex items-center gap-2.5">
          <MemberAvatar agent={memberAgent(member)} name={member.name} />
          <LabelEditor
            initial={member.label ?? ""}
            placeholder={member.name}
            onSave={(label) => onRename(member.name, label)}
            onDone={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={!onSelect && !pane}
            aria-pressed={onSelect ? selected === member.name : undefined}
            title={onSelect ? t("showMessages") : pane ? t("jump") : undefined}
            className="flex w-full min-w-0 items-center gap-2.5 text-left disabled:cursor-default"
            onClick={() => (onSelect ?? onJump)(row)}
          >
            <span className="relative">
              <MemberAvatar agent={memberAgent(member)} name={member.name} />
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background",
                  MEMBER_DOT[status]
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-sm font-medium">
                  {memberLabel(member)}
                </span>
                {member.label ? (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
                    #{member.name}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "ml-auto shrink-0 text-[11px]",
                    STATUS_TEXT[status]
                  )}
                >
                  {row.unread ? t("needsYou") : t(`status.${status}`)}
                  {row.lastActivity ? (
                    <span className="text-muted-foreground/80">
                      {" · "}
                      {format.relativeTime(
                        // termd 的状态时间可能比本机时钟快几秒：不显示「几秒后」。
                        new Date(Math.min(row.lastActivity, now.getTime())),
                        now
                      )}
                    </span>
                  ) : null}
                </span>
              </span>
              {onJumpPane ? null : row.body?.agent ? (
                <span className="block truncate text-[11px] text-muted-foreground/80">
                  {agentName(row.body.agent)}
                  {row.bodies.length > 1 ? ` ×${row.bodies.length}` : ""}
                </span>
              ) : null}
              {current ? (
                <span className="block truncate text-[11px] text-muted-foreground">
                  ↳ {current.text}
                </span>
              ) : null}
            </span>
          </button>
          {onJumpPane ? (
            <div className="pl-[2.375rem]">
              <BodyChips
                row={row}
                agentName={agentName}
                onJumpPane={onJumpPane}
              />
            </div>
          ) : null}
        </>
      )}
      {live && !editing ? (
        <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 rounded-md bg-background/90 group-hover:flex group-focus-within:flex">
          {onMention ? (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              title={t("mention")}
              aria-label={t("mention")}
              onClick={() => onMention(member.name)}
            >
              <AtSign aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
          {onRename ? (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              title={t("rename")}
              aria-label={t("rename")}
              data-member-rename={member.name}
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
          {onAddBody && !member.builtin ? (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              title={t("addBody")}
              aria-label={t("addBody")}
              data-member-add-body={member.name}
              onClick={() => onAddBody(row)}
            >
              <Plus aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
          {sessions ? (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              title={t("sessions.toggle")}
              aria-label={t("sessions.toggle")}
              aria-expanded={expanded}
              data-member-sessions-toggle={member.name}
              onClick={() => setExpanded((value) => !value)}
            >
              <MessagesSquare aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
          {/* 内置成员 Berth 没有终端。 */}
          {member.builtin ? null : (
            <Button
              variant="ghost"
              size="icon"
              className={iconButton}
              title={t("jump")}
              aria-label={t("jump")}
              onClick={() => onJump(row)}
            >
              <SquareTerminal aria-hidden="true" className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={iconButton}
            title={t("interrupt")}
            aria-label={t("interrupt")}
            disabled={status !== "working"}
            onClick={() => onInterrupt(row)}
          >
            <OctagonX aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {expanded && sessions ? (
        <div className="mt-1 pl-[2.375rem]">{sessions(row)}</div>
      ) : null}
    </div>
  )
}

/**
 * 成员栏：在群成员卡片（头像 + 状态灯、显示名、状态与最后活动、悬停操作：改名、@、展开会话、跳到终端、打断），
 * 需要关注且未读的高亮；传入 onSelect 时点击成员查看相关消息，终端入口保留为独立按钮。
 * 只显示运行中的成员，历史仍留在时间线。没有成员时显示 `empty`。没有 `onRename` 时不能改名。
 */
export function GroupMembers({
  rows,
  agentName,
  onJump,
  onJumpPane,
  onAddBody,
  onMention,
  onInterrupt,
  onRename,
  onSelect,
  selected,
  empty,
  currentOf,
  sessions,
}: {
  rows: readonly MemberRow[]
  agentName: (agentId: string) => string
  onJump: (row: MemberRow) => void
  onJumpPane?: (pane: AgentPaneRow) => void
  onAddBody?: (row: MemberRow) => void
  onMention?: (name: string) => void
  onInterrupt: (row: MemberRow) => void
  /** 返回 false 表示失败，保持编辑。 */
  onRename?: (name: string, label: string) => Promise<boolean>
  onSelect?: (row: MemberRow) => void
  selected?: string | null
  empty?: React.ReactNode
  currentOf?: (name: string) => GroupEvent | null
  sessions?: (row: MemberRow) => React.ReactNode
}) {
  const present = rows.filter(
    (row) => row.status !== "left" && row.status !== "offline"
  )
  const card = (row: MemberRow) => (
    <MemberCard
      key={row.member.name}
      row={row}
      current={currentOf?.(row.member.name)}
      agentName={agentName}
      onJump={onJump}
      onJumpPane={onJumpPane}
      onAddBody={onAddBody}
      onMention={onMention}
      onInterrupt={onInterrupt}
      onRename={onRename}
      onSelect={onSelect}
      selected={selected}
      sessions={sessions}
    />
  )
  return (
    <div className="space-y-0.5">
      {present.length === 0 ? empty : present.map(card)}
    </div>
  )
}

/** 群组视图的一个分区：标题、数量、可折叠；`action` 放在标题右侧（如「新建终端」）。 */
export function GroupSection({
  title,
  count,
  tone,
  action,
  defaultOpen = true,
  children,
}: {
  title: string
  count?: number
  /** 「需要你」用琥珀色强调。 */
  tone?: "attention"
  action?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section data-group-section={title} className="space-y-1">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          aria-expanded={open}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 text-[11px] font-medium",
            tone === "attention"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 transition-transform",
              open && "rotate-90"
            )}
          />
          <span className="truncate">{title}</span>
          {count != null ? (
            <span className="tabular-nums opacity-70">{count}</span>
          ) : null}
        </button>
        {action}
      </div>
      {open ? children : null}
    </section>
  )
}

/** 「添加专家」：列出还不在群里的专家，选一个后由调用方打开启动栏。 */
export function AddExpertMenu({
  folderId,
  present,
  onPick,
}: {
  folderId: number
  /** 在群的成员名（专家 id），不再列出。 */
  present: readonly string[]
  onPick: (expert: string) => void
}) {
  const t = useTranslations("BerthTasks.group.members")
  const [experts, setExperts] = useState<
    { value: string; label: string }[] | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const load = (open: boolean) => {
    if (!open) return
    setError(null)
    void listExperts(folderId)
      .then(setExperts)
      .catch((cause: unknown) => setError(toErrorMessage(cause)))
  }
  const absent = (experts ?? []).filter(
    (expert) => !present.includes(expert.value)
  )
  return (
    <DropdownMenu onOpenChange={load}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-group-add-expert
          className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
        >
          <Plus aria-hidden="true" className="size-3" />
          {t("addExpert")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {error ? (
          <DropdownMenuItem disabled>{error}</DropdownMenuItem>
        ) : experts == null ? (
          <DropdownMenuItem disabled>{t("loadingExperts")}</DropdownMenuItem>
        ) : absent.length === 0 ? (
          <DropdownMenuItem disabled>{t("noMoreExperts")}</DropdownMenuItem>
        ) : (
          absent.map((expert) => (
            <DropdownMenuItem
              key={expert.value}
              data-group-expert-option={expert.value}
              onSelect={() => onPick(expert.value)}
            >
              <span className="truncate">{expert.label}</span>
              {expert.label !== expert.value ? (
                <span className="ml-auto pl-2 font-mono text-[10px] text-muted-foreground">
                  {expert.value}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
