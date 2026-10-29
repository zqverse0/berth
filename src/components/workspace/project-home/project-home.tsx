"use client"

/**
 * 项目首页模块。中间左栏没有 tab、或点了 tab 条的软件图标时显示，懒加载，不显示就整块卸载。
 *
 * - `project-home.tsx`  页面：脉搏条 → 需要你 → worktree 与 Agent（港湾）→ Agent 轨迹 → 当前任务 → 最近变更 → 知识星图
 * - `recent-changes.tsx` 最近变更：实时 +/- 行数，就地展开 diff，标出哪个 Agent 改的
 * - `trajectory.tsx` / `use-trajectory.ts`  Agent 轨迹：今天各会话的每一问与工具调用
 * - `harbor.tsx`        港湾：一个泊位一个 worktree，船的状态 = 那里 Agent 的状态
 * - `use-home-data.ts`  启用状态、任务、想法、各 worktree 的 git 概况
 * - `boat-layout.ts`    船的路径（取自 public/icon-animated.svg）
 * - 知识星图是知识库的组件：`src/knowledge/components/knowledge-orbit.tsx`
 * - 动画 CSS 在 `src/app/globals.css` 的 `.berth-harbor-*` / `.berth-orbit-*`
 */

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  MAIN_GROUP,
  taskRunState,
  type TaskRunState,
} from "@/components/project-management/berth-tasks/task-state"
import { useSidebarViewStore } from "@/components/layout/sidebar/views"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"
import { KnowledgeOrbit } from "@/knowledge/components/knowledge-orbit"
import {
  knowledgeWatchDirs,
  useKnowledgePathRefresh,
} from "@/knowledge/hooks/use-knowledge-path-refresh"
import { useKnowledgeSnapshot } from "@/knowledge/hooks/use-knowledge-snapshot"
import { OPEN_IDEA_STATUSES } from "@/knowledge/model/types"
import { openCodePath } from "@/knowledge/preview/vault-note"
import { enableBerth } from "@/lib/agent/berth-project"
import { type BerthTaskView } from "@/lib/agent/berth-tasks"
import {
  paneFolderId,
  useAllAgentPanes,
  type AgentPaneRow,
} from "@/lib/terminal/agent-panes"
import { focusTerminalTab } from "@/lib/terminal/create-and-open-primary-terminal"
import { cn } from "@/lib/utils"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import { Harbor, type BerthTask, type HarborBerth } from "./harbor"
import { LineCounts, RecentChanges } from "./recent-changes"
import { Trajectory, TrajectoryLegend } from "./trajectory"
import { useHomeData } from "./use-home-data"
import { useTrajectory } from "./use-trajectory"

/** 没有打开的 tab（或点了 tab 条的软件图标）时，中间工作区显示的项目首页。 */
export function ProjectHome() {
  const { activeFolder } = useActiveFolder()
  if (!activeFolder) return null
  return <ProjectHomeBody key={activeFolder.id} folder={activeFolder} />
}

/** 当前任务的排序：在做的在前，再按优先级。 */
const STATE_ORDER: Record<TaskRunState, number> = {
  running: 0,
  merged: 1,
  planning: 2,
  completed: 3,
}
const TASK_LIMIT = 6

function Section({
  id,
  title,
  summary,
  action,
  children,
  className,
}: {
  id?: string
  title: string
  summary?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={cn("scroll-mt-4", className)}>
      <h2 className="mb-2.5 flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
        {title}
        {summary && <span className="font-normal">· {summary}</span>}
        {action && <span className="ml-auto font-normal">{action}</span>}
      </h2>
      {children}
    </section>
  )
}

const trimSlash = (path: string) => path.replace(/[\\/]+$/, "")

/** 分到这个 checkout 的任务（在做的优先）；主目录还收没绑 worktree 的任务。 */
function berthTask(
  views: Iterable<BerthTaskView>,
  path: string,
  isRoot: boolean
): BerthTask | null {
  let best: BerthTaskView | null = null
  for (const view of views) {
    if (view.state === "completed") continue
    const here = view.worktree
      ? trimSlash(view.worktree) === trimSlash(path)
      : isRoot
    if (here && (best == null || view.state === "running")) best = view
    if (best?.state === "running") break
  }
  if (!best) return null
  return {
    title: best.title,
    done: best.steps.filter((step) => step.state !== "todo").length,
    total: best.steps.length,
  }
}

const b = (chunks: ReactNode) => (
  <b className="font-semibold text-foreground">{chunks}</b>
)

/** 顶部脉搏条：一行扫完全局，点哪项滚到对应区块。 */
function Pulse({
  items,
}: {
  items: (
    | { key: string; label: ReactNode; target: string; hot?: boolean }
    | false
  )[]
}) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground @2xl:ml-auto">
      {items.map(
        (item) =>
          item && (
            <button
              key={item.key}
              type="button"
              onClick={() =>
                document
                  .getElementById(item.target)
                  ?.scrollIntoView({ behavior: "smooth" })
              }
              className={cn(
                "hover:text-foreground",
                item.hot && "text-primary [&_b]:text-primary"
              )}
            >
              {item.label}
            </button>
          )
      )}
    </div>
  )
}

/** 需要你：等你处理的 Agent 和它问的话；「去处理」切到它的终端。 */
function AttentionList({
  rows,
  family,
  berths,
}: {
  rows: AgentPaneRow[]
  family: { id: number; path: string }[]
  berths: HarborBerth[]
}) {
  const t = useTranslations("ProjectHome")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  return (
    <div className="grid gap-2">
      {rows.map(({ descriptor, since }) => {
        const berth = berths.find(
          (item) => item.folderId === paneFolderId(descriptor, family)
        )
        const context = [
          descriptor.agentId,
          berth?.name,
          berth?.task?.title,
          format.relativeTime(new Date(since), now),
        ].filter(Boolean)
        return (
          <div
            key={descriptor.terminalId}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-muted-foreground">
                {context.join(" · ")}
              </div>
              <div className="line-clamp-2 text-sm">
                {descriptor.agentSignal?.notification || descriptor.title}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                focusTerminalTab(descriptor)
                useAppUiStore.getState().showAuxView("terminals")
              }}
              className="ml-auto shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:bg-primary/90"
            >
              {t("attention.reply")}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function ProjectHomeBody({
  folder,
}: {
  folder: NonNullable<ReturnType<typeof useActiveFolder>["activeFolder"]>
}) {
  const t = useTranslations("ProjectHome")
  const { openFilePreview, openTaskTab } = useWorkspaceRuntimeActions()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const gitHeads = useAppWorkspaceStore((s) => s.gitHeads)
  const panes = useAllAgentPanes()

  // worktree 家族：根项目 + 挂在它下面的 worktree，根在前
  const root = folder.parent_id ?? folder.id
  const family = useMemo(
    () =>
      allFolders
        .filter(
          (f) => f.kind !== "chat" && (f.id === root || f.parent_id === root)
        )
        .sort((a, b) =>
          a.id === root ? -1 : b.id === root ? 1 : a.name.localeCompare(b.name)
        ),
    [allFolders, root]
  )
  const familyPaths = useMemo(() => family.map((f) => f.path), [family])
  const { data, reload } = useHomeData(folder.id, familyPaths)
  const { git } = useWorkspaceStateStore(folder.path)

  // 轨迹：本项目 Agent 起停、换状态（多半是一问开始 / 结束）时重读会话列表
  const paneKey = panes
    .filter(
      (row) =>
        row.descriptor.agentId &&
        family.some((f) => f.id === paneFolderId(row.descriptor, family))
    )
    .map((row) => `${row.descriptor.terminalId}:${row.state}`)
    .join(",")
  const lanes = useTrajectory(folder.id, family, paneKey)
  const [focusFile, setFocusFile] = useState<string | null>(null)
  // 当前目录里的文件 → 今天最后改它的 Agent（会话按最近活动排，倒着走让最近的覆盖）
  const touched = useMemo(() => {
    const map = new Map<string, string>()
    for (const lane of [...lanes].reverse()) {
      if (lane.folderId !== folder.id) continue
      for (const turn of lane.turns ?? [])
        for (const call of turn.calls)
          for (const file of call.files) map.set(file, lane.item.agent)
    }
    return map
  }, [lanes, folder.id])
  const enabled = data?.enabled ?? false
  const { snapshot, refresh } = useKnowledgeSnapshot(folder.id, enabled)

  // 星图是活的：知识库、想法目录一有变化就重读（监听不递归，按目录登记）
  const hasIdeas = (data?.ideas.length ?? 0) > 0
  const watchDirs = useMemo(
    () => knowledgeWatchDirs(snapshot, hasIdeas),
    [snapshot, hasIdeas]
  )
  const refreshAll = useCallback(() => {
    void refresh()
    reload()
  }, [refresh, reload])
  useKnowledgePathRefresh({
    dirs: watchDirs,
    active: enabled,
    onRefresh: refreshAll,
  })

  if (data == null) return <div className="h-full bg-background" />

  const berths: HarborBerth[] = family.map((f) => {
    const head = gitHeads.get(f.id)
    return {
      folderId: f.id,
      path: f.path,
      name: f.alias || f.name,
      branch: head?.branch ?? head?.short_sha ?? f.git_branch,
      current: f.id === folder.id,
      git: data.git.get(f.path),
      // 任务视图最后到；没到（或项目没有任务）前不显示任务行，免得先闪「没有分到任务」
      task:
        data.views.size > 0
          ? berthTask(data.views.values(), f.path, f.id === root)
          : undefined,
      agents: panes.flatMap(({ descriptor, state }) =>
        descriptor.agentId &&
        state !== "exited" &&
        paneFolderId(descriptor, family) === f.id
          ? [
              {
                terminalId: descriptor.terminalId,
                agent: descriptor.agentId,
                state,
                title: descriptor.title,
                notification: descriptor.agentSignal?.notification ?? null,
              },
            ]
          : []
      ),
    }
  })
  const working = berths
    .flatMap((berth) => berth.agents)
    .filter((a) => a.state === "working").length
  const asking = panes.filter(
    (row) =>
      row.descriptor.agentId &&
      row.state === "attention" &&
      family.some((f) => f.id === paneFolderId(row.descriptor, family))
  )
  const pending = git.filter((e) => !e.path.endsWith("/"))
  const openBerth = (folderId: number) =>
    folderId === folder.id
      ? useAppUiStore.getState().showAuxView("group")
      : useTabStore.getState().activateFolderWorkspace(folderId)

  // 与任务侧栏一致：主目录看所有群的任务，worktree 只看本群
  const tasks = data.tasks
    .filter(
      (task) =>
        !task.archived &&
        taskRunState(task, data.views.get(task.id)) !== "completed" &&
        (!data.group ||
          data.group === MAIN_GROUP ||
          (data.views.get(task.id)?.group ?? MAIN_GROUP) === data.group)
    )
    .map((task) => ({
      task,
      state: taskRunState(task, data.views.get(task.id)),
    }))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state])
  const running = tasks.filter(({ state }) => state === "running").length
  const openTasksView = () => {
    useSidebarViewStore.getState().setView("tasks")
    if (!useAppUiStore.getState().sidebarOpen)
      useAppUiStore.getState().toggleSidebar()
  }

  // vault 在主项目（hub）：从别的 checkout 点笔记，文件属于主项目——点击是明确想看，直接切过去
  const openNote = (path: string) => {
    const vaultRoot = (snapshot?.root ?? folder.path).replace(/[\\/]+$/, "")
    void openFilePreview(`${vaultRoot}/${path}`, {
      folderId: folder.id,
      switchToOwner: true,
    })
  }
  const enable = () =>
    void enableBerth(folder.id).then(
      (response) =>
        response.ok ? refreshAll() : toast.error(response.error.message),
      (cause) => toast.error(String(cause))
    )
  const documents = snapshot?.documents ?? []
  const ideas = data.ideas.filter((idea) => OPEN_IDEA_STATUSES.has(idea.status))
  const head = gitHeads.get(folder.id)

  return (
    <div className="@container h-full overflow-auto bg-background">
      <div className="mx-auto max-w-[1180px] px-4 pt-6 pb-8 @2xl:px-10">
        <header className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="text-sm font-semibold">
            {folder.alias || folder.name}
          </h1>
          {(head?.branch ?? head?.short_sha) && (
            <span className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
              {head?.branch ?? head?.short_sha}
            </span>
          )}
          <Pulse
            items={[
              asking.length > 0 && {
                key: "attention",
                hot: true,
                label: t.rich("pulse.attention", { count: asking.length, b }),
                target: "home-attention",
              },
              {
                key: "working",
                label: t.rich("pulse.working", { count: working, b }),
                target: "home-harbor",
              },
              enabled && {
                key: "tasks",
                label: t.rich("pulse.tasks", { count: running, b }),
                target: "home-tasks",
              },
              {
                key: "changes",
                label: (
                  <>
                    {t.rich("pulse.changes", { count: pending.length, b })}
                    {pending.length > 0 && (
                      <>
                        {" "}
                        <LineCounts
                          additions={pending.reduce(
                            (n, e) => n + e.additions,
                            0
                          )}
                          deletions={pending.reduce(
                            (n, e) => n + e.deletions,
                            0
                          )}
                        />
                      </>
                    )}
                  </>
                ),
                target: "home-changes",
              },
            ]}
          />
        </header>

        {asking.length > 0 && (
          <Section
            id="home-attention"
            className="mb-7"
            title={t("attention.title")}
            summary={asking.length}
          >
            <AttentionList rows={asking} family={family} berths={berths} />
          </Section>
        )}

        <Section
          id="home-harbor"
          title={t("worktrees.title")}
          summary={t("worktrees.summary", { count: berths.length })}
        >
          <Harbor berths={berths} onOpen={openBerth} />
        </Section>

        <Section
          id="home-trajectory"
          className="mt-7"
          title={t("trajectory.title")}
          summary={t("trajectory.summary", { count: lanes.length })}
          action={<TrajectoryLegend />}
        >
          <Trajectory
            folderId={folder.id}
            lanes={lanes}
            focusFile={focusFile}
          />
        </Section>

        <Section
          id="home-tasks"
          className="mt-7"
          title={t("tasks.title")}
          summary={
            enabled
              ? t("tasks.summary", { running, total: tasks.length })
              : undefined
          }
          action={
            enabled && (
              <button
                type="button"
                onClick={openTasksView}
                className="hover:text-primary"
              >
                {t("tasks.all")} →
              </button>
            )
          }
        >
          {!enabled ? (
            <EnableHint onEnable={enable} />
          ) : tasks.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              {t("tasks.empty")}
            </p>
          ) : (
            tasks.slice(0, TASK_LIMIT).map(({ task, state }) => (
              <button
                key={task.id}
                type="button"
                title={task.id}
                onClick={() =>
                  openTaskTab({
                    folderId: folder.id,
                    taskDirName: task.id,
                    title: task.title,
                  })
                }
                className="-mx-2.5 flex w-[calc(100%+20px)] items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full border-[1.5px] border-muted-foreground",
                    state === "running" &&
                      "border-primary bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_18%,transparent)]"
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    state === "running" && "font-medium"
                  )}
                >
                  {task.title}
                </span>
              </button>
            ))
          )}
        </Section>

        <div id="home-changes" className="mt-7 scroll-mt-4">
          <RecentChanges
            folderPath={folder.path}
            git={git}
            touched={touched}
            onFocusFile={setFocusFile}
            onOpenFile={(path) =>
              void openFilePreview(path, { folderId: folder.id })
            }
          />
        </div>

        {enabled && snapshot && (
          <Section
            className="mt-7"
            title={t("knowledge.title")}
            summary={t("knowledge.summary", {
              notes: documents.length,
              ideas: ideas.length,
            })}
          >
            {documents.length === 0 && ideas.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {t("knowledge.empty")}
              </p>
            ) : (
              <KnowledgeOrbit
                documents={documents}
                edges={snapshot.edges}
                ideas={ideas}
                onOpenNote={openNote}
                onOpenCode={(code) =>
                  openCodePath(
                    folder.path,
                    code,
                    (path) =>
                      void openFilePreview(path, { folderId: folder.id })
                  )
                }
              />
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

function EnableHint({ onEnable }: { onEnable: () => void }) {
  const t = useTranslations("ProjectHome")
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
      {t("disabled.hint")}
      <button
        type="button"
        onClick={onEnable}
        className="rounded bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/90"
      >
        {t("disabled.enable")}
      </button>
    </div>
  )
}
