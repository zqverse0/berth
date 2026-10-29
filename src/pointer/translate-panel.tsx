"use client"

import { Copy, Loader2, Settings2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

export type TranslatePanelState =
  | { status: "loading" }
  | { status: "done"; result: string; provider?: string }
  | { status: "error"; message: string }

export function TranslatePanel({
  state,
  providerLabel,
  onCopy,
  onOpenSettings,
}: {
  state: TranslatePanelState
  providerLabel?: string | null
  onCopy: () => void
  onOpenSettings: () => void
}) {
  const t = useTranslations("Pointer")
  const showResult = state.status === "done" && state.result.trim().length > 0

  return (
    <div className="flex w-80 max-w-full flex-col px-3 pt-2.5 pb-2">
      <div
        className="max-h-52 overflow-y-auto py-0.5 text-[13px] leading-relaxed select-text"
        aria-live="polite"
      >
        {state.status === "loading" ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            <span>{t("translating")}</span>
          </div>
        ) : null}
        {showResult && state.status === "done" ? (
          <p className="whitespace-pre-wrap break-words text-popover-foreground">
            {state.result}
          </p>
        ) : null}
        {state.status === "error" ? (
          <p className="py-1 text-xs text-destructive" role="alert">
            {state.message}
          </p>
        ) : null}
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2 text-xs">
        <div className="flex items-center gap-1.5">
          {state.status === "done" ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 cursor-pointer gap-1 px-2 text-xs font-medium"
              onClick={onCopy}
            >
              <Copy className="size-3" />
              {t("copyTranslation")}
            </Button>
          ) : null}
          {providerLabel ? (
            <span className="text-muted-foreground/80 truncate text-[11px]">
              {providerLabel}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 cursor-pointer gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onOpenSettings}
          title={t("translateOpenSettings")}
        >
          <Settings2 className="size-3" />
          <span>{t("translateOpenSettings")}</span>
        </Button>
      </div>
    </div>
  )
}
