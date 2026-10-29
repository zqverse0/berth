"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { unreadPathKey, useGroupUnreadStore } from "@/lib/agent/group-unread"
import {
  paneDot,
  paneFolderId,
  useAgentPaneStore,
  useAllAgentPanes,
} from "@/lib/terminal/agent-panes"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** 项目行尾：群里未读消息数，以及有 Agent 停下来等你时的琥珀点。点项目行本身就进群。 */
export const ProjectGroupBadge = memo(function ProjectGroupBadge({
  folderId,
  folderPath,
}: {
  folderId: number
  folderPath: string
}) {
  const t = useTranslations("Folder.sidebar")
  const unread = useGroupUnreadStore(
    (state) => state.byPath[unreadPathKey(folderPath)] ?? 0
  )
  const folders = useAppWorkspaceStore((state) => state.allFolders)
  const panes = useAllAgentPanes()
  const seen = useAgentPaneStore((state) => state.seen)
  const waiting = panes.some(
    (row) =>
      row.descriptor.agentId &&
      paneFolderId(row.descriptor, folders) === folderId &&
      paneDot(row, seen) === "attention"
  )
  if (unread === 0 && !waiting) return null
  return (
    <span className="flex shrink-0 items-center gap-1 px-1">
      {waiting ? (
        <span
          role="img"
          aria-label={t("agentWaiting")}
          title={t("agentWaiting")}
          data-group-waiting
          className="size-2 rounded-full bg-amber-500"
        />
      ) : null}
      {unread > 0 ? (
        <span
          title={t("groupUnread", { count: unread })}
          aria-label={t("groupUnread", { count: unread })}
          data-group-unread={unread}
          className="min-w-4 rounded-full bg-link px-1 text-center text-[0.625rem] font-semibold leading-4 text-background tabular-nums"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </span>
  )
})
