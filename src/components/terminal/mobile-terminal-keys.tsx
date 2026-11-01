"use client"

import { useLayoutEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { getTerminalRuntimeActions } from "@/stores/terminal-runtime-store"
import { cn } from "@/lib/utils"

export type MobileTerminalKeysProps = {
  terminalId: string
  /** Ctrl 已按下：软键盘打的下一个字母按 Ctrl 组合键发送（由 terminal-view 的输入路径消费）。 */
  ctrlArmed: boolean
  onCtrlArmedChange: (armed: boolean) => void
  /** 把文本粘进终端；返回 false 表示终端不接受（多行但没开 bracketed paste）。 */
  onPaste: (text: string) => boolean
  /** 打开选择面板（原生选字、系统拷贝菜单）。 */
  onSelect: () => void
  className?: string
}

/**
 * 手机软键盘缺的键（同手机终端 App 的额外键行）；`label` 是键帽，`name` 是读屏名。
 * 键行比手机屏宽，粘贴 / 选择排在常用键后、方向键前，不用横划就能点到。
 */
const LEAD_KEYS = [
  { name: "escape", label: "Esc", data: "\u001b" },
  { name: "tab", label: "Tab", data: "\t" },
  { name: "ctrlC", label: "^C", data: "\u0003" },
] as const
const TAIL_KEYS = [
  { name: "up", label: "↑", data: "\u001b[A" },
  { name: "down", label: "↓", data: "\u001b[B" },
  { name: "left", label: "←", data: "\u001b[D" },
  { name: "right", label: "→", data: "\u001b[C" },
  { name: "shiftTab", label: "⇧Tab", data: "\u001b[Z" },
] as const

/** 一行额外键，放在终端下方；与 xterm 走同一条有序输入路径。 */
export const MOBILE_TERMINAL_KEYS_HEIGHT = "2.75rem"

/**
 * 读剪贴板。远程页走 HTTP 时没有 `clipboard.readText`（非安全上下文），退回系统输入框，
 * 用户在里面长按粘贴；该输入框是单行的，多行内容会被合并。
 */
async function readClipboard(promptLabel: string): Promise<string | null> {
  if (typeof navigator.clipboard?.readText === "function") {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return null
    }
  }
  return window.prompt(promptLabel)
}

const keyClass =
  "h-8 min-w-10 shrink-0 rounded-md px-2.5 text-sm font-medium active:bg-accent"

export function MobileTerminalKeys({
  terminalId,
  ctrlArmed,
  onCtrlArmedChange,
  onPaste,
  onSelect,
  className,
}: MobileTerminalKeysProps) {
  const t = useTranslations("Folder.terminal.mobileKeys")
  const send = (data: string) => {
    getTerminalRuntimeActions().sendInput(terminalId, data)
    onCtrlArmedChange(false)
  }
  const paste = async () => {
    const text = await readClipboard(t("pastePrompt"))
    if (!text) return
    if (!onPaste(text)) toast.error(t("pasteMultiline"))
  }
  const keyButton = (key: (typeof LEAD_KEYS | typeof TAIL_KEYS)[number]) => (
    <button
      key={key.name}
      type="button"
      className={cn(keyClass, "bg-background text-foreground")}
      aria-label={t(key.name)}
      onClick={() => send(key.data)}
    >
      {key.label}
    </button>
  )

  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto border-t bg-muted/60 px-1.5",
        className
      )}
      style={{ height: MOBILE_TERMINAL_KEYS_HEIGHT }}
      data-terminal-mobile-keys="true"
      data-terminal-surface="true"
      // 点键不抢 xterm 的焦点：软键盘保持弹出。
      onPointerDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className={cn(
          keyClass,
          ctrlArmed
            ? "bg-primary text-primary-foreground"
            : "bg-background text-foreground"
        )}
        aria-pressed={ctrlArmed}
        aria-label={t("ctrl")}
        onClick={() => onCtrlArmedChange(!ctrlArmed)}
      >
        Ctrl
      </button>
      {LEAD_KEYS.map(keyButton)}
      <button
        type="button"
        className={cn(keyClass, "bg-background text-foreground")}
        onClick={() => void paste()}
      >
        {t("paste")}
      </button>
      <button
        type="button"
        className={cn(keyClass, "bg-background text-foreground")}
        onClick={onSelect}
      >
        {t("select")}
      </button>
      {TAIL_KEYS.map(keyButton)}
    </div>
  )
}

export type MobileTerminalSelectSheetProps = {
  /** 视口顶行之前的文本（含结尾换行）；面板打开时滚到两段交界，即终端当前位置。 */
  before: string
  after: string
  fontFamily: string
  fontSize?: number
  onClose: () => void
}

/**
 * 盖在终端上的原生文本层：xterm 在触屏上选不了字，这里用 iOS / Android 自带的
 * 长按选字与拷贝菜单。只读快照，打开后的新输出不进来。
 */
export function MobileTerminalSelectSheet({
  before,
  after,
  fontFamily,
  fontSize,
  onClose,
}: MobileTerminalSelectSheetProps) {
  const t = useTranslations("Folder.terminal.mobileKeys")
  const textRef = useRef<HTMLPreElement>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  // 只滚面板自己：scrollIntoView 会连带滚动外层 overflow-hidden 容器。
  useLayoutEffect(() => {
    const text = textRef.current
    const anchor = anchorRef.current
    if (text && anchor) text.scrollTop = anchor.offsetTop
  }, [])

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-card"
      data-terminal-select-sheet="true"
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-2 text-xs text-muted-foreground">
        <span>{t("selectHint")}</span>
        <button
          type="button"
          className={cn(keyClass, "bg-primary text-primary-foreground")}
          onClick={onClose}
        >
          {t("done")}
        </button>
      </div>
      <pre
        ref={textRef}
        className="relative min-h-0 flex-1 overflow-auto p-2 break-all whitespace-pre-wrap select-text"
        style={{ fontFamily, fontSize, WebkitUserSelect: "text" }}
      >
        {before}
        <span ref={anchorRef} />
        {after}
      </pre>
    </div>
  )
}
