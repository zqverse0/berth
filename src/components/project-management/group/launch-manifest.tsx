"use client"

import { useEffect, useState } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import {
  inspectLaunch,
  readLaunchManifest,
  type LaunchInspection,
  type LaunchManifest,
  type LaunchRecord,
} from "@/lib/agent/berth-group"
import { getTerminalSession } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"

/** 启动计划的一项：字符串数组显示成标签，其余原样显示。 */
export function PlanValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item) => (
          <span
            key={item}
            className="rounded border border-border/60 px-1 font-mono text-[10px]"
          >
            {item}
          </span>
        ))}
      </span>
    )
  if (typeof value === "string") return <>{value}</>
  return <code className="font-mono text-[10px]">{JSON.stringify(value)}</code>
}

export const planEntries = (plan: LaunchRecord["plan"]) =>
  Object.entries(plan ?? {}).filter(
    ([, value]) =>
      value != null &&
      !(Array.isArray(value) && value.length === 0) &&
      !(
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
      )
  )

export interface ManifestRow {
  kind: string
  id: string
  status: string
  reason?: string
  source?: string
}

// 声明与实际有差异的靠前：没人报告、结果不明、被跳过。其余保持报告顺序。
const STATUS_ORDER: Record<string, number> = {
  unhandled: 0,
  unknown: 1,
  skipped: 2,
}

/** 清单 → 显示行：只看 kind / id / status / reason，不认识任何具体 Agent 或资产类型。 */
export function manifestRows(manifest: LaunchManifest): ManifestRow[] {
  return differencesFirst([
    ...manifest.unhandled.map((item) => ({ ...item, status: "unhandled" })),
    ...manifest.report,
  ])
}

function differencesFirst(rows: ManifestRow[]): ManifestRow[] {
  const rank = (row: ManifestRow) => STATUS_ORDER[row.status] ?? 3
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row)
}

const KNOWN_STATUSES = [
  "unhandled",
  "applied",
  "converted",
  "skipped",
  "isolated",
  "kept",
  "unknown",
] as const

const isKnownStatus = (
  status: string
): status is (typeof KNOWN_STATUSES)[number] =>
  (KNOWN_STATUSES as readonly string[]).includes(status)

const STATUS_STYLE: Record<string, string> = {
  unhandled: "border-destructive/40 text-destructive",
  unknown: "border-amber-500/40 text-amber-600 dark:text-amber-500",
  skipped: "border-amber-500/40 text-amber-600 dark:text-amber-500",
}

function Meta({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 py-0.5 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all">{children}</span>
    </div>
  )
}

function OpenButton({ path }: { path: string }) {
  const t = useTranslations("LaunchManifest")
  const { openFilePreview } = useWorkspaceRuntimeActions()
  return (
    <button
      type="button"
      title={path}
      aria-label={t("open", { path })}
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
      onClick={() => void openFilePreview(path)}
    >
      <ExternalLink aria-hidden="true" className="size-3" />
    </button>
  )
}

/** 通用的结果行：只看 kind / id / status / reason。 */
function ManifestRows({ rows }: { rows: ManifestRow[] }) {
  const t = useTranslations("LaunchManifest")
  // 插件可以报告新状态：认识的翻译，不认识的原样显示。
  const statusLabel = (status: string) =>
    isKnownStatus(status) ? t(`status.${status}`) : status
  return (
    <ul>
      {rows.map((row) => (
        <li
          key={`${row.kind}/${row.id}`}
          data-status={row.status}
          className="flex min-w-0 items-baseline gap-2 py-0.5 text-xs"
        >
          <span
            className={cn(
              "w-16 shrink-0 rounded border border-border/60 px-1 text-center text-[10px]",
              STATUS_STYLE[row.status]
            )}
          >
            {statusLabel(row.status)}
          </span>
          <span className="min-w-0 flex-1 break-all">
            <span className="font-mono text-[11px]">
              {row.kind}/{row.id}
            </span>
            {row.reason ? (
              <span className="ml-2 text-muted-foreground">{row.reason}</span>
            ) : null}
          </span>
          {row.source ? <OpenButton path={row.source} /> : null}
        </li>
      ))}
    </ul>
  )
}

/** inspect 钩子的进度：还没出结果、出错，或结果。 */
export type InspectionState =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "done"; result: LaunchInspection }

/** 插件实际核对的结果；插件没实现钩子就是「未验证」。 */
function InspectionSection({ inspection }: { inspection: InspectionState }) {
  const t = useTranslations("LaunchManifest")
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-medium text-muted-foreground">
        {t("inspection")}
      </h3>
      {inspection.state === "loading" ? (
        <Loader2
          aria-label={t("loading")}
          className="size-3.5 animate-spin text-muted-foreground"
        />
      ) : inspection.state === "failed" ? (
        <p className="text-xs text-muted-foreground">
          {t("inspectionFailed", { error: inspection.error })}
        </p>
      ) : !inspection.result.implemented ? (
        <p className="text-xs text-muted-foreground">{t("unverified")}</p>
      ) : inspection.result.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("nothingToVerify")}</p>
      ) : (
        <ManifestRows rows={differencesFirst(inspection.result.items)} />
      )}
    </section>
  )
}

/** 一份启动清单：每项资产的结果（差异靠前）、实际核对、计划、提示词快照。 */
export function LaunchManifestView({
  manifest,
  inspection,
}: {
  manifest: LaunchManifest
  inspection?: InspectionState
}) {
  const t = useTranslations("LaunchManifest")
  const format = useFormatter()
  const rows = manifestRows(manifest)
  const plan = planEntries(manifest.plan)
  return (
    <div className="space-y-4">
      <section>
        <Meta label={t("agent")}>{manifest.agent}</Meta>
        <Meta label={t("expert")}>
          {manifest.expert
            ? `${manifest.expert.name} (${manifest.expert.id})`
            : t("noExpert")}
        </Meta>
        {manifest.provider ? (
          <Meta label={t("provider")}>
            {[manifest.provider.name, manifest.provider.model]
              .filter(Boolean)
              .join(" · ")}
          </Meta>
        ) : null}
        <Meta label={t("startedAt")}>
          {format.dateTime(new Date(manifest.startedAt), {
            dateStyle: "short",
            timeStyle: "medium",
          })}
        </Meta>
        <Meta label={t("cwd")}>{manifest.cwd}</Meta>
      </section>

      <section className="space-y-1">
        <h3 className="text-[11px] font-medium text-muted-foreground">
          {t("assets", { count: rows.length })}
        </h3>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noAssets")}</p>
        ) : (
          <ManifestRows rows={rows} />
        )}
      </section>

      {inspection ? <InspectionSection inspection={inspection} /> : null}

      {plan.length > 0 ? (
        <section className="space-y-1">
          <h3 className="text-[11px] font-medium text-muted-foreground">
            {t("plan")}
          </h3>
          {plan.map(([key, value]) => (
            <Meta key={key} label={key}>
              <PlanValue value={value} />
            </Meta>
          ))}
        </section>
      ) : null}

      {manifest.prompt ? (
        <details className="space-y-1 text-xs">
          <summary className="flex cursor-pointer items-baseline gap-2 text-[11px] font-medium text-muted-foreground">
            {t("prompt")}
            <span className="truncate font-mono font-normal">
              {manifest.prompt.hash?.slice(0, 19)}
            </span>
            {manifest.prompt.file ? (
              <OpenButton path={manifest.prompt.file} />
            ) : null}
          </summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-[11px]">
            {manifest.prompt.text}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

/** 任意终端的启动清单：按 targetRef 取这个终端最近一次启动；不是 Berth 启动的 Agent 就没有。 */
export function LaunchManifestDialog({
  terminalId,
  onClose,
}: {
  terminalId: string
  onClose: () => void
}) {
  const t = useTranslations("LaunchManifest")
  const [state, setState] = useState<{
    manifest: LaunchManifest | null
    error: string | null
  } | null>(null)
  const [inspection, setInspection] = useState<InspectionState>({
    state: "loading",
  })
  useEffect(() => {
    let live = true
    void (async () => {
      const { targetRef } = await getTerminalSession(terminalId)
      const manifest = targetRef ? await readLaunchManifest(targetRef) : null
      if (live) setState({ manifest, error: null })
      if (!targetRef || !manifest) return
      // 清单先显示；核对可能要几秒（插件会实际问一次 Agent）。
      void inspectLaunch(targetRef).then(
        (result) => live && setInspection({ state: "done", result }),
        (cause: unknown) =>
          live &&
          setInspection({ state: "failed", error: toErrorMessage(cause) })
      )
    })().catch((cause: unknown) => {
      if (live) setState({ manifest: null, error: toErrorMessage(cause) })
    })
    return () => {
      live = false
    }
  }, [terminalId])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        {!state ? (
          <Loader2
            aria-label={t("loading")}
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : state.error ? (
          <p role="alert" className="text-xs text-destructive">
            {state.error}
          </p>
        ) : state.manifest ? (
          <LaunchManifestView
            manifest={state.manifest}
            inspection={inspection}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{t("none")}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
