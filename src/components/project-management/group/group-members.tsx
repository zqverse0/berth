"use client"

import { useState, type KeyboardEvent } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  AtSign,
  ChevronRight,
  Crown,
  Ellipsis,
  MessagesSquare,
  OctagonX,
  Pencil,
  SquareTerminal,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useSlowBlink } from "@/components/ui/status-dot"
import {
  type GroupEvent,
  memberAgent,
  memberLabel,
} from "@/lib/agent/berth-group"
import { cn } from "@/lib/utils"
import type { MemberRow, MemberStatus } from "./group-model"
import { MemberAvatar } from "./group-timeline"

const MEMBER_DOT: Record<MemberStatus, string> = {
  attention: "bg-amber-500",
  working: "bg-emerald-500 berth-slow-blink",
  idle: "bg-primary/70",
}

/** 成员状态点；「工作中」用全局慢闪，不用 CSS 无限动画（见 status-dot.tsx）。 */
export function MemberDot({
  status,
  className,
}: {
  status: MemberStatus
  className?: string
}) {
  useSlowBlink(status === "working")
  return (
    <span
      aria-hidden="true"
      className={cn("rounded-full", MEMBER_DOT[status], className)}
    />
  )
}

const STATUS_TEXT: Record<MemberStatus, string> = {
  attention: "text-amber-600 dark:text-amber-400",
  working: "text-emerald-600 dark:text-emerald-400",
  idle: "text-muted-foreground",
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

function MemberCard({
  row,
  agentName,
  onJump,
  onMention,
  onInterrupt,
  onRename,
  onSelect,
  selected,
  current,
  queued,
  lead,
  menu,
  sessions,
}: {
  row: MemberRow
  /** 它正在做的委托还在排队（没投进去）。 */
  queued?: boolean
  /** 它是负责人。 */
  lead?: boolean
  /** 行菜单的菜单项；不给时没有「⋯」。 */
  menu?: (row: MemberRow) => React.ReactNode
  /** 展开的会话列表；不给时没有「会话」按钮。 */
  sessions?: (row: MemberRow) => React.ReactNode
  /** 它正在做的委托（排队或处理中）；没有为 null。 */
  current?: GroupEvent | null
  agentName: (agentId: string) => string
  /** 跳到它的会话所在的终端（交给了终端时）。 */
  onJump: (row: MemberRow) => void
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
  const iconButton = "size-6 text-muted-foreground hover:text-foreground"
  return (
    <div
      data-member={member.name}
      data-member-status={status}
      className={cn(
        "group relative rounded-md border-l-2 border-transparent px-2 py-1.5 transition-colors hover:bg-accent/40",
        row.unread && "border-amber-500 bg-amber-500/5",
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
            <MemberDot
              status={status}
              className="absolute -bottom-0.5 -right-0.5 size-2.5 ring-2 ring-background"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="truncate text-sm font-medium">
                {memberLabel(member)}
              </span>
              {lead ? (
                <Crown
                  data-member-lead
                  aria-label={t("lead")}
                  className="size-3 shrink-0 self-center text-amber-500"
                >
                  <title>{t("lead")}</title>
                </Crown>
              ) : null}
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
            {memberAgent(member) ? (
              <span className="block truncate text-[11px] text-muted-foreground/80">
                {[agentName(memberAgent(member)!), member.expertName]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
            {current ? (
              <span className="block truncate text-[11px] text-muted-foreground">
                ↳ {queued ? `${t("queued")} · ` : ""}
                {current.text}
              </span>
            ) : status === "attention" &&
              pane?.descriptor.agentSignal?.notification ? (
              <span className="block truncate text-[11px] text-amber-600 dark:text-amber-400">
                ⏸ {pane.descriptor.agentSignal.notification}
              </span>
            ) : null}
          </span>
        </button>
      )}
      {!editing ? (
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
          {/* 只有交给了终端的会话有终端可跳。 */}
          {!pane ? null : (
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
          {menu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={iconButton}
                  title={t("menu")}
                  aria-label={t("menu")}
                  data-member-menu={member.name}
                >
                  <Ellipsis aria-hidden="true" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{menu(row)}</DropdownMenuContent>
            </DropdownMenu>
          ) : null}
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
 * 离群的成员不在 `rows` 里，历史仍留在时间线。没有成员时显示 `empty`。没有 `onRename` 时不能改名。
 */
export function GroupMembers({
  rows,
  agentName,
  onJump,
  onMention,
  onInterrupt,
  onRename,
  onSelect,
  selected,
  empty,
  currentOf,
  queuedOf,
  lead,
  menu,
  sessions,
}: {
  rows: readonly MemberRow[]
  /** 委托还在排队（没投进去）。 */
  queuedOf?: (seq: number) => boolean
  /** 负责人成员名。 */
  lead?: string | null
  menu?: (row: MemberRow) => React.ReactNode
  agentName: (agentId: string) => string
  onJump: (row: MemberRow) => void
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
  const card = (row: MemberRow) => {
    const current = currentOf?.(row.member.name)
    return (
      <MemberCard
        key={row.member.name}
        row={row}
        current={current}
        queued={current ? queuedOf?.(current.seq) : false}
        lead={lead != null && lead === row.member.name}
        menu={menu}
        agentName={agentName}
        onJump={onJump}
        onMention={onMention}
        onInterrupt={onInterrupt}
        onRename={onRename}
        onSelect={onSelect}
        selected={selected}
        sessions={sessions}
      />
    )
  }
  return (
    <div className="space-y-0.5">
      {rows.length === 0 ? empty : rows.map(card)}
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
