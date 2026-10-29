"use client"

import { useMemo, useState } from "react"
import { ChevronRight, ExternalLink } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { formatTokenCount } from "@/lib/agent/token-format"
import type { ContextSource } from "@/lib/types"
import { cn } from "@/lib/utils"

/** 阅读区里「启动输入」块的跳转目标（与提问的 exchange id 同一套跳转）。 */
export const STARTUP_CONTEXT_ID = "startup-context"

/**
 * 启动时注入给 Agent 的上下文。总量是首次请求报回的输入 token（精确）；各项是离线估算，
 * 两者之差是会话文件里没有记下的部分（工具定义、首个提问等）。默认收成一行，展开按大小列出。
 */
export function StartupContext({
  items,
  totalTokens,
}: {
  items: ContextSource[]
  totalTokens: number | null
}) {
  const t = useTranslations("Folder.sessionViewer")
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const [expanded, setExpanded] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.tokens - a.tokens),
    [items]
  )
  const listed = items.reduce((sum, item) => sum + item.tokens, 0)
  const unlisted = totalTokens != null ? totalTokens - listed : 0
  const approx = (tokens: number) =>
    t("approxTokens", { tokens: formatTokenCount(tokens) })

  return (
    <section
      aria-label={t("contextTitle")}
      className="rounded-lg border bg-muted/20 px-3 py-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform",
            expanded && "rotate-90"
          )}
        />
        <span className="font-medium text-foreground">{t("contextTitle")}</span>
        <span>
          {t("contextItems", { count: items.length })} ·{" "}
          {totalTokens != null
            ? t("startupTokens", { tokens: formatTokenCount(totalTokens) })
            : approx(listed)}
        </span>
      </button>
      {expanded && (
        <ul className="mt-1 -mx-3">
          {sorted.map((item, index) => {
            const label =
              item.name ?? item.path ?? item.text.trim().split("\n")[0]
            return (
              <li key={index}>
                <div className="flex items-center hover:bg-muted">
                  <button
                    type="button"
                    aria-expanded={open === index}
                    onClick={() => setOpen(open === index ? null : index)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1 text-left text-xs"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground transition-transform",
                        open === index && "rotate-90"
                      )}
                    />
                    <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">
                      {item.source}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {approx(item.tokens)}
                    </span>
                  </button>
                  {item.path && (
                    <button
                      type="button"
                      aria-label={t("contextOpenFile", { path: item.path })}
                      title={item.path}
                      onClick={() => void openFilePreview(item.path!)}
                      className="mr-2 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="size-3" />
                    </button>
                  )}
                </div>
                {open === index && (
                  <pre className="mx-3 my-1 max-h-96 overflow-auto rounded bg-muted/50 p-2 text-xs whitespace-pre-wrap">
                    {item.text}
                  </pre>
                )}
              </li>
            )
          })}
          {unlisted > 0 && (
            <li className="flex items-center gap-1.5 px-3 py-1 pl-7.5 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {t("startupUnlisted")}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums">
                {approx(unlisted)}
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
