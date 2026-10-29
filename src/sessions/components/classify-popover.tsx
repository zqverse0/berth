"use client"

import { useState } from "react"
import { Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  classifySession,
  listExperts,
  type ClassifyResult,
} from "@/knowledge/api/knowledge-client"
import { JevEntries } from "@/knowledge/components/jev-entries"

const NO_EXPERT = "_"
/** 会话工具栏「Jev 分类」：选专家，对这个会话还没分类的提问跑一遍，命中直接写进「记录/」并在这里列出。 */
export function ClassifyPopover({
  folderId,
  agentType,
  sessionId,
}: {
  folderId: number
  agentType: string
  sessionId: string
}) {
  const t = useTranslations("Folder.sessionViewer.classify")
  const [experts, setExperts] = useState<
    { value: string; label: string }[] | null
  >(null)
  const [expert, setExpert] = useState(NO_EXPERT)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ClassifyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = (next: boolean) => {
    if (next && experts === null) {
      listExperts(folderId)
        .then(setExperts)
        .catch(() => setExperts([]))
    }
  }

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setResult(
        await classifySession(
          folderId,
          agentType,
          sessionId,
          expert === NO_EXPERT ? null : expert
        )
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Popover onOpenChange={open}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1 rounded px-2 text-xs transition-colors hover:bg-primary/8"
        >
          <Sparkles className="size-3.5" />
          {t("button")}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3 text-xs">
        <p className="text-muted-foreground">{t("hint")}</p>
        <div className="flex items-center gap-2">
          <Select value={expert} onValueChange={setExpert}>
            <SelectTrigger
              size="sm"
              className="min-w-0 flex-1"
              aria-label={t("expert")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_EXPERT}>{t("noExpert")}</SelectItem>
              {(experts ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={run} disabled={running}>
            {running ? t("running") : t("run")}
          </Button>
        </div>
        {error ? <p className="text-destructive">{error}</p> : null}
        {result ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              {t("summary", {
                provider: result.provider,
                classified: result.classified,
                rounds: result.rounds,
                count: result.written.length,
              })}
            </p>
            {result.error ? (
              <p className="text-destructive">{result.error}</p>
            ) : null}
            {result.written.length === 0 ? (
              <p>{t("none")}</p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <JevEntries entries={result.written} />
              </div>
            )}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
