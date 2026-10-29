import { useCallback, useEffect, useState } from "react"
import { listIdeas } from "@/knowledge/api/knowledge-client"
import type { Idea } from "@/knowledge/model/types"
import { gitLog } from "@/lib/api"
import { listGroups } from "@/lib/agent/berth-group"
import { getBerthStatus } from "@/lib/agent/berth-project"
import {
  listBerthTasks,
  listBerthTaskViews,
  type BerthTaskSummary,
  type BerthTaskView,
} from "@/lib/agent/berth-tasks"

/** 一个 worktree 的最近提交；读不到（非 git、路径失效）时为 null。未提交改动走工作区实时流。 */
export interface WorktreeGit {
  commit: { message: string; date: string } | null
}

interface HomeData {
  enabled: boolean
  tasks: BerthTaskSummary[]
  /** 派生视图：状态从 git / prd 推出（与任务侧栏同一口径），读不到时按 task.json 近似。 */
  views: Map<string, BerthTaskView>
  /** 当前 checkout 的群；任务按它过滤（主目录看全部） */
  group: string | null
  ideas: Idea[]
  /** worktree 路径 → git 概况 */
  git: Map<string, WorktreeGit>
}

async function worktreeGit(path: string): Promise<WorktreeGit> {
  const head = (await gitLog(path, 1)).entries[0]
  return {
    commit: head
      ? { message: head.message.split("\n")[0], date: head.date }
      : null,
  }
}

const EMPTY_BERTH = {
  tasks: [],
  views: new Map(),
  group: null,
  ideas: [],
} satisfies Omit<HomeData, "enabled" | "git">

/**
 * 首页数据：启用状态、任务、想法，各 worktree 的 git 概况；单项失败只让那一块空着。
 * `worktreePaths` 是本项目 worktree 家族（含主目录）的路径。
 *
 * 请求同时发出、按到达分三步写入：git 概况先到页面就出来，任务 / 想法随后，
 * 任务视图（后端要跑一串 git，大项目近一秒）最后补上；重读时沿用上一轮的值，不闪空。
 */
export function useHomeData(folderId: number, worktreePaths: string[]) {
  const [data, setData] = useState<HomeData | null>(null)
  const [revision, setRevision] = useState(0)
  const pathsKey = worktreePaths.join("\n")
  useEffect(() => {
    let disposed = false
    const paths = pathsKey.split("\n").filter(Boolean)
    // 没启用的项目这几个请求会报错，结果直接丢掉
    const rest = Promise.allSettled([
      listBerthTasks(folderId),
      listGroups(folderId),
      listIdeas(folderId),
    ])
    const views = Promise.allSettled([listBerthTaskViews(folderId)])
    void (async () => {
      const [status, ...git] = await Promise.allSettled([
        getBerthStatus(folderId),
        ...paths.map(worktreeGit),
      ])
      if (disposed) return
      const enabled =
        status.status === "fulfilled" &&
        status.value.ok &&
        status.value.result.enabled
      const base = {
        enabled,
        git: new Map(
          paths.map((path, index) => {
            const result = git[index]
            return [
              path,
              result.status === "fulfilled"
                ? (result.value as WorktreeGit)
                : { commit: null },
            ]
          })
        ),
      }
      setData((prev) => ({
        ...(enabled ? (prev ?? EMPTY_BERTH) : EMPTY_BERTH),
        ...base,
      }))
      if (!enabled) return

      const [tasks, groups, ideas] = await rest
      if (disposed) return
      setData((prev) => ({
        ...prev!,
        tasks:
          tasks.status === "fulfilled" && tasks.value.ok
            ? tasks.value.result.tasks
            : [],
        group:
          groups.status === "fulfilled" && groups.value.ok
            ? (groups.value.result.groups[0] ?? null)
            : null,
        ideas: ideas.status === "fulfilled" ? ideas.value : [],
      }))

      const [view] = await views
      if (disposed) return
      setData((prev) => ({
        ...prev!,
        views: new Map(
          view.status === "fulfilled" && view.value.ok
            ? view.value.result.tasks.map((item) => [item.taskDirName, item])
            : []
        ),
      }))
    })()
    return () => {
      disposed = true
    }
  }, [folderId, pathsKey, revision])
  return { data, reload: useCallback(() => setRevision((r) => r + 1), []) }
}
