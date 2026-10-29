"use client"

/**
 * 首页「最近变更」：未提交的改动（实时，来自工作区 git 流）+ 最近几次提交，按提交分组列出改过的文件。
 * 每行显示 +/- 行数，点击就地展开 diff，不跳转；行尾图标才打开文件。
 */

import { useEffect, useState, type ReactNode } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ChevronRight, ExternalLink } from "lucide-react"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { gitDiff, gitLog, gitShowDiff, readFilePreview } from "@/lib/api"
import type { GitLogEntry, WorkspaceGitEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

// 列最近几次提交
const COMMITS = 5

interface Change {
  path: string
  status: string
  additions: number
  deletions: number
  /** 所在提交；未提交的为 null */
  commit: string | null
}

export function RecentChanges({
  folderPath,
  git,
  touched,
  onFocusFile,
  onOpenFile,
}: {
  folderPath: string
  /** 工作区实时 git 流的未提交条目 */
  git: WorkspaceGitEntry[]
  /** 文件 → 今天改过它的 Agent（来自轨迹） */
  touched: ReadonlyMap<string, string>
  /** 悬停文件时告诉轨迹高亮哪些调用；离开传 null */
  onFocusFile: (path: string | null) => void
  onOpenFile: (path: string) => void
}) {
  const t = useTranslations("ProjectHome")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  // 未提交集合变了（提交、撤销、新建文件）才重读提交记录，普通保存不重读
  const statusKey = git.map((e) => `${e.status} ${e.path}`).join("\n")
  useEffect(() => {
    let disposed = false
    gitLog(
      folderPath,
      COMMITS,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      true
    )
      .then((log) => !disposed && setCommits(log.entries))
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [folderPath, statusKey])

  // 未跟踪的整目录不是文件，跳过
  const pending = git.filter((e) => !e.path.endsWith("/"))
  const added = pending.reduce((sum, e) => sum + e.additions, 0)
  const removed = pending.reduce((sum, e) => sum + e.deletions, 0)
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const row = (change: Change) => {
    const key = `${change.commit ?? ""}:${change.path}`
    return (
      <ChangeRow
        key={key}
        folderPath={folderPath}
        change={change}
        agent={touched.get(change.path)}
        expanded={open.has(key)}
        onToggle={() => toggle(key)}
        // 未提交的随工作区 git 流刷新
        version={change.commit ? null : git}
        onFocusFile={onFocusFile}
        onOpenFile={onOpenFile}
      />
    )
  }

  return (
    <section>
      <h2 className="mb-2.5 text-xs font-medium text-muted-foreground">
        {t("recent.title")}
      </h2>
      {pending.length === 0 && commits.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t("recent.empty")}
        </p>
      ) : (
        <div className="grid grid-cols-1">
          {pending.length > 0 && (
            <Group
              expanded={open.has("group:")}
              onToggle={() => toggle("group:")}
              header={
                <>
                  <span className="min-w-0 flex-1 truncate text-primary">
                    {t("recent.summary", { count: pending.length })}
                  </span>
                  <LineCounts additions={added} deletions={removed} />
                </>
              }
            >
              {pending.map((entry) => row({ ...entry, commit: null }))}
            </Group>
          )}
          {commits.map((commit) => (
            <Group
              key={commit.full_hash}
              expanded={open.has(`group:${commit.full_hash}`)}
              onToggle={() => toggle(`group:${commit.full_hash}`)}
              header={
                <>
                  <span
                    className="min-w-0 flex-1 truncate text-foreground"
                    title={commit.message}
                  >
                    {commit.message.split("\n")[0]}
                  </span>
                  <span className="shrink-0 font-mono">{commit.hash}</span>
                  <span className="w-16 shrink-0 text-right whitespace-nowrap">
                    {format.relativeTime(new Date(commit.date), now)}
                  </span>
                </>
              }
            >
              {commit.files.map((file) =>
                row({ ...file, commit: commit.full_hash })
              )}
            </Group>
          ))}
        </div>
      )}
    </section>
  )
}

/** 一组变更（未提交 / 某次提交）：默认只露一行标题，点开才列文件 */
function Group({
  header,
  expanded,
  onToggle,
  children,
}: {
  header: ReactNode
  expanded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="-mx-2 flex w-[calc(100%+16px)] items-baseline gap-2 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 self-center transition-transform",
            expanded && "rotate-90"
          )}
        />
        {header}
      </button>
      {expanded && <div className="pb-1 pl-5">{children}</div>}
    </div>
  )
}

function ChangeRow({
  folderPath,
  change,
  agent,
  expanded,
  onToggle,
  version,
  onFocusFile,
  onOpenFile,
}: {
  folderPath: string
  change: Change
  agent: string | undefined
  expanded: boolean
  onToggle: () => void
  version: unknown
  onFocusFile: (path: string | null) => void
  onOpenFile: (path: string) => void
}) {
  const t = useTranslations("ProjectHome")
  const slash = change.path.lastIndexOf("/")
  return (
    <div>
      <div
        className="group -mx-2 flex items-center rounded hover:bg-accent"
        onMouseEnter={() => onFocusFile(change.path)}
        onMouseLeave={() => onFocusFile(null)}
      >
        <button
          type="button"
          title={change.path}
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-baseline gap-2 py-1 pl-2 text-left font-mono text-xs"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 self-center text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          <span
            className={cn(
              "max-w-full min-w-0 truncate",
              change.status.includes("D") && "line-through"
            )}
          >
            {change.path.slice(slash + 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {change.path.slice(0, Math.max(slash, 0))}
          </span>
          {agent && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 font-sans text-[10.5px] text-muted-foreground">
              {agent}
            </span>
          )}
          {change.status === "??" ? (
            <span className="shrink-0 text-[11px] whitespace-nowrap text-green-700 dark:text-green-400">
              {t("recent.new")}
            </span>
          ) : (
            <LineCounts
              additions={change.additions}
              deletions={change.deletions}
            />
          )}
        </button>
        <button
          type="button"
          title={t("recent.open")}
          aria-label={t("recent.open")}
          disabled={change.status.includes("D")}
          onClick={() =>
            onOpenFile(`${folderPath.replace(/[\\/]+$/, "")}/${change.path}`)
          }
          className="shrink-0 px-2 py-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-primary focus-visible:opacity-100 disabled:invisible"
        >
          <ExternalLink className="size-3" />
        </button>
      </div>
      {expanded && (
        <ChangeDiff folderPath={folderPath} change={change} version={version} />
      )}
    </div>
  )
}

export function LineCounts({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}) {
  // 未跟踪文件不进 numstat，0/0 不代表没改，不显示
  if (additions === 0 && deletions === 0) return null
  return (
    <span className="shrink-0 font-mono text-[11px] whitespace-nowrap">
      <span className="text-green-700 dark:text-green-400">+{additions}</span>{" "}
      <span className="text-red-700 dark:text-red-400">−{deletions}</span>
    </span>
  )
}

function ChangeDiff({
  folderPath,
  change,
  version,
}: {
  folderPath: string
  change: Change
  version: unknown
}) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    const load = change.commit
      ? gitShowDiff(folderPath, change.commit, change.path)
      : change.status === "??"
        ? // 未跟踪文件不进 git diff：读出内容拼成新增补丁，按新文件渲染
          readFilePreview(folderPath, change.path).then(
            ({ content }) =>
              `*** Add File: ${change.path}\n` +
              content
                .replace(/\n$/, "")
                .split("\n")
                .map((line) => `+${line}`)
                .join("\n")
          )
        : gitDiff(folderPath, change.path)
    load.then(
      (diff) => !disposed && setText(diff),
      () => !disposed && setText("")
    )
    return () => {
      disposed = true
    }
  }, [folderPath, change.commit, change.path, change.status, version])

  return (
    <div className="mt-0.5 mb-2 overflow-hidden rounded-md border bg-background">
      {text == null ? (
        <div className="h-8" />
      ) : (
        <UnifiedDiffPreview diffText={text} embedded className="h-auto" />
      )}
    </div>
  )
}
