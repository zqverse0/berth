"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  UserCog,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import { confirmDialog } from "@/lib/platform"
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import { cn } from "@/lib/utils"
import { SettingsSplit } from "@/components/settings/settings-split"

/** `experts/<id>.json` 的字段，与宿主读专家（`berth-plugin-api` agent.rs）一致。 */
interface Expert {
  name: string
  prompt: string
  skills: string[]
  mcp: string[]
  plugins: string[]
}

interface ExpertEntry {
  id: string
  expert: Expert
  /** `prompts/<prompt>.md` 的正文；没有提示词文件时为 null */
  promptText: string | null
  modified: number | null
  error: string | null
}

interface Catalog {
  home: string
  experts: ExpertEntry[]
  skills: { id: string; description: string | null }[]
  mcp: string[]
  plugins: string[]
}

/** 页面上正在编辑的一份：专家字段 + 提示词正文，一起保存。 */
interface Draft {
  expert: Expert
  promptText: string
}

type AssetKind = "skills" | "mcp" | "plugins"
const ASSET_KINDS: AssetKind[] = ["skills", "mcp", "plugins"]

async function call<T>(method: string, params: Record<string, unknown> = {}) {
  const response = await runtimeBridgeOperation<T>({ method, params })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

function draftOf(entry: ExpertEntry): Draft {
  return {
    expert: structuredClone(entry.expert),
    promptText: entry.promptText ?? "",
  }
}

/**
 * 设置 →「专家」：装配 `~/.berth/experts/*.json`——提示词、Skills、MCP、Agent 插件包。
 * 提示词在页内直接编辑；资产左边勾选、右边看详情，并标出被几个专家用着，方便清理。
 */
export default function ExpertsSettingsPage() {
  const t = useTranslations("ExpertsSettings")
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [kind, setKind] = useState<AssetKind>("skills")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newId, setNewId] = useState("")

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await call<Catalog>("expert.catalog")
      setCatalog(next)
      setSelectedId((current) =>
        current && next.experts.some((entry) => entry.id === current)
          ? current
          : (next.experts[0]?.id ?? null)
      )
    } catch (cause) {
      setError(toErrorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const selected = catalog?.experts.find((entry) => entry.id === selectedId)
  // 切换专家或重新加载后，草稿回到磁盘内容。
  useEffect(() => {
    setDraft(selected ? draftOf(selected) : null)
  }, [selected])

  const usage = useMemo(() => {
    const counts: Record<AssetKind, Map<string, number>> = {
      skills: new Map(),
      mcp: new Map(),
      plugins: new Map(),
    }
    for (const entry of catalog?.experts ?? [])
      for (const assetKind of ASSET_KINDS)
        for (const item of entry.expert[assetKind])
          counts[assetKind].set(item, (counts[assetKind].get(item) ?? 0) + 1)
    return counts
  }, [catalog])

  const promptChanged =
    !!selected && !!draft && draft.promptText !== (selected.promptText ?? "")
  const dirty =
    !!selected &&
    !!draft &&
    (promptChanged ||
      JSON.stringify(draft.expert) !== JSON.stringify(selected.expert))

  const save = async () => {
    if (!selected || !draft) return
    setSaving(true)
    try {
      await call("expert.save", {
        id: selected.id,
        expert: draft.expert,
        // 只在改过时写提示词文件，没改不碰（可能被别的专家共用）。
        promptText: promptChanged ? draft.promptText : null,
        modified: selected.modified,
      })
      await reload()
    } catch (cause) {
      toast.error(toErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const create = async () => {
    const id = newId.trim()
    if (!id) return
    try {
      await call("expert.create", { id, name: id })
      setNewId("")
      setSelectedId(id)
      await reload()
    } catch (cause) {
      toast.error(toErrorMessage(cause))
    }
  }

  const remove = async () => {
    if (
      !selected ||
      !(await confirmDialog(t("deleteConfirm", { id: selected.id })))
    )
      return
    try {
      await call("expert.delete", { id: selected.id })
      setSelectedId(null)
      await reload()
    } catch (cause) {
      toast.error(toErrorMessage(cause))
    }
  }

  const sharedWith = selected
    ? (catalog?.experts.filter(
        (entry) =>
          entry.id !== selected.id &&
          !!selected.expert.prompt &&
          entry.expert.prompt === selected.expert.prompt
      ) ?? [])
    : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <UserCog className="h-4 w-4" />
            {t("title")}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {catalog ? `${catalog.home}/experts` : t("description")}
          </p>
        </div>
        <form
          className="flex shrink-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Input
            className="h-8 w-40"
            value={newId}
            placeholder={t("newIdPlaceholder")}
            onChange={(event) => setNewId(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            type="submit"
            disabled={!newId.trim()}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("create")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => void reload()}
            disabled={loading}
          >
            <RefreshCw
              className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")}
            />
            {t("refresh")}
          </Button>
        </form>
      </header>

      {error ? (
        <div className="flex items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <SettingsSplit
        list={
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {loading && !catalog ? (
              <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("loading")}
              </p>
            ) : null}
            {catalog?.experts.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{t("empty")}</p>
            ) : null}
            {catalog?.experts.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelectedId(entry.id)}
                className={cn(
                  "mb-1 flex w-full flex-col items-start rounded-md px-3 py-2 text-left hover:bg-muted",
                  selectedId === entry.id && "bg-muted"
                )}
              >
                <span className="flex w-full items-center gap-2 text-sm font-medium">
                  <span className="min-w-0 flex-1 truncate">
                    {entry.expert.name || entry.id}
                  </span>
                  {entry.error ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  ) : null}
                </span>
                <span className="mt-0.5 w-full truncate text-xs text-muted-foreground">
                  {entry.id} ·{" "}
                  {t("skillCount", { count: entry.expert.skills.length })}
                </span>
              </button>
            ))}
          </div>
        }
      >
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 text-sm">
          {selected && draft && catalog ? (
            <>
              {selected.error ? (
                <p className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
                  {t("invalid", { error: selected.error })}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                >
                  {saving ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {t("save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft(draftOf(selected))}
                  disabled={!dirty}
                >
                  {t("revert")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  onClick={() => void remove()}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("delete")}
                </Button>
              </div>

              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">
                  {t("name")}
                </span>
                <Input
                  value={draft.expert.name}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      expert: { ...draft.expert, name: event.target.value },
                    })
                  }
                />
              </label>

              {/* 提示词通常很长，默认折叠；切换专家时重新折叠。 */}
              <details key={selected.id} className="group space-y-1">
                <summary className="flex cursor-pointer items-baseline gap-2 text-xs text-muted-foreground">
                  {t("prompt")}
                  <span className="font-mono">
                    prompts/{draft.expert.prompt || selected.id}.md
                  </span>
                  {sharedWith.length > 0 ? (
                    <span className="text-amber-600 dark:text-amber-500">
                      {t("promptShared", {
                        names: sharedWith
                          .map((entry) => entry.expert.name || entry.id)
                          .join("、"),
                      })}
                    </span>
                  ) : null}
                </summary>
                <Textarea
                  className="min-h-48 font-mono text-xs"
                  value={draft.promptText}
                  placeholder={t("promptPlaceholder")}
                  onChange={(event) =>
                    setDraft({ ...draft, promptText: event.target.value })
                  }
                />
              </details>

              <section className="flex min-h-[28rem] flex-col rounded-lg border">
                <div className="flex shrink-0 gap-1 border-b p-1">
                  {ASSET_KINDS.map((assetKind) => (
                    <button
                      key={assetKind}
                      type="button"
                      onClick={() => setKind(assetKind)}
                      className={cn(
                        "rounded-md px-3 py-1 text-sm hover:bg-accent",
                        kind === assetKind && "bg-muted font-medium"
                      )}
                    >
                      {t(`kinds.${assetKind}`)}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {draft.expert[assetKind].length}
                      </span>
                    </button>
                  ))}
                </div>
                <AssetPicker
                  key={kind}
                  kind={kind}
                  selected={draft.expert[kind]}
                  candidates={
                    kind === "skills"
                      ? catalog.skills
                      : catalog[kind].map((id) => ({ id, description: null }))
                  }
                  usage={usage[kind]}
                  onChange={(items) =>
                    setDraft({
                      ...draft,
                      expert: { ...draft.expert, [kind]: items },
                    })
                  }
                />
              </section>
            </>
          ) : (
            <p className="text-muted-foreground">{t("select")}</p>
          )}
        </main>
      </SettingsSplit>
    </div>
  )
}

/**
 * 一类资产：左边只列名字，勾选即加入 / 移除（已选的排在前面）；点名字在右边看完整说明。
 * 列表里找不到的已选项（目录里已删除）标红，取消勾选后才能保存。
 */
function AssetPicker({
  kind,
  selected,
  candidates,
  usage,
  onChange,
}: {
  kind: AssetKind
  selected: string[]
  candidates: { id: string; description: string | null }[]
  usage: Map<string, number>
  onChange: (items: string[]) => void
}) {
  const t = useTranslations("ExpertsSettings")
  const [query, setQuery] = useState("")
  const [focused, setFocused] = useState<string | null>(selected[0] ?? null)
  const needle = query.trim().toLowerCase()
  const known = new Set(candidates.map((item) => item.id))
  const rows = [
    ...selected
      .filter((id) => !known.has(id))
      .map((id) => ({ id, description: null })),
    ...candidates,
  ]
    .filter(
      (item) =>
        !needle ||
        item.id.toLowerCase().includes(needle) ||
        item.description?.toLowerCase().includes(needle)
    )
    .sort(
      (a, b) =>
        Number(selected.includes(b.id)) - Number(selected.includes(a.id))
    )

  const toggle = (id: string) =>
    onChange(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id]
    )

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r">
        <div className="shrink-0 p-2">
          <Input
            className="h-8"
            value={query}
            placeholder={t("search", { count: candidates.length })}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {rows.map((item) => {
            const missing = !known.has(item.id)
            const count = usage.get(item.id) ?? 0
            return (
              <li
                key={item.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent",
                  focused === item.id && "bg-muted"
                )}
              >
                <Checkbox
                  checked={selected.includes(item.id)}
                  onCheckedChange={() => toggle(item.id)}
                  aria-label={item.id}
                />
                <button
                  type="button"
                  onClick={() => setFocused(item.id)}
                  className={cn(
                    "min-w-0 flex-1 truncate text-left font-mono text-xs",
                    missing && "text-destructive line-through"
                  )}
                  title={missing ? t("missing") : item.id}
                >
                  {item.id}
                </button>
                <span
                  className="shrink-0 text-[11px] text-muted-foreground"
                  title={t("usedBy", { count })}
                >
                  {count || ""}
                </span>
              </li>
            )
          })}
          {rows.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">
              {t("noMatch")}
            </li>
          ) : null}
        </ul>
      </div>
      <AssetDetail kind={kind} id={focused} usage={usage} />
    </div>
  )
}

/** 右侧详情：skill 渲染 SKILL.md（去掉 frontmatter），MCP 显示 JSON。 */
function AssetDetail({
  kind,
  id,
  usage,
}: {
  kind: AssetKind
  id: string | null
  usage: Map<string, number>
}) {
  const t = useTranslations("ExpertsSettings")
  // 结果带上请求键：键和当前不一致就是还在加载，不需要单独的 loading 状态。
  const [result, setResult] = useState<{
    key: string
    text: string | null
  } | null>(null)
  const key = `${kind}/${id}`

  useEffect(() => {
    if (!id) return
    let active = true
    call<string | null>("expert.asset", { kind, id }).then(
      (text) => active && setResult({ key: `${kind}/${id}`, text }),
      () => active && setResult({ key: `${kind}/${id}`, text: null })
    )
    return () => {
      active = false
    }
  }, [kind, id])

  const loading = result?.key !== key
  const text = loading ? null : result.text
  if (!id)
    return <p className="p-4 text-xs text-muted-foreground">{t("pickAsset")}</p>
  const body =
    kind === "skills" && text
      ? text.replace(/^---\n[\s\S]*?\n---\n?/, "")
      : text
  return (
    <div className="min-h-0 min-w-0 overflow-auto p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h4 className="font-mono text-sm font-semibold">{id}</h4>
        <span className="text-xs text-muted-foreground">
          {t("usedBy", { count: usage.get(id) ?? 0 })}
        </span>
      </div>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : !body ? (
        <p className="text-xs text-muted-foreground">{t("noDetail")}</p>
      ) : kind === "skills" ? (
        <MessageResponse>{body}</MessageResponse>
      ) : (
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/30 p-3 text-xs">
          {body}
        </pre>
      )}
    </div>
  )
}
