"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Paperclip, SendHorizontal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { type GroupEvent, memberLabel } from "@/lib/agent/berth-group"
import { isLocalDesktop, openFileDialog } from "@/lib/platform"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { cn } from "@/lib/utils"
import { addressable, type MemberRow } from "./group-model"

/** 项目内的文件写相对路径（各成员在自己的工作目录里解析），项目外写绝对路径。 */
function displayPath(path: string, root: string | undefined): string {
  if (!root) return path
  const base = root.replace(/[\\/]+$/, "")
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
    ? path.slice(base.length + 1)
    : path
}

/**
 * 群输入框：收件人由群顶部的会话条决定（单聊是那位成员，群聊是全体在线成员；回复 / 转给时是对方）。
 * 正文就是正文：`@`、`/` 不当指令。左下角按钮插入文件路径。Enter 发送、Shift+Enter 换行。
 */
export function GroupComposer({
  rows,
  targets,
  onSend,
  folderId,
  disabled,
  reply,
  onReplyChange,
  onLaunch,
}: {
  rows: readonly MemberRow[]
  /** 给离线的专家开一个终端（发给它的消息先存进群，入群后投给它）。 */
  onLaunch?: (row: MemberRow) => void
  /** 收件人（成员名），由会话条与回复决定。 */
  targets: readonly string[]
  /** 每位收件人各发一条；返回没发出去的成员名（空为全部成功），全部失败时保留输入重发。 */
  onSend: (to: string[], text: string, replyTo?: number) => Promise<string[]>
  reply?: GroupEvent | null
  onReplyChange?: (event: GroupEvent | null) => void
  folderId: number
  disabled?: boolean
}) {
  const t = useTranslations("BerthTasks.group.composer")
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 离线的专家也能收消息（存进群，下次启动入群后投）。
  const { present, offline } = addressable(rows)
  const names = present.map((row) => row.member.name)
  const reachable = [...names, ...offline.map((row) => row.member.name)]
  // 刚发给离线专家的消息：问要不要启动它。
  const [queuedFor, setQueuedFor] = useState<string[]>([])
  useEffect(() => {
    if (reply) inputRef.current?.focus()
  }, [reply])
  // 不丢弃失效目标或自动改投；用户必须明确重选。
  const to = [...targets]
  const unavailable = to.filter((name) => !reachable.includes(name))
  const everyone = names.length > 1 && names.every((name) => to.includes(name))
  const body = text.trim()
  const canSend =
    to.length > 0 &&
    Boolean(body) &&
    !sending &&
    !disabled &&
    unavailable.length === 0
  const labelOf = (name: string) =>
    memberLabel(
      rows.find((row) => row.member.name === name)?.member ?? { name }
    )

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
    if (!canSend) return
    setSending(true)
    setError(null)
    try {
      const failed = await onSend(to, body, reply?.seq)
      setQueuedFor(
        to.filter(
          (name) =>
            !failed.includes(name) &&
            offline.some((row) => row.member.name === name)
        )
      )
      // 部分失败时不保留输入：重发会让已收到的成员再收一次（失败的成员已在提示里列出）。
      if (failed.length < to.length) {
        setText("")
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
      {error ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {queuedFor.length ? (
        <div
          role="status"
          data-composer-offline
          className="mb-2 flex flex-wrap items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-xs text-amber-700 dark:text-amber-400"
        >
          <span className="min-w-0 flex-1">
            {t("offlineQueued", { names: queuedFor.map(labelOf).join(", ") })}
          </span>
          {onLaunch
            ? queuedFor.map((name) => {
                const row = offline.find((row) => row.member.name === name)
                return row ? (
                  <Button
                    key={name}
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    data-composer-launch={name}
                    onClick={() => {
                      onLaunch(row)
                      setQueuedFor((names) => names.filter((n) => n !== name))
                    }}
                  >
                    {t("launchOffline", { name: labelOf(name) })}
                  </Button>
                ) : null
              })
            : null}
          <button
            type="button"
            aria-label={t("dismiss")}
            onClick={() => setQueuedFor([])}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}
      {reachable.length === 0 ? (
        <p className="mb-1.5 text-xs text-muted-foreground/80">
          {t("noMembers")}
        </p>
      ) : null}
      <div
        data-composer-box
        className={cn(
          "rounded-xl border bg-card shadow-sm transition-colors focus-within:border-primary/60",
          disabled && "opacity-60"
        )}
      >
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
        <Textarea
          ref={inputRef}
          value={text}
          rows={2}
          disabled={disabled || sending || reachable.length === 0}
          placeholder={
            everyone
              ? t("placeholderAll")
              : to.length
                ? t("placeholderTo", { name: to.map(labelOf).join(", ") })
                : t("placeholderPick")
          }
          className="max-h-48 min-h-14 w-full resize-none rounded-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-sm leading-relaxed shadow-none outline-none focus-visible:ring-0 placeholder:text-muted-foreground/70"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
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
