"use client"

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { useTranslations } from "next-intl"
import { Loader2, Paperclip, SendHorizontal, Users, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  type GroupEvent,
  memberAgent,
  memberLabel,
} from "@/lib/agent/berth-group"
import { isLocalDesktop, openFileDialog } from "@/lib/platform"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { cn } from "@/lib/utils"
import type { MemberRow } from "./group-model"
import { MemberAvatar } from "./group-timeline"
import {
  EVERYONE,
  mentionChoices,
  mentionQueryAt,
  mentionRanges,
  resolveMentions,
} from "./mentions"

/** @ 列表的一行：一位在群成员、还没进群的专家（`expert`），或 `@everyone`。 */
type MentionChoice = {
  id: string
  name: string
  row?: MemberRow
  expert?: { agent: string | null }
}

/** 项目内的文件写相对路径（各成员在自己的工作目录里解析），项目外写绝对路径。 */
function displayPath(path: string, root: string | undefined): string {
  if (!root) return path
  const base = root.replace(/[\\/]+$/, "")
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
    ? path.slice(base.length + 1)
    : path
}

/**
 * 群输入框：收件人由侧栏选中的成员决定（单聊是那位成员；回复 / 转给时是对方）；群聊不指定收件人，只记进群。
 * @ 照 OpenMausBot：打 `@` 弹出在群成员与 `@everyone`（↑↓ 选、Enter / Tab 插入、Esc 收起），正文里认得的 @ 高亮；
 * 正文 @ 了成员就只发给被 @ 的（盖过侧栏选中与回复），`@everyone` 发给全体；同名又没从列表选的拒发；
 * 还没进群的专家也在列表里，发给它时后端按它的配置入群；没选 Agent 的拒发。`/` 不当指令。
 * 左下角按钮插入文件路径。Enter 发送、Shift+Enter 换行。
 */
export function GroupComposer({
  rows,
  targets,
  onSend,
  folderId,
  disabled,
  reply,
  onReplyChange,
  inGroup,
  experts = [],
}: {
  rows: readonly MemberRow[]
  /** 专家：不在群里也能 @ / 发（后端按配置让它入群）；`agent` 为它在本空间配的 Agent，没配为 null。 */
  experts?: readonly { id: string; name: string; agent: string | null }[]
  /** 收件人（成员名），由会话条与回复决定。 */
  targets: readonly string[]
  /** 每位收件人各发一条；返回没发出去的成员名（空为全部成功），全部失败时保留输入重发。 */
  onSend: (to: string[], text: string, replyTo?: number) => Promise<string[]>
  reply?: GroupEvent | null
  onReplyChange?: (event: GroupEvent | null) => void
  folderId: number
  disabled?: boolean
  /** 群聊（不指定收件人也能发）。 */
  inGroup?: boolean
}) {
  const t = useTranslations("BerthTasks.group.composer")
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  // @ 列表：光标位置、高亮行、按 Esc / 选中后不再弹出的那个 @ 的位置、从列表选中过的成员。
  const [mention, setMention] = useState({
    caret: 0,
    highlight: 0,
    dismissedAt: null as number | null,
    picked: [] as string[],
  })
  const [composing, setComposing] = useState(false)
  const names = rows.map((row) => row.member.name)
  const outsiders = experts.filter((expert) => !names.includes(expert.id))
  const reachable = [...names, ...outsiders.map((expert) => expert.id)]
  useEffect(() => {
    if (reply) inputRef.current?.focus()
  }, [reply])
  const labelOf = (name: string) =>
    memberLabel(
      rows.find((row) => row.member.name === name)?.member ?? {
        name,
        expertName: experts.find((expert) => expert.id === name)?.name,
      }
    )
  const peers = [
    ...rows.map((row) => ({
      id: row.member.name,
      name: memberLabel(row.member),
    })),
    ...outsiders,
  ]
  const mentioned = resolveMentions(text, peers, mention.picked)
  // 不丢弃失效目标或自动改投；用户必须明确重选。正文 @ 了成员时只发给被 @ 的。
  const to = mentioned.everyone
    ? names
    : mentioned.ids.length
      ? mentioned.ids
      : [...targets]
  const unavailable = to.filter((name) => !reachable.includes(name))
  // 还没进群、也没选 Agent 的专家：后端没法让它入群。
  const noAgent = to.filter((name) =>
    outsiders.some((expert) => expert.id === name && !expert.agent)
  )
  const everyone = names.length > 1 && names.every((name) => to.includes(name))
  const body = text.trim()
  // 群聊：不指定收件人也能发（只记录，或 `@everyone`）。
  const toGroup = to.length === 0 && Boolean(inGroup)
  const canSend =
    (to.length > 0 || toGroup) &&
    Boolean(body) &&
    !sending &&
    !disabled &&
    unavailable.length === 0 &&
    noAgent.length === 0

  const query = mentionQueryAt(text, mention.caret)
  const choices: MentionChoice[] =
    query && query.start !== mention.dismissedAt
      ? mentionChoices(
          [
            ...(names.length ? [{ id: EVERYONE, name: EVERYONE }] : []),
            ...rows.map((row) => ({
              id: row.member.name,
              name: memberLabel(row.member),
              row,
            })),
            // 配了 Agent 的排前面（能直接入群）。
            ...[...outsiders]
              .sort((x, y) => Number(!x.agent) - Number(!y.agent))
              .map((expert) => ({ ...expert, expert })),
          ],
          query.query
        )
      : []
  const highlight = Math.min(mention.highlight, Math.max(choices.length - 1, 0))
  const pick = (choice: MentionChoice) => {
    if (!query) return
    const next = `${text.slice(0, query.start)}@${choice.name} ${text.slice(mention.caret)}`
    const caret = query.start + choice.name.length + 2
    setText(next)
    setMention((current) => ({
      caret,
      highlight: 0,
      dismissedAt: query.start,
      picked:
        choice.id === EVERYONE
          ? current.picked
          : [...current.picked.filter((id) => id !== choice.id), choice.id],
    }))
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(caret, caret)
    })
  }
  const syncCaret = () =>
    setMention((current) => ({
      ...current,
      caret: inputRef.current?.selectionStart ?? current.caret,
    }))

  const root = useAppWorkspaceStore(
    (state) => state.allFolders.find((folder) => folder.id === folderId)?.path
  )
  /** 在光标处插入一段文本（前后补空格），插完光标停在它后面。 */
  const insert = (fragment: string) => {
    const node = inputRef.current
    const at = node?.selectionStart ?? text.length
    const before = text.slice(0, at)
    const after = text.slice(node?.selectionEnd ?? at)
    const lead = before && !/\s$/.test(before) ? " " : ""
    const next = `${before}${lead}${fragment} ${after.replace(/^ /, "")}`
    setText(next)
    const caret = before.length + lead.length + fragment.length + 1
    requestAnimationFrame(() => {
      node?.focus()
      node?.setSelectionRange(caret, caret)
    })
  }
  const attach = async () => {
    const picked = await openFileDialog({
      multiple: true,
      title: t("attachTitle"),
      defaultPath: root,
    }).catch(() => null)
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    if (paths.length === 0) return
    insert(paths.map((path) => `\`${displayPath(path, root)}\``).join(" "))
  }

  const send = async () => {
    if (body && mentioned.ambiguous.length) {
      setError(t("mentionAmbiguous", { names: mentioned.ambiguous.join(", ") }))
      return
    }
    if (!canSend) return
    setSending(true)
    setError(null)
    try {
      const failed = await onSend(to, body, reply?.seq)
      // 部分失败时不保留输入：重发会让已收到的成员再收一次（失败的成员已在提示里列出）。
      if (to.length === 0 || failed.length < to.length) {
        setText("")
        setMention({ caret: 0, highlight: 0, dismissedAt: null, picked: [] })
        onReplyChange?.(null)
      }
    } catch {
      setError(t("sendFailed"))
    } finally {
      setSending(false)
    }
    inputRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法确认用的回车与方向键归输入法。
    if (choices.length && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        setMention((current) => ({
          ...current,
          highlight: (highlight + delta + choices.length) % choices.length,
        }))
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        pick(choices[highlight])
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setMention((current) => ({
          ...current,
          dismissedAt: query?.start ?? null,
        }))
        return
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="@container shrink-0 bg-background px-3 pb-3 pt-1">
      {unavailable.length ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {t("unavailable", { names: unavailable.map(labelOf).join(", ") })}
        </p>
      ) : null}
      {noAgent.length ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {t("noAgent", { names: noAgent.map(labelOf).join(", ") })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {reachable.length === 0 ? (
        <p className="mb-1.5 text-xs text-muted-foreground/80">
          {t("noMembers")}
        </p>
      ) : null}
      <div
        data-composer-box
        className={cn(
          "relative rounded-xl border bg-card shadow-sm transition-colors focus-within:border-primary/60",
          disabled && "opacity-60"
        )}
      >
        {choices.length ? (
          <div
            role="listbox"
            aria-label={t("mention.aria")}
            data-mention-list
            className="absolute bottom-full left-2 z-20 mb-2 max-h-72 w-72 overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {choices.map((choice, index) => {
              const agent = choice.row
                ? memberAgent(choice.row.member)
                : (choice.expert?.agent ?? null)
              const person = choice.row ?? choice.expert
              return (
                <button
                  key={choice.id}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  data-mention-choice={choice.id}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                    index === highlight && "bg-accent"
                  )}
                  // 不抢输入框焦点。
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() =>
                    setMention((current) => ({ ...current, highlight: index }))
                  }
                  onClick={() => pick(choice)}
                >
                  {person ? (
                    <MemberAvatar
                      agent={agent}
                      name={choice.id}
                      className="size-6"
                    />
                  ) : (
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Users aria-hidden="true" className="size-3.5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{choice.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {person
                        ? (agent ?? t("mention.noAgent"))
                        : t("mention.everyone", { count: names.length })}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {choice.row
                      ? t("mention.agent")
                      : choice.expert
                        ? t("mention.outside")
                        : t("mention.group")}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
        {reply ? (
          <div className="mx-2 mt-2 flex items-center gap-2 rounded-md border-l-2 border-primary bg-muted/50 px-2 py-1 text-xs">
            <div className="min-w-0 flex-1">
              <span className="font-medium">
                {t("replying", { name: labelOf(reply.author ?? "?") })}
              </span>
              <p className="truncate text-muted-foreground">
                {reply.text ?? reply.digest}
              </p>
            </div>
            <button
              type="button"
              disabled={sending}
              aria-label={t("cancelReply")}
              className="rounded p-0.5 hover:bg-accent"
              onClick={() => onReplyChange?.(null)}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        ) : null}
        {/* 认得的 @ 高亮：文字画在镜像层上，输入框文字透明只留光标；输入法组字时直接显示输入框文字。 */}
        <div className="relative">
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 pb-1 pt-2.5 text-sm leading-relaxed",
              composing && "invisible"
            )}
          >
            {highlighted(text, peers)}
            {"\n"}
          </div>
          <Textarea
            ref={inputRef}
            value={text}
            rows={2}
            disabled={disabled || sending || reachable.length === 0}
            placeholder={
              toGroup
                ? t("placeholderGroup")
                : everyone
                  ? t("placeholderAll")
                  : to.length
                    ? t("placeholderTo", { name: to.map(labelOf).join(", ") })
                    : t("placeholderPick")
            }
            className={cn(
              "relative max-h-48 min-h-14 w-full resize-none rounded-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-sm leading-relaxed shadow-none outline-none focus-visible:ring-0 placeholder:text-muted-foreground/70 selection:bg-primary/20 selection:text-foreground",
              !composing && "text-transparent caret-foreground"
            )}
            onChange={(event) => {
              const { value, selectionStart: caret } = event.target
              setText(value)
              // 收起的那个 @ 删掉或改了，再打 @ 要重新弹出。
              setMention((current) => ({
                ...current,
                caret,
                dismissedAt:
                  mentionQueryAt(value, caret)?.start === current.dismissedAt
                    ? current.dismissedAt
                    : null,
              }))
            }}
            onSelect={syncCaret}
            onScroll={(event) => {
              if (mirrorRef.current)
                mirrorRef.current.scrollTop = event.currentTarget.scrollTop
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onBlur={() => setComposing(false)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="flex items-center gap-1 px-2 pb-2">
          {isLocalDesktop() ? (
            <button
              type="button"
              data-composer-attach
              disabled={sending || disabled || reachable.length === 0}
              title={t("attach")}
              aria-label={t("attach")}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => void attach()}
            >
              <Paperclip aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
          <span className="ml-auto hidden select-none truncate text-[11px] text-muted-foreground/70 @sm:inline">
            {t("keysHint")}
          </span>
          <Button
            size="sm"
            className="ml-auto size-7 shrink-0 rounded-lg p-0 @sm:ml-1"
            disabled={!canSend}
            title={
              to.length
                ? t("sendTo", { names: to.map(labelOf).join(", ") })
                : t("send")
            }
            aria-label={
              to.length
                ? t("sendTo", { names: to.map(labelOf).join(", ") })
                : t("send")
            }
            onClick={() => void send()}
          >
            {sending ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <SendHorizontal aria-hidden="true" className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 镜像层的文字：认得的 @ 包一层高亮。 */
function highlighted(
  text: string,
  peers: readonly { id: string; name: string }[]
) {
  let end = 0
  const parts = mentionRanges(text, peers).map((range) => {
    const before = text.slice(end, range.start)
    end = range.end
    return (
      <Fragment key={range.start}>
        {before}
        <span className="rounded-sm bg-primary/15 text-primary">
          {text.slice(range.start, range.end)}
        </span>
      </Fragment>
    )
  })
  return (
    <>
      {parts}
      {text.slice(end)}
    </>
  )
}
