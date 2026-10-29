"use client"

import { useTranslations } from "next-intl"
import { getTerminalRuntimeActions } from "@/stores/terminal-runtime-store"
import { cn } from "@/lib/utils"

export type MobileTerminalKeysProps = {
  terminalId: string
  /** Ctrl 已按下：软键盘打的下一个字母按 Ctrl 组合键发送（由 terminal-view 的输入路径消费）。 */
  ctrlArmed: boolean
  onCtrlArmedChange: (armed: boolean) => void
  className?: string
}

/** 手机软键盘缺的键（同手机终端 App 的额外键行）；`label` 是键帽，`name` 是读屏名。 */
const KEYS = [
  { name: "escape", label: "Esc", data: "\u001b" },
  { name: "tab", label: "Tab", data: "\t" },
  { name: "shiftTab", label: "⇧Tab", data: "\u001b[Z" },
  { name: "ctrlC", label: "^C", data: "\u0003" },
  { name: "up", label: "↑", data: "\u001b[A" },
  { name: "down", label: "↓", data: "\u001b[B" },
  { name: "left", label: "←", data: "\u001b[D" },
  { name: "right", label: "→", data: "\u001b[C" },
] as const

/** 一行额外键，放在终端下方；与 xterm 走同一条有序输入路径。 */
export const MOBILE_TERMINAL_KEYS_HEIGHT = "2.75rem"

const keyClass =
  "h-8 min-w-10 shrink-0 rounded-md px-2.5 text-sm font-medium active:bg-accent"

export function MobileTerminalKeys({
  terminalId,
  ctrlArmed,
  onCtrlArmedChange,
  className,
}: MobileTerminalKeysProps) {
  const t = useTranslations("Folder.terminal.mobileKeys")
  const send = (data: string) => {
    getTerminalRuntimeActions().sendInput(terminalId, data)
    onCtrlArmedChange(false)
  }

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
      {KEYS.map((key) => (
        <button
          key={key.name}
          type="button"
          className={cn(keyClass, "bg-background text-foreground")}
          aria-label={t(key.name)}
          onClick={() => send(key.data)}
        >
          {key.label}
        </button>
      ))}
    </div>
  )
}
