"use client"

/**
 * 项目首页模块。中间左栏没有 tab、或点了 tab 条的软件图标时显示，懒加载，不显示就整块卸载。
 *
 * 首页只放图与摘要，列表在侧栏（任务、Git 改动、Agent 轨迹、知识库笔记）。
 *
 * - `project-home.tsx`  页面：脉搏条 → 需要你 → worktree 与 Agent（港湾）→ 提交热力 + Token 用量 → 知识星图
 * - `harbor.tsx`        港湾：一个泊位一个 worktree，船的状态 = 那里 Agent 的状态
 * - `commit-heatmap.tsx` 提交热力：本仓库每天的提交数
 * - `token-usage.tsx`   Token 用量：本项目会话近 14 天按 Agent 的用量
 * - `use-home-data.ts`  启用状态、任务、各 worktree 的 git 概况
 * - `boat-layout.ts`    船的路径（取自 public/icon-animated.svg）
 * - 知识星图是知识库的组件：`src/knowledge/components/knowledge-orbit.tsx`，详情在侧栏「记忆」
 * - 动画 CSS 在 `src/app/globals.css` 的 `.berth-harbor-*` / `.berth-orbit-*`
 */

import { useCallback, useMemo, type ReactNode } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  MAIN_GROUP,
  taskRunState,
} from "@/components/project-management/berth-tasks/task-state"
import { LineCounts } from "@/components/layout/git/line-counts"
import {
  useProjectPanelStore,
  useSidebarViewStore,
  type SidebarView,
} from "@/components/layout/sidebar/views"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"
import { KnowledgeOrbit } from "@/knowledge/components/knowledge-orbit"
import {
  knowledgeWatchDirs,
  useKnowledgePathRefresh,
} from "@/knowledge/hooks/use-knowledge-path-refresh"
import { useKnowledgeSnapshot } from "@/knowledge/hooks/use-knowledge-snapshot"
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
import { CommitHeatmap } from "./commit-heatmap"
import { Harbor, type BerthTask, type HarborBerth } from "./harbor"
import { TokenUsage } from "./token-usage"
import { useHomeData, useWorktreeFamily } from "./use-home-data"

/** 没有打开的 tab（或点了 tab 条的软件图标）时，中间工作区显示的项目首页。 */
export function ProjectHome() {
  const { activeFolder } = useActiveFolder()
  if (!activeFolder) return null
  return <ProjectHomeBody key={activeFolder.id} folder={activeFolder} />
}

/** 打开侧栏的某个视图（侧栏收起时先展开）。 */
function showSidebarView(view: SidebarView) {
  useSidebarViewStore.getState().setView(view)
  if (!useAppUiStore.getState().sidebarOpen)
    useAppUiStore.getState().toggleSidebar()
}

/** Git 在项目视图的下方面板里：展开并切到变更。 */
function showGitPanel() {
  showSidebarView("projects")
  useProjectPanelStore.getState().showPanel("changes")
}

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

/** 顶部脉搏条：一行扫完全局；点了滚到首页对应区块，或打开侧栏里的列表。 */
function Pulse({
  items,
}: {
  items: (
    | {
        key: string
        label: ReactNode
        hot?: boolean
        target?: string
        onClick?: () => void
      }
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
                item.onClick
                  ? item.onClick()
                  : document
                      .getElementById(item.target ?? "")
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
  const gitHeads = useAppWorkspaceStore((s) => s.gitHeads)
  const panes = useAllAgentPanes()

  const root = folder.parent_id ?? folder.id
  const family = useWorktreeFamily(folder)
  const familyPaths = useMemo(() => family.map((f) => f.path), [family])
  const { data, reload } = useHomeData(folder.id, familyPaths)
  const { git } = useWorkspaceStateStore(folder.path)

  const enabled = data?.enabled ?? false
  const { snapshot, refresh } = useKnowledgeSnapshot(folder.id, enabled)

  // 星图是活的：知识库一有变化就重读（监听不递归，按目录登记）
  const watchDirs = useMemo(() => knowledgeWatchDirs(snapshot), [snapshot])
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
  const tasks = data.tasks.filter(
    (task) =>
      !task.archived &&
      (!data.group ||
        data.group === MAIN_GROUP ||
        (data.views.get(task.id)?.group ?? MAIN_GROUP) === data.group)
  )
  const states = tasks.map((task) =>
    taskRunState(task, data.views.get(task.id))
  )
  const running = states.filter((state) => state === "running").length
  const open = states.filter((state) => state !== "completed").length

  const enable = () =>
    void enableBerth(folder.id).then(
      (response) =>
        response.ok ? refreshAll() : toast.error(response.error.message),
      (cause) => toast.error(String(cause))
    )
  const documents = snapshot?.documents ?? []
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
                label: t.rich("pulse.tasks", {
                  count: running,
                  total: open,
                  b,
                }),
                onClick: () => showSidebarView("tasks"),
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
                onClick: showGitPanel,
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

        {!enabled && (
          <div className="mt-7">
            <EnableHint onEnable={enable} />
          </div>
        )}

        <div className="mt-7 grid gap-7 @3xl:grid-cols-2">
          <Section
            title={t("commits.title")}
            action={
              <button
                type="button"
                onClick={showGitPanel}
                className="hover:text-primary"
              >
                Git →
              </button>
            }
          >
            <div className="rounded-lg border bg-card px-4 py-3.5">
              <CommitHeatmap path={folder.path} />
            </div>
          </Section>
          <Section title={t("tokens.title")} summary={t("tokens.summary")}>
            <div className="rounded-lg border bg-card px-4 py-3.5">
              <TokenUsage folderId={folder.id} />
            </div>
          </Section>
        </div>

        {enabled && snapshot && (
          <Section
            className="mt-7"
            title={t("knowledge.title")}
            summary={t("knowledge.summary", { notes: documents.length })}
          >
            {documents.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {t("knowledge.empty")}
              </p>
            ) : (
              <KnowledgeOrbit
                documents={documents}
                edges={snapshot.edges}
                onSelectNote={() => showSidebarView("memory")}
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
