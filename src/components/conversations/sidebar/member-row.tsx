"use client"

import { memo, type ComponentProps, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowRightLeft,
  Copy,
  ExternalLink,
  FileDiff,
  House,
  LogOut,
  MoreHorizontal,
  PencilLine,
  SquareTerminal,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProjectRowButton, projectBlockClass } from "./project-row-face"
import { AgentIcons } from "./agent-icons"
import type { SidebarSession } from "./sidebar-sessions"

/** 「移到项目」的候选。 */
export interface MoveTarget {
  projectId: number
  name: string
}

/** 成员行的操作；不给的项不出现（主成员不能删 / 改名 / 移出，失效项只有「清理」）。 */
export interface MemberActions {
  onSetMain?: () => void
  /** 改挂到别的项目：`targets` 为空时不出现。 */
  onMove?: (projectId: number) => void
  moveTargets?: readonly MoveTarget[]
  /** 移出项目：不删目录。 */
  onDetach?: () => void
  onReveal?: () => void
  onCopyPath?: () => void
  onOpenTerminal?: () => void
  onViewChanges?: () => void
  onRename?: () => void
  onDelete?: () => void
  /** 失效成员：只给这一项。 */
  onPrune?: () => void
}

const HOVER_BUTTON = cn(
  "flex size-6 shrink-0 items-center justify-center rounded-[0.375rem] text-muted-foreground/90 outline-none",
  "hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
)

/** 行尾悬停才出现的小图标按钮。 */
export function HoverButton({
  label,
  title,
  onClick,
  children,
}: {
  label: string
  title?: string
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-label={label}
      className={HOVER_BUTTON}
    >
      {children}
    </button>
  )
}

/**
 * 项目展开后的一行成员：名称、灰色分支（与目录名不同才显示）、改动数、Agent 图标；
 * ⋯ 悬停才出现（启动 Agent 只在辅助面板「+」）。参考成员也用它（`icon` 换成书，`hover` 换成开终端 / 移出）。
 */
export const MemberRow = memo(function MemberRow({
  folderId,
  name,
  path,
  branch,
  worktree,
  icon,
  selected,
  stale = false,
  changes,
  sessions,
  onSelect,
  onOpenSession,
  actions,
  menuExtra,
  drop,
  hover,
}: {
  folderId: number | null
  name: string
  path: string
  branch: string | null
  worktree: boolean
  icon?: ReactNode
  selected: boolean
  stale?: boolean
  /** 未提交改动数；没读过时不显示。 */
  changes?: number
  sessions: readonly SidebarSession[]
  onSelect: () => void
  onOpenSession: (session: SidebarSession) => void
  actions: MemberActions
  /** 菜单里追加的项（对方成员的复制路径 / 粘贴）。 */
  menuExtra?: ReactNode
  /** 放下文件即传过去（对方成员）。 */
  drop?: Partial<ComponentProps<"button">>
  /** 替换默认的悬停按钮（参考成员）。 */
  hover?: ReactNode
}) {
  const t = useTranslations("ProjectMembers")
  const tSidebar = useTranslations("Folder.sidebar")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const items = (
    <>
      {actions.onReveal ? (
        <DropdownMenuItem onSelect={actions.onReveal}>
          <ExternalLink className="h-4 w-4" />
          {tFileTree("openInFileManager")}
        </DropdownMenuItem>
      ) : null}
      {actions.onCopyPath ? (
        <DropdownMenuItem onSelect={actions.onCopyPath}>
          <Copy className="h-4 w-4" />
          {tFileTree("copyPath")}
        </DropdownMenuItem>
      ) : null}
      {menuExtra}
      {actions.onOpenTerminal ? (
        <DropdownMenuItem onSelect={actions.onOpenTerminal}>
          <SquareTerminal className="h-4 w-4" />
          {t("terminalHere")}
        </DropdownMenuItem>
      ) : null}
      {actions.onViewChanges ? (
        <DropdownMenuItem onSelect={actions.onViewChanges}>
          <FileDiff className="h-4 w-4" />
          {t("viewChanges")}
        </DropdownMenuItem>
      ) : null}
      {actions.onSetMain ? (
        <DropdownMenuItem onSelect={actions.onSetMain}>
          <House className="h-4 w-4" />
          {t("setMain")}
        </DropdownMenuItem>
      ) : null}
      {actions.onMove && actions.moveTargets?.length ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowRightLeft className="h-4 w-4" />
            {t("moveTo")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {actions.moveTargets.map((target) => (
              <DropdownMenuItem
                key={target.projectId}
                onSelect={() => actions.onMove?.(target.projectId)}
              >
                {target.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {actions.onRename ? (
        <DropdownMenuItem onSelect={actions.onRename}>
          <PencilLine className="h-4 w-4" />
          {tSidebar("folderHeaderMenu.renameWorktree")}
        </DropdownMenuItem>
      ) : null}
      {actions.onDetach || actions.onDelete ? <DropdownMenuSeparator /> : null}
      {actions.onDetach ? (
        <DropdownMenuItem onSelect={actions.onDetach}>
          <LogOut className="h-4 w-4" />
          {t("detach")}
        </DropdownMenuItem>
      ) : null}
      {actions.onDelete ? (
        <>
          <DropdownMenuItem variant="destructive" onSelect={actions.onDelete}>
            <Trash2 className="h-4 w-4" />
            {tSidebar("folderHeaderMenu.deleteWorktree")}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )

  return (
    <div
      onClick={(event) => {
        if (stale || (event.target as HTMLElement).closest("button")) return
        onSelect()
      }}
      className={cn(
        projectBlockClass(selected),
        "flex h-[1.9375rem] items-center",
        stale && "cursor-default opacity-60"
      )}
    >
      <ProjectRowButton
        data-folder-id={folderId ?? undefined}
        onClick={stale ? undefined : onSelect}
        name={name}
        alias={null}
        path={stale ? `${path}\n${t("staleHint")}` : path}
        pinned={false}
        selected={selected}
        worktree={worktree}
        nested
        branch={branch}
        icon={icon}
        {...drop}
        className={cn(drop?.className, stale && "cursor-default line-through")}
      />
      <span className="flex shrink-0 items-center gap-0.5 pr-[0.375rem] opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {hover ??
          (stale ? (
            <button
              type="button"
              onClick={actions.onPrune}
              className={cn(HOVER_BUTTON, "w-auto px-1.5 text-xs")}
            >
              {t("prune")}
            </button>
          ) : (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title={tSidebar("moreOptions")}
                    aria-label={tSidebar("moreOptions")}
                    className={HOVER_BUTTON}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">{items}</DropdownMenuContent>
              </DropdownMenu>
            </>
          ))}
      </span>
      {!stale && changes ? (
        <span
          title={t("changes", { count: changes })}
          className="shrink-0 px-1 text-[0.6875rem] text-muted-foreground tabular-nums"
        >
          {changes}
        </span>
      ) : null}
      <span className="pr-[0.375rem]">
        <AgentIcons sessions={sessions} onOpen={onOpenSession} />
      </span>
    </div>
  )
})
