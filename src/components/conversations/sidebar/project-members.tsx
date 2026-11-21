"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { copyPathToClipboard } from "@/components/layout/file-tree/file-tree-node"
import { isDesktop } from "@/lib/platform"
import type { FolderDetail } from "@/lib/types"
import {
  useAppWorkspaceStore,
  type MemberFlags,
} from "@/stores/app-workspace-store"
import { isMainMember, mainFolderId } from "@/lib/workspace/projects"
import { MemberRail, sessionIndent } from "./project-row-face"
import { MemberRow, type MoveTarget } from "./member-row"
import { useMemberChanges } from "./use-member-changes"
import { ProjectReferences } from "./project-references"
import { useBrowsedReference } from "@/lib/workspace/reference-browse"
import type { ProjectListRow } from "./sidebar-rows"
import type { SidebarSession } from "./sidebar-sessions"
import type { RowDevice } from "./project-row"
import { DeviceProjectMenuItems, useDeviceDrop } from "./device-projects"

export type MemberFolder = Pick<
  FolderDetail,
  "id" | "name" | "path" | "git_branch" | "project"
>

/** 成员行上的操作，按成员 id 调。 */
export interface MemberHandlers {
  onSelect: (folderId: number) => void
  /** 在系统文件管理器里显示（本机、桌面端）。 */
  onReveal: (folderId: number) => void
  onOpenSession: (session: SidebarSession) => void
  onOpenTerminal: (folder: MemberFolder) => void
  onViewChanges: (folderId: number) => void
  onRename: (folderId: number) => void
  onDelete: (folderId: number) => void
  onPrune: (folderId: number) => void
  onSetMain: (folderId: number) => void
  onMove: (folderId: number, projectId: number) => void
  /** 移出项目（不删目录）。 */
  onDetach: (folderId: number) => void
  /** 加入了 git 发现的检出：重读这个项目的成员。 */
  onJoined: (mainFolderId: number) => void
  /** 在当前成员的文件面板浏览参考目录（null 回到成员自己）。 */
  onBrowseReference: (folderId: number, path: string | null) => void
  /** 在参考目录开终端：会话归本项目（主成员）。 */
  onReferenceTerminal: (mainFolderId: number, path: string) => void
}

/**
 * 当前项目展开后的成员：检出（主成员在前）、收成一行的临时 worktree、参考组。
 * 失效成员只给「清理」；改动数只给看得见的成员读。路径操作（打开 / 复制 / 拖入）都在成员上，项目没有目录。
 */
export function ProjectMembers({
  row,
  device,
  moveTargets,
  folderOf,
  activeFolderId,
  flags,
  visible,
  handlers,
}: {
  row: ProjectListRow<SidebarSession>
  /** 对方设备的项目；本机为 null。 */
  device: RowDevice | null
  /** 本机的其他项目（「移到项目」）。 */
  moveTargets: readonly MoveTarget[]
  folderOf: (folderId: number) => MemberFolder | undefined
  activeFolderId: number | null
  flags: ReadonlyMap<number, MemberFlags>
  visible: boolean
  handlers: MemberHandlers
}) {
  const t = useTranslations("ProjectMembers")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const deviceDrop = useDeviceDrop(device?.id ?? 0, device?.state === "online")
  const [showTemporary, setShowTemporary] = useState(false)
  const staleMembers = useAppWorkspaceStore((s) => s.staleMembers)
  const members = [
    ...row.members.flatMap((slot) => {
      const folder = folderOf(slot.folderId)
      return folder ? [{ slot, folder, flag: flags.get(folder.id) }] : []
    }),
    // 目录已不在的失效成员不在 folder 列表里，排在最后，只给「清理」。
    ...staleMembers
      .filter(
        (folder) =>
          mainFolderId(folder) === row.mainId &&
          !row.members.some((slot) => slot.folderId === folder.id)
      )
      .map((folder) => ({
        slot: { folderId: folder.id, sessions: [] },
        folder,
        flag: { stale: true, temporary: false },
      })),
  ]
  // 当前成员是临时的也照常显示，不藏进折叠里。
  const temporary = members.filter(
    ({ folder, flag }) => flag?.temporary && folder.id !== activeFolderId
  )
  const shown = members.filter((member) => !temporary.includes(member))
  const listed = showTemporary ? [...shown, ...temporary] : shown

  const current = members.find(({ folder }) => folder.id === activeFolderId)
  const browsing = useBrowsedReference(activeFolderId)
  // 对方设备的项目：改动、参考、改名删除都在对方，这里只给开终端。
  const local = row.device === 0
  const changes = useMemberChanges(
    current && !current.flag?.stale ? current.folder : null,
    listed
      .filter(({ folder, flag }) => folder !== current?.folder && !flag?.stale)
      .map(({ folder }) => folder),
    visible && local
  )

  const renderMember = ({ slot, folder, flag }: (typeof members)[number]) => {
    const main = isMainMember(folder)
    return (
      <MemberRow
        key={folder.id}
        folderId={folder.id}
        name={folder.name}
        path={folder.path}
        branch={folder.git_branch}
        worktree={!main}
        selected={folder.id === activeFolderId && browsing == null}
        stale={flag?.stale}
        changes={changes.get(folder.id)}
        sessions={slot.sessions}
        onSelect={() => handlers.onSelect(folder.id)}
        onOpenSession={handlers.onOpenSession}
        drop={device ? deviceDrop(folder.path) : undefined}
        menuExtra={
          device ? (
            <DeviceProjectMenuItems
              deviceId={device.id}
              path={folder.path}
              Item={DropdownMenuItem}
            />
          ) : null
        }
        actions={
          flag?.stale
            ? { onPrune: () => handlers.onPrune(folder.id) }
            : {
                ...(local && isDesktop()
                  ? { onReveal: () => handlers.onReveal(folder.id) }
                  : {}),
                ...(local
                  ? {
                      onCopyPath: () =>
                        void copyPathToClipboard(
                          folder.path,
                          tFileTree("toasts.copyPathFailed")
                        ),
                    }
                  : {}),
                onOpenTerminal: () => handlers.onOpenTerminal(folder),
                ...(local
                  ? { onViewChanges: () => handlers.onViewChanges(folder.id) }
                  : {}),
                ...(local
                  ? {
                      onMove: (projectId: number) =>
                        handlers.onMove(folder.id, projectId),
                      moveTargets,
                    }
                  : {}),
                ...(local && !main
                  ? {
                      onSetMain: () => handlers.onSetMain(folder.id),
                      onDetach: () => handlers.onDetach(folder.id),
                      onRename: () => handlers.onRename(folder.id),
                      onDelete: () => handlers.onDelete(folder.id),
                    }
                  : {}),
              }
        }
      />
    )
  }

  return (
    <div className="relative">
      <MemberRail />
      {shown.map(renderMember)}
      {temporary.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowTemporary((show) => !show)}
          className="block h-6 w-full truncate rounded-md text-left text-xs text-muted-foreground hover:text-foreground"
          style={{ paddingLeft: sessionIndent(false) }}
        >
          {showTemporary
            ? t("hideTemporary")
            : t("showTemporary", { count: temporary.length })}
        </button>
      ) : null}
      {showTemporary ? temporary.map(renderMember) : null}
      {local ? (
        <ProjectReferences
          folderId={row.mainId}
          browsing={browsing}
          visible={visible}
          onBrowse={(path) =>
            activeFolderId != null &&
            handlers.onBrowseReference(activeFolderId, path)
          }
          onOpenTerminal={(path) =>
            handlers.onReferenceTerminal(row.mainId, path)
          }
          onJoined={() => handlers.onJoined(row.mainId)}
        />
      ) : null}
    </div>
  )
}
