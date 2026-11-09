"use client"

import { useTranslations } from "next-intl"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import type { BerthTaskView } from "@/lib/agent/berth-tasks"
import { useOpenProjectSession } from "@/sessions/project/open-project-session"

/** 归档时关联到的会话：点击打开原会话，原会话已被清理时打开快照。 */
export function TaskSessions({
  folderId,
  view,
}: {
  folderId: number
  view: BerthTaskView
}) {
  const t = useTranslations("BerthTasks.group.sessions")
  const workspace = useWorkspaceRuntimeActions()
  const openSession = useOpenProjectSession(folderId)
  if (!view.sessions?.length) return null
  return (
    <section className="mt-1.5 space-y-px">
      <h2 className="px-1 text-[11px] font-medium text-muted-foreground">
        {t("title")}
      </h2>
      {view.sessions.map((session) => (
        <button
          key={`${session.agent}:${session.id}`}
          type="button"
          className="flex w-full min-w-0 items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
          onClick={() =>
            void openSession(
              {
                agent: session.agent,
                sessionId: session.id,
                cwd: session.cwd,
                title: session.title,
              },
              () => void workspace.openFilePreview(session.snapshot)
            )
          }
        >
          <span className="min-w-0 flex-1 truncate">
            {session.title || t("untitled")}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {session.agent}
          </span>
        </button>
      ))}
    </section>
  )
}
