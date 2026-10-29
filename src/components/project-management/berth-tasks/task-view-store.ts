"use client"

import { create } from "zustand"
import { type BerthTaskView, getTaskView } from "@/lib/agent/berth-tasks"

/**
 * 单个任务的派生视图：工具栏（FileWorkspaceHeader）与任务页正文不在同一棵组件树，
 * 按「项目:任务」在这里汇合；任务页负责轮询，工具栏操作后调 load 刷新。
 */
interface TaskViewState {
  views: Record<string, BerthTaskView>
  errors: Record<string, string>
  load: (folderId: number, task: string) => Promise<void>
}

export const taskViewKey = (folderId: number, task: string) =>
  `${folderId}:${task}`

export const useTaskViewStore = create<TaskViewState>((set) => ({
  views: {},
  errors: {},
  load: (folderId, task) =>
    getTaskView(folderId, task)
      .then((response) => {
        const key = taskViewKey(folderId, task)
        set((state) =>
          response.ok
            ? {
                views: { ...state.views, [key]: response.result },
                errors: { ...state.errors, [key]: "" },
              }
            : { errors: { ...state.errors, [key]: response.error.message } }
        )
      })
      .catch(() => {}),
}))

export function useTaskView(folderId: number, task: string) {
  const key = taskViewKey(folderId, task)
  const view = useTaskViewStore((state) => state.views[key] ?? null)
  const error = useTaskViewStore((state) => state.errors[key] || null)
  return { view, error }
}
